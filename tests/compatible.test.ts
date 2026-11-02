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
