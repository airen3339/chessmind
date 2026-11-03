import { describe, expect, it } from 'vitest';
import type { ChatMessage, EmitHandlers } from '../src/ai/types';
import { anthropic } from '../src/ai/providers/anthropic';
import { gemini } from '../src/ai/providers/gemini';
import { openaiChat } from '../src/ai/providers/openaiChat';
import { openaiResponses } from '../src/ai/providers/openaiResponses';
import { parseExtraHeaders, SseReader, joinUrl } from '../src/ai/providers/common';
import type { AiConfig } from '../src/ai/types';

const CFG: AiConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  extraHeaders: '',
  stream: true,
  reasoning: true,
  effort: 'high',
  effortCustom: '',
  thinkingMode: 'auto',
  context: 'continuous',
  contextBudget: 64_000,
  maxTokens: 2048,
  timeoutSecs: 120,
  retries: 3,
  insecureTls: false,
};

interface Collected {
  reasoning: string;
  text: string;
  done: number;
  errors: { status: number | null; message: string }[];
  usage: Record<string, number | undefined>[];
}

function collector(): { emit: EmitHandlers; got: Collected } {
  const got: Collected = { reasoning: '', text: '', done: 0, errors: [], usage: [] };
  const emit: EmitHandlers = {
    reasoning: (chunk) => {
      got.reasoning += chunk;
    },
    text: (chunk) => {
      got.text += chunk;
    },
    usage: (usage) => {
      got.usage.push(usage as Record<string, number | undefined>);
    },
    done: () => {
      got.done += 1;
    },
    error: (status, message) => {
      got.errors.push({ status, message });
    },
  };
  return { emit, got };
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'your move?' }];

describe('SSE reader', () => {
  it('splits events across arbitrary chunk boundaries', () => {
    const seen: string[] = [];
    const reader = new SseReader((_event, data) => seen.push(data));
    reader.push('data: {"a"');
    reader.push(':1}\n\ndata: {"b":2}\n');
    reader.push('\n');
    reader.end();
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles CRLF line endings', () => {
    const seen: string[] = [];
    const reader = new SseReader((_event, data) => seen.push(data));
    reader.push('event: ping\r\ndata: hi\r\n\r\n');
    expect(seen).toEqual(['hi']);
  });

  it('handles a CRLF pair split across two chunks', () => {
    const seen: string[] = [];
    const reader = new SseReader((_event, data) => seen.push(data));
    reader.push('data: one\r');
    reader.push('\ndata: two\r\n\r');
    reader.push('\n');
    expect(seen).toEqual(['one\ntwo']);
  });

  it('joins multi-line data payloads', () => {
    const seen: string[] = [];
    const reader = new SseReader((_event, data) => seen.push(data));
    reader.push('data: line1\ndata: line2\n\n');
    expect(seen).toEqual(['line1\nline2']);
  });
});

describe('openai chat completions', () => {
  it('builds the documented request shape', () => {
    const request = openaiChat.buildRequest(CFG, 'sys', MESSAGES, true);
    expect(request.url).toBe('https://api.example.com/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(request.body);
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.max_tokens).toBe(2048);
  });

  it('switches to max_completion_tokens for reasoning models', () => {
    const request = openaiChat.buildRequest({ ...CFG, model: 'o3-mini' }, 'sys', MESSAGES, false);
    const body = JSON.parse(request.body);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('high');
  });

  it.each(['gpt-5', 'gpt5', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-7'])('preserves the max effort and output cap for %s', (model) => {
    const request = openaiChat.buildRequest({ ...CFG, model, effort: 'max', maxTokens: 8192 }, 'sys', MESSAGES, true);
    const body = JSON.parse(request.body);
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
    expect(body.reasoning_effort).toBe('max');
  });

  it('omits reasoning_effort for models that predate it', () => {
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
      const body = JSON.parse(
        openaiChat.buildRequest({ ...CFG, model, reasoning: true }, 'sys', MESSAGES, false).body,
      );
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.max_tokens).toBe(2048);
    }
  });

  it('parses reasoning_content, content and usage from the stream', () => {
    const { emit, got } = collector();
    const decoder = openaiChat.createDecoder(CFG, emit);
    decoder.push(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"{\\"move_uci\\":\\"e2e4\\"}"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\n' +
        'data: [DONE]\n\n',
    );
    decoder.end();
    expect(got.reasoning).toBe('thinking...');
    expect(got.text).toContain('e2e4');
    expect(got.done).toBe(1);
    expect(got.usage.at(-1)).toMatchObject({ input: 10, output: 20 });
  });

  it('keeps reading a usage-only chunk after finish_reason', () => {
    // With stream_options.include_usage the usage arrives in a separate final
    // chunk whose choices array is empty. It used to be dropped.
    const { emit, got } = collector();
    const decoder = openaiChat.createDecoder(CFG, emit);
    decoder.push(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"completion_tokens_details":{"reasoning_tokens":7}}}\n\n' +
        'data: [DONE]\n\n',
    );
    decoder.end();
    expect(got.text).toBe('ok');
    expect(got.usage.at(-1)).toMatchObject({ input: 11, output: 22, reasoning: 7 });
  });

  it('surfaces an error payload', () => {
    const { emit, got } = collector();
    const decoder = openaiChat.createDecoder(CFG, emit);
    decoder.push('data: {"error":{"message":"bad key"}}\n\n');
    decoder.end();
    expect(got.errors[0].message).toBe('bad key');
  });

  it('parses a non-streamed response', () => {
    const { emit, got } = collector();
    openaiChat.parseFull(
      { choices: [{ message: { content: '{"move_uci":"e2e4"}' } }], usage: { prompt_tokens: 5 } },
      emit,
    );
    expect(got.text).toContain('e2e4');
    expect(got.done).toBe(1);
  });
});

describe('openai responses', () => {
  it('builds the documented request shape', () => {
    const request = openaiResponses.buildRequest(
      { ...CFG, protocol: 'openai-responses', model: 'gpt-5' },
      'sys',
      MESSAGES,
      true,
    );
    expect(request.url).toBe('https://api.example.com/v1/responses');
    const body = JSON.parse(request.body);
    expect(body.instructions).toBe('sys');
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.reasoning.effort).toBe('high');
    expect(body.input[0].role).toBe('user');
  });

  it('parses reasoning summary and output text deltas', () => {
    const { emit, got } = collector();
    const decoder = openaiResponses.createDecoder(CFG, emit);
    decoder.push(
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"plan"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"e2e4"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":9}}}\n\n',
    );
    decoder.end();
    expect(got.reasoning).toBe('plan');
    expect(got.text).toBe('e2e4');
    expect(got.done).toBe(1);
    expect(got.usage.at(-1)).toMatchObject({ input: 7, output: 9 });
  });

  it('reports response.failed', () => {
    const { emit, got } = collector();
    const decoder = openaiResponses.createDecoder(CFG, emit);
    decoder.push('data: {"type":"response.failed","response":{"error":{"message":"quota"}}}\n\n');
    decoder.end();
    expect(got.errors[0].message).toBe('quota');
  });
});

describe('anthropic messages', () => {
  it('sends the required headers and max_tokens', () => {
    const request = anthropic.buildRequest(
      { ...CFG, protocol: 'anthropic', model: 'claude-sonnet-4-5' },
      'sys',
      MESSAGES,
      true,
    );
    expect(request.url).toBe('https://api.example.com/v1/messages');
    expect(request.headers['x-api-key']).toBe('sk-test');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(request.body);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(body.thinking.type).toBe('enabled');
  });

  it('adds cache_control breakpoints when a message is flagged cacheable', () => {
    const request = anthropic.buildRequest(
      { ...CFG, protocol: 'anthropic', model: 'claude-sonnet-4-5', reasoning: false },
      'sys',
      [
        { role: 'user', content: 'turn-0' },
        { role: 'assistant', content: 'reply-0', cache: true },
        { role: 'user', content: 'turn-1' },
      ],
      true,
    );
    const body = JSON.parse(request.body);
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content).toBe('turn-0');
    expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[2].content).toBe('turn-1');
  });

  it('reads input and cache tokens from message_start, not message_delta', () => {
    const { emit, got } = collector();
    const decoder = anthropic.createDecoder(CFG, emit);
    decoder.push(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1,"cache_read_input_tokens":3400,"cache_creation_input_tokens":600}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":77}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    decoder.end();
    // message_start carries the whole prompt; message_delta contributes output only.
    expect(got.usage[0]).toEqual({
      input: 4120,
      output: 1,
      cachedInput: 3400,
      cacheWrite: 600,
    });
    expect(got.usage[1]).toEqual({ output: 77 });
  });

  it('parses thinking_delta and text_delta', () => {
    const { emit, got } = collector();
    const decoder = anthropic.createDecoder(CFG, emit);
    decoder.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"e2e4"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    decoder.end();
    expect(got.reasoning).toBe('hmm');
    expect(got.text).toBe('e2e4');
    expect(got.done).toBe(1);
  });

  it('reports cached input tokens as part of the total prompt size', () => {
    const { emit, got } = collector();
    anthropic.parseFull(
      {
        content: [{ type: 'text', text: 'e4' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 500,
        },
      },
      emit,
    );
    expect(got.usage.at(-1)).toEqual({ input: 3600, output: 20, cachedInput: 3000, cacheWrite: 500 });
  });

  it('parses a full non-streamed message', () => {
    const { emit, got } = collector();
    anthropic.parseFull(
      {
        content: [
          { type: 'thinking', thinking: 'deep' },
          { type: 'text', text: 'Nf3' },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
      emit,
    );
    expect(got.reasoning).toBe('deep');
    expect(got.text).toBe('Nf3');
  });
});

describe('gemini', () => {
  it('builds the model-scoped streaming URL', () => {
    const request = gemini.buildRequest(
      { ...CFG, protocol: 'gemini', model: 'gemini-2.5-pro' },
      'sys',
      MESSAGES,
      true,
    );
    expect(request.url).toBe(
      'https://api.example.com/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(request.headers['x-goog-api-key']).toBe('sk-test');
    const body = JSON.parse(request.body);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  it('separates thought parts from answer parts', () => {
    const { emit, got } = collector();
    const decoder = gemini.createDecoder(CFG, emit);
    decoder.push(
      'data: {"candidates":[{"content":{"parts":[{"text":"pondering","thought":true}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"e2e4"}]},"finishReason":"STOP"}]}\n\n',
    );
    decoder.end();
    expect(got.reasoning).toBe('pondering');
    expect(got.text).toBe('e2e4');
    expect(got.done).toBe(1);
  });

  it('strips a models/ prefix so it is not doubled in the URL', () => {
    const request = gemini.buildRequest(
      { ...CFG, protocol: 'gemini', model: 'models/gemini-2.5-pro' },
      'sys',
      MESSAGES,
      true,
    );
    expect(request.url).toBe(
      'https://api.example.com/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
  });

  it('keeps maxOutputTokens above the Gemini 2.5 thinking budget', () => {
    const body = JSON.parse(
      gemini.buildRequest(
        { ...CFG, protocol: 'gemini', model: 'gemini-2.5-pro', effort: 'max', maxTokens: 4096 },
        'sys',
        MESSAGES,
        true,
      ).body,
    );
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(32768);
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(32768);
  });
});

describe('request helpers', () => {
  it('joins base urls without doubling slashes', () => {
    expect(joinUrl('https://x/v1/', '/chat/completions')).toBe('https://x/v1/chat/completions');
    expect(joinUrl('https://x/v1', 'chat/completions')).toBe('https://x/v1/chat/completions');
  });

  it('parses extra headers and ignores junk', () => {
    expect(parseExtraHeaders('{"HTTP-Referer":"a","n":2}')).toEqual({
      'HTTP-Referer': 'a',
      n: '2',
    });
    expect(parseExtraHeaders('not json')).toEqual({});
    expect(parseExtraHeaders('')).toEqual({});
  });
});
