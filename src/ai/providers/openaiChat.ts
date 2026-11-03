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

const REASONING_MODEL = /^(o1|o3|o4|gpt-?[5-9](?:[.-]|$)|codex|computer-use)/i;
/** OpenAI families that predate `reasoning_effort` and reject the field. */
const NON_REASONING_MODEL = /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-|gpt-4$|gpt-3\.5|chatgpt)/i;
const LENGTH_ERROR = '模型输出达到 token 上限，尚未完成最终回答（finish_reason=length）。请提高最大输出 tokens 后重试。';

function usesCompletionTokens(model: string): boolean {
  return REASONING_MODEL.test(model.trim());
}

function readDelta(delta: Record<string, unknown>, emit: EmitHandlers): void {
  const reasoning =
    asString(delta.reasoning_content) ?? asString(delta.reasoning) ?? asString(delta.thinking);
  if (reasoning) emit.reasoning(reasoning);
  const content = asString(delta.content);
  if (content) emit.text(content);
  const toolCalls = asArray(delta.tool_calls);
  if (toolCalls.length > 0) {
    // Some gateways stream tool-call deltas; they are not chess moves, so ignore them.
  }
}

function readUsage(payload: Record<string, unknown>, emit: EmitHandlers): void {
  const usage = asRecord(payload.usage);
  if (!usage) return;
  const details = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);
  emit.usage({
    input: asNumber(usage.prompt_tokens),
    output: asNumber(usage.completion_tokens),
    reasoning: asNumber(asRecord(usage.completion_tokens_details)?.reasoning_tokens),
    cachedInput: asNumber(details?.cached_tokens),
    cacheWrite: asNumber(details?.cache_write_tokens),
  });
}

function readMessage(message: Record<string, unknown>, emit: EmitHandlers): void {
  const reasoning =
    asString(message.reasoning_content) ?? asString(message.reasoning) ?? asString(message.thinking);
  if (reasoning) emit.reasoning(reasoning);
  const content = asString(message.content);
  if (content) emit.text(content);
  const parts = asArray(message.content);
  for (const part of parts) {
    const record = asRecord(part);
    const text = record ? asString(record.text) : undefined;
    if (text) emit.text(text);
  }
}

export const openaiChat: Provider = {
  id: 'openai-chat',
  label: 'OpenAI Chat Completions',
  hint: 'POST {base}/chat/completions · 兼容 DeepSeek、OpenRouter、Groq、vLLM、Ollama、LM Studio 等',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5',

  buildRequest(
    cfg,
    system: string,
    messages: ChatMessage[],
    stream: boolean,
  ): StreamRequest {
    const body: Record<string, unknown> = {
      model: cfg.model,
      // Map explicitly: our internal `cache` flag is an Anthropic-only hint and
      // must never leak into the OpenAI wire format.
      messages: [
        { role: 'system', content: system },
        ...messages.map((message) => ({ role: message.role, content: message.content })),
      ],
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (usesCompletionTokens(cfg.model)) {
      body.max_completion_tokens = cfg.maxTokens;
    } else {
      body.max_tokens = cfg.maxTokens;
    }
    if (cfg.reasoning && !NON_REASONING_MODEL.test(cfg.model.trim())) {
      // OpenAI accepts `none|minimal|low|medium|high|xhigh|max` depending on
      // the model; a custom value is forwarded verbatim. Known pre-reasoning
      // models are skipped so the request does not 400 on every turn.
      body.reasoning_effort = resolveEffortText(cfg.effort, cfg.effortCustom);
    }
    return {
      url: joinUrl(cfg.baseUrl, '/chat/completions'),
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

  createDecoder(_cfg, emit: EmitHandlers): Decoder {
    let finished = false;
    /** A finish_reason closes the content stream, but a trailing usage-only
     *  chunk (choices: []) may still follow, so keep reading until [DONE]. */
    let contentDone = false;
    let doneEmitted = false;
    const emitDone = () => {
      if (doneEmitted) return;
      doneEmitted = true;
      emit.done();
    };
    const reader = new SseReader((_event, data) => {
      if (finished) return;
      if (data.trim() === '[DONE]') {
        finished = true;
        emitDone();
        return;
      }
      const payload = asRecord(tryParseJson(data));
      if (!payload) return;
      if (payload.error) {
        const error = asRecord(payload.error);
        finished = true;
        emit.error(null, asString(error?.message) ?? JSON.stringify(payload.error));
        return;
      }
      readUsage(payload, emit);
      if (contentDone) return;
      const choice = asRecord(asArray(payload.choices)[0]);
      if (!choice) return;
      const delta = asRecord(choice.delta);
      if (delta) readDelta(delta, emit);
      const finish = asString(choice.finish_reason);
      if (finish) {
        contentDone = true;
        if (finish === 'length') {
          emit.error(null, LENGTH_ERROR, 'incomplete');
        }
        emitDone();
      }
    });
    return {
      push: (chunk) => reader.push(chunk),
      end: () => {
        reader.end();
        if (!finished) {
          finished = true;
          if (!contentDone) {
            emit.error(null, '响应流提前结束，未收到完成标记；模型尚未给出完整的最终回答。', 'incomplete');
          }
          emitDone();
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
    const choice = asRecord(asArray(record.choices)[0]);
    if (choice?.finish_reason === 'length') {
      emit.error(null, LENGTH_ERROR, 'incomplete');
      return;
    }
    const message = choice ? asRecord(choice.message) : null;
    if (message) readMessage(message, emit);
    emit.done();
  },
};
