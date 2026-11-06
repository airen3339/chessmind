import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI } from '../src/config';
import type { StreamRequest } from '../src/ai/types';
import type { StreamHandlers } from '../src/bridge/types';

const h = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('../src/bridge', () => ({ bridge: { stream: h.stream } }));
const { runCompatibleAttempt } = await import('../src/ai/compatible');
const { runAttempt } = await import('../src/ai/client');
const { requestCoach } = await import('../src/coach/request');
const { requestAiMove } = await import('../src/ai/coordinator');
const { Chess } = await import('chess.js');
const { estimateTokens } = await import('../src/ai/context');
const opts = () => ({ cfg: { ...DEFAULT_AI, stream: false }, system: 's', messages: [], signal: new AbortController().signal, cb: { onReasoning() {}, onText() {} } });
const succeed = (handlers: StreamHandlers, text = 'OK') => {
  handlers.onEvent({ kind: 'response', status: 201 });
  handlers.onEvent({ kind: 'chunk', text: JSON.stringify({ choices: [{ message: { content: text } }] }) });
  handlers.onEvent({ kind: 'end' });
};

beforeEach(() => { h.stream.mockReset(); });

describe('shared provider compatibility', () => {
  it('sends coach requests through the selected streaming Responses transport', async () => {
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      const body = JSON.parse(req.body);
      expect(req.url).toBe(DEFAULT_AI.baseUrl + '/responses');
      expect(body.stream).toBe(true);
      expect(body.reasoning.effort).toBe('xhigh');
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'chunk', text: 'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '{"move_review":"好"}' }) + '\n\n'
        + 'data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n\n' });
      handlers.onEvent({ kind: 'end' });
    });
    const reply = await requestCoach({ cfg: { ...DEFAULT_AI, protocol: 'openai-responses', model: 'coach-stream-test', effort: 'xhigh', stream: true },
      system: 's', user: 'u', signal: new AbortController().signal });
    expect(reply.ok).toBe(true);
    expect(reply.text).toBe('{"move_review":"好"}');
    expect(reply.usage).toMatchObject({ input: 10, output: 20 });
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('does not silently force streaming when the coach profile selects non-streaming', async () => {
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      expect(JSON.parse(req.body).stream).toBe(false);
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'chunk', text: JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '好' }] }] }) });
      handlers.onEvent({ kind: 'end' });
    });
    const reply = await requestCoach({ cfg: { ...DEFAULT_AI, protocol: 'openai-responses', model: 'coach-full-test', stream: false },
      system: 's', user: 'u', signal: new AbortController().signal });
    expect(reply.ok).toBe(true);
  });

  it('removes only an explicitly unsupported Responses limit and remembers it for the same transport', async () => {
    const sent: Record<string, unknown>[] = [];
    const notices: string[] = [];
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      const body = JSON.parse(req.body);
      sent.push(body);
      if (body.max_output_tokens !== undefined) {
        handlers.onEvent({ kind: 'error', status: 400, message: JSON.stringify({ error: {
          code: 'unsupported_parameter', param: '', type: 'invalid_request_error',
          message: '暂不支持：max_output_tokens（上游硬限制尚未验证）[BPS 0.3.16]',
        } }) });
      } else {
        handlers.onEvent({ kind: 'response', status: 200 });
        handlers.onEvent({ kind: 'chunk', text: JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '好' }] }] }) });
        handlers.onEvent({ kind: 'end' });
      }
    });
    const config = { ...DEFAULT_AI, protocol: 'openai-responses' as const, model: 'unsupported-limit-test', stream: false, effort: 'xhigh' as const, maxTokens: 640000 };
    const result = await runCompatibleAttempt({ ...opts(), cfg: config, onNotice: (s) => notices.push(s) });
    expect(result.error).toBeNull();
    expect(sent).toHaveLength(2);
    expect(sent[0].max_output_tokens).toBe(640000);
    expect(sent[1]).not.toHaveProperty('max_output_tokens');
    expect(sent.every(body => (body.reasoning as { effort: string }).effort === 'xhigh')).toBe(true);
    expect(sent[1].input).toEqual(sent[0].input);
    expect(config.maxTokens).toBe(640000);
    expect(result.notices?.join()).toContain('服务商默认上限');
    expect(notices.join()).toContain('不改变思考强度');
    const coach = await requestCoach({ cfg: config, system: 's', user: 'u', signal: new AbortController().signal });
    expect(coach.ok).toBe(true);
    expect(coach.notices?.join()).toContain('服务商默认上限');
    expect(sent).toHaveLength(3);
    expect(sent[2]).not.toHaveProperty('max_output_tokens');

    sent.length = 0;
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      sent.push(JSON.parse(req.body));
      handlers.onEvent({ kind: 'error', status: 401, message: 'Unauthorized' });
    });
    await runCompatibleAttempt({ ...opts(), cfg: { ...config, stream: true } });
    expect(sent[0].max_output_tokens).toBe(640000);
    await runCompatibleAttempt({ ...opts(), cfg: { ...config, baseUrl: 'https://other.example.com/v1' } });
    expect(sent[1].max_output_tokens).toBe(640000);
  });

  it('only retries the omission once if the gateway continues to reject it', async () => {
    h.stream.mockImplementation(async (_req: StreamRequest, handlers: StreamHandlers) => {
      handlers.onEvent({ kind: 'error', status: 400, message: "Unsupported parameter: 'max_output_tokens'" });
    });
    const result = await runCompatibleAttempt({ ...opts(), cfg: { ...DEFAULT_AI, protocol: 'openai-responses', model: 'still-unsupported-limit', stream: false, maxTokens: 4096, effort: 'max' } });
    expect(result.error).toContain('Unsupported parameter');
    expect(h.stream).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 400, error: { code: 'invalid_value', param: 'max_output_tokens', message: 'max_output_tokens exceeds the allowed range' } },
    { status: 400, error: { code: 'unsupported_parameter', param: 'temperature', message: 'temperature is unsupported; max_output_tokens is valid' } },
    { status: 503, error: { code: 'model_not_found', message: 'No available channel for model' } },
    { status: 401, error: { code: 'invalid_api_key', message: 'Invalid credential' } },
  ])('does not omit the cap for a different failure: $error.code', async ({ status, error }) => {
    const bodies: Record<string, unknown>[] = [];
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      bodies.push(JSON.parse(req.body));
      handlers.onEvent({ kind: 'error', status, message: JSON.stringify({ error }) });
    });
    await runCompatibleAttempt({ ...opts(), cfg: { ...DEFAULT_AI, protocol: 'openai-responses', model: 'unrelated-' + error.code, stream: false, maxTokens: 640000, effort: 'xhigh' } });
    expect(bodies.every(body => body.max_output_tokens === 640000)).toBe(true);
    expect(bodies.every(body => (body.reasoning as { effort: string }).effort === 'xhigh')).toBe(true);
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('describes a successful HTTP response with an empty non-streaming body', async () => {
    h.stream.mockImplementation(async (_req: StreamRequest, handlers: StreamHandlers) => {
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'end' });
    });
    const result = await runAttempt(opts());
    expect(result.error).toContain('空的非流式响应（HTTP 200）');
  });

  it('does not repeat an incomplete streaming coach response', async () => {
    h.stream.mockImplementation(async (_req: StreamRequest, handlers: StreamHandlers) => {
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'chunk', text: 'data: ' + JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }) + '\n\n' });
      handlers.onEvent({ kind: 'end' });
    });
    const reply = await requestCoach({ cfg: { ...DEFAULT_AI, protocol: 'openai-responses', model: 'incomplete-coach', stream: true },
      system: 's', user: 'u', signal: new AbortController().signal });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('max_output_tokens');
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('reuses learned reasoning support for coaching and connection tests', async () => {
    const sent: boolean[] = [];
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      const body = JSON.parse(req.body);
      sent.push(Boolean(body.reasoning_effort));
      if (body.reasoning_effort) handlers.onEvent({ kind: 'error', status: 400, message: 'unsupported reasoning_effort' });
      else succeed(handlers);
    });
    const config = { ...DEFAULT_AI, model: 'shared-capability-test', stream: false };
    expect((await runCompatibleAttempt({ ...opts(), cfg: config })).text).toBe('OK');
    expect((await requestCoach({ cfg: config, system: 's', user: 'u', signal: new AbortController().signal })).ok).toBe(true);
    expect((await runCompatibleAttempt({ ...opts(), cfg: config })).error).toBeNull();
    expect(sent).toEqual([true, false, false, false]);
  });

  it('preserves successful HTTP metadata in both streaming modes', async () => {
    h.stream.mockImplementation(async (_req: StreamRequest, handlers: StreamHandlers) => succeed(handlers));
    expect((await runAttempt(opts())).status).toBe(201);
    h.stream.mockImplementation(async (_req: StreamRequest, handlers: StreamHandlers) => {
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'chunk', text: 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + String.fromCharCode(10, 10) });
      handlers.onEvent({ kind: 'end' });
    });
    expect((await runAttempt({ ...opts(), cfg: { ...DEFAULT_AI, stream: true } })).status).toBe(200);
  });

  it('does not parse cancelled non-streaming responses as malformed JSON', async () => {
    const controller = new AbortController();
    h.stream.mockImplementation(async () => { controller.abort(); });
    const result = await runAttempt({ ...opts(), signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.error).toBeNull();
  });

  it('keeps every illegal-move retry within the input budget', async () => {
    const sizes: number[] = [];
    let calls = 0;
    h.stream.mockImplementation(async (req: StreamRequest, handlers: StreamHandlers) => {
      const body = JSON.parse(req.body);
      sizes.push(body.messages.reduce((n: number, m: { content: string }) => n + estimateTokens(m.content), 0));
      calls++;
      succeed(handlers, calls === 1 ? 'invalid answer '.repeat(3000) : JSON.stringify({ move_uci: 'e2e4' }));
    });
    const outcome = await requestAiMove({ cfg: { ...DEFAULT_AI, stream: false, reasoning: false, contextBudget: 1900 }, side: 'w', chess: new Chess(), history: [], edited: false, commentary: false, lang: 'zh', opponent: 'human', exchanges: [], signal: new AbortController().signal }, { onAttemptStart() {}, onReasoning() {}, onText() {}, onAttemptEnd() {}, onNotice() {} });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
    expect(sizes.every((size) => size <= 1900)).toBe(true);
  });
});
