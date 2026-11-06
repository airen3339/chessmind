import type { ChatMessage, Decoder, EmitHandlers, Provider, StreamRequest } from '../types';
import { resolveEffortText } from '../effort';
import {
  SseReader,
  asArray,
  asNumber,
  asRecord,
  asString,
  joinUrl,
  parseExtraHeaders,
  tryParseJson,
} from './common';

function toInput(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: [
      {
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: message.content,
      },
    ],
  }));
}

function readUsage(record: Record<string, unknown>, emit: EmitHandlers): void {
  const usage = asRecord(record.usage);
  if (!usage) return;
  const details = asRecord(usage.input_tokens_details);
  emit.usage({
    input: asNumber(usage.input_tokens),
    output: asNumber(usage.output_tokens),
    reasoning: asNumber(asRecord(usage.output_tokens_details)?.reasoning_tokens),
    cachedInput: asNumber(details?.cached_tokens),
    cacheWrite: asNumber(details?.cache_write_tokens),
  });
}

function readOutputItems(items: unknown[], emit: EmitHandlers): void {
  for (const item of items) {
    const record = asRecord(item);
    if (!record) continue;
    const type = asString(record.type);
    if (type === 'message') {
      for (const part of asArray(record.content)) {
        const content = asRecord(part);
        const text = content ? asString(content.text) : undefined;
        if (text) emit.text(text);
      }
    } else if (type === 'reasoning') {
      for (const part of asArray(record.summary)) {
        const summary = asRecord(part);
        const text = summary ? asString(summary.text) : undefined;
        if (text) emit.reasoning(text);
      }
      const content = asString(record.content);
      if (content) emit.reasoning(content);
    }
  }
}

export const openaiResponses: Provider = {
  id: 'openai-responses',
  label: 'OpenAI Responses',
  hint: 'POST {base}/responses · gpt-5 / o 系列，支持 reasoning summary 流式返回',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5',

  buildRequest(cfg, system, messages, stream, options): StreamRequest {
    const body: Record<string, unknown> = {
      model: cfg.model,
      instructions: system,
      input: toInput(messages),
      stream,
      // Chess positions are self-contained; there is no reason to let the
      // provider retain the conversation server-side.
      store: false,
    };
    if (!options?.omitMaxOutputTokens) body.max_output_tokens = cfg.maxTokens;
    if (cfg.reasoning) {
      body.reasoning = { effort: resolveEffortText(cfg.effort, cfg.effortCustom), summary: 'auto' };
    }
    return {
      url: joinUrl(cfg.baseUrl, '/responses'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        ...parseExtraHeaders(cfg.extraHeaders),
      },
      body: JSON.stringify(body),
      timeout_secs: cfg.timeoutSecs,
      insecure_tls: cfg.insecureTls,
    };
  },

  createDecoder(_cfg, emit): Decoder {
    let finished = false;
    const reader = new SseReader((event, data) => {
      if (finished) return;
      const payload = asRecord(tryParseJson(data));
      if (!payload) return;
      const type = asString(payload.type) ?? event;
      switch (type) {
        case 'response.output_text.delta': {
          const delta = asString(payload.delta);
          if (delta) emit.text(delta);
          break;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const delta = asString(payload.delta);
          if (delta) emit.reasoning(delta);
          break;
        }
        case 'response.completed': {
          const response = asRecord(payload.response) ?? payload;
          readUsage(response, emit);
          finished = true;
          emit.done();
          break;
        }
        case 'response.incomplete': {
          const response = asRecord(payload.response) ?? payload;
          readUsage(response, emit);
          const details = asRecord(response.incomplete_details);
          finished = true;
          emit.error(null, `响应被截断（${asString(details?.reason) ?? 'incomplete'}）`, 'incomplete');
          break;
        }
        case 'response.failed': {
          const response = asRecord(payload.response) ?? payload;
          const error = asRecord(response.error);
          finished = true;
          emit.error(null, asString(error?.message) ?? 'response.failed');
          break;
        }
        case 'error': {
          const error = asRecord(payload.error) ?? payload;
          finished = true;
          emit.error(null, asString(error.message) ?? JSON.stringify(error));
          break;
        }
        default:
          break;
      }
    });
    return {
      push: (chunk) => reader.push(chunk),
      end: () => {
        reader.end();
        if (!finished) {
          finished = true;
          emit.error(null, '响应流提前结束，未收到 response.completed。', 'incomplete');
        }
      },
    };
  },

  parseFull(payload, emit) {
    const record = asRecord(payload);
    if (!record) {
      emit.error(null, '无法解析响应');
      return;
    }
    if (record.error) {
      const error = asRecord(record.error);
      emit.error(null, asString(error?.message) ?? JSON.stringify(record.error));
      return;
    }
    readUsage(record, emit);
    if (record.status === 'incomplete') {
      const details = asRecord(record.incomplete_details);
      emit.error(null, `响应被截断（${asString(details?.reason) ?? 'incomplete'}）`, 'incomplete');
      return;
    }
    if (record.status && record.status !== 'completed') {
      emit.error(null, `响应尚未完成（${String(record.status)}）`);
      return;
    }
    readOutputItems(asArray(record.output), emit);
    emit.done();
  },
};
