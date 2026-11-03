import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { DEFAULT_AI } from '../src/config';
import type { StreamRequest } from '../src/ai/types';
import type { StreamHandlers } from '../src/bridge/types';

const h = vi.hoisted(() => ({ response: '', error: '', requests: [] as StreamRequest[] }));
vi.mock('../src/bridge', () => ({
  bridge: {
    async stream(request: StreamRequest, handlers: StreamHandlers) {
      h.requests.push(request);
      if (h.error) {
        handlers.onEvent({ kind: 'error', status: null, message: h.error });
        return;
      }
      handlers.onEvent({ kind: 'response', status: 200 });
      handlers.onEvent({ kind: 'chunk', text: h.response });
      handlers.onEvent({ kind: 'end' });
    },
  },
}));

const { requestAiMove } = await import('../src/ai/coordinator');
const cb = { onAttemptStart() {}, onReasoning() {}, onText() {}, onAttemptEnd() {}, onNotice() {} };

function turn(protocol: 'openai-chat' | 'openai-responses', stream: boolean) {
  return requestAiMove({
    cfg: { ...DEFAULT_AI, protocol, stream, model: 'gpt-6.1-sol', effort: 'max', maxTokens: 8192, retries: 3 },
    side: 'w', chess: new Chess(), history: [], edited: false,
    commentary: false, lang: 'zh', opponent: 'human', exchanges: [], signal: new AbortController().signal,
  }, cb);
}

beforeEach(() => { h.response = ''; h.error = ''; h.requests.length = 0; });

describe('unfinished reasoning is never played or repeatedly regenerated', () => {
  it.each(['error sending request: operation timed out', '请求超时（180s）', 'read ETIMEDOUT'])('does not restart a timed-out max request: %s', async (message) => {
    h.error = message;
    const result = await turn('openai-chat', true);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });

  it.each([true, false])('rejects Chat Completions token exhaustion, stream=%s', async (stream) => {
    const message = { reasoning_content: 'Considering Nf3, e4 and d4.', content: '{"move_uci":"e2e4"}' };
    h.response = stream
      ? `data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ choices: [{ message, finish_reason: 'length' }] });
    const result = await turn('openai-chat', stream);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('finish_reason=length');
    expect(result.error).not.toContain('多个合法着法');
    expect(result.attempts).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(h.requests[0].body)).toMatchObject({
      reasoning_effort: 'max', max_completion_tokens: 8192,
    });
  });

  it.each([true, false])('does not repeat incomplete Responses requests, stream=%s', async (stream) => {
    const response = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] };
    h.response = stream
      ? `data: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`
      : JSON.stringify(response);
    const result = await turn('openai-responses', stream);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('max_output_tokens');
    expect(result.attempts).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
  });

  it.each(['openai-chat', 'openai-responses'] as const)('rejects an early EOF without a completion marker: %s', async (protocol) => {
    h.response = protocol === 'openai-chat'
      ? 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'Consider Nf3 and d4.' } }] }) + '\n\n'
      : 'data: ' + JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'Consider Nf3 and d4.' }) + '\n\n';
    const result = await turn(protocol, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('提前结束');
    expect(result.error).not.toContain('多个合法着法');
    expect(h.requests).toHaveLength(1);
  });

  it.each([true, false])('does not scan reasoning-only prose as a final move, stream=%s', async (stream) => {
    const message = { reasoning_content: 'I considered Nf3, then d4; perhaps e4.' };
    h.response = stream
      ? 'data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'
      : JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] });
    const result = await turn('openai-chat', stream);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('没有返回最终回答');
    expect(h.requests).toHaveLength(1);
  });

  it('still supports a gateway returning its entire final JSON in the reasoning channel', async () => {
    h.response = 'data: ' + JSON.stringify({ choices: [{
      delta: { reasoning_content: '{"move_uci":"e2e4"}' }, finish_reason: 'stop',
    }] }) + '\n\ndata: [DONE]\n\n';
    const result = await turn('openai-chat', true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.move.san).toBe('e4');
    expect(h.requests).toHaveLength(1);
  });

  it('accepts a completed decision while preserving analysis of multiple candidates', async () => {
    h.response = 'data: ' + JSON.stringify({ choices: [{
      delta: { reasoning_content: 'Compare Nf3, d4 and e4 against the best replies.', content: '{"move_uci":"e2e4"}' },
      finish_reason: 'stop',
    }] }) + '\n\ndata: [DONE]\n\n';
    const result = await turn('openai-chat', true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.move.san).toBe('e4');
    expect(result.reasoning).toContain('Compare Nf3, d4 and e4');
    expect(result.exchange.messages[1].content).toBe('{"move_uci":"e2e4"}');
  });
});
