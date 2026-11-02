import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { AiConfig } from '../src/ai/types';

/**
 * End-to-end simulation of a game: several consecutive AI turns shared through
 * the same `exchanges` array, exactly as `store.ts` would do it. Verifies the
 * two properties that matter for money and legality:
 *   1. the stable prefix (system + all but the newest exchange) never changes,
 *      so the provider cache can hit;
 *   2. the prompt never grows past the configured budget.
 */
const h = vi.hoisted(() => ({
  sent: [] as Array<{
    system: string;
    messages: Array<{ role: string; content: string; cache?: boolean }>;
    input: number;
  }>,
  /** Rough size the fake provider reports for each request. */
  reported: 0,
  /** The board the current turn is asked about, set by `playTurn`. */
  board: null as Chess | null,
}));

vi.mock('../src/ai/client', () => ({
  runAttempt: async (opts: {
    system: string;
    messages: Array<{ role: string; content: string; cache?: boolean }>;
  }) => {
    h.sent.push({ system: opts.system, messages: opts.messages, input: h.reported });
    // Always answer with a legal move for the current position, so the
    // simulation can keep playing turn after turn without a real model.
    const move = h.board!.moves({ verbose: true })[0];
    return {
      status: 200,
      aborted: false,
      error: null,
      usage: null,
      text: JSON.stringify({
        move_uci: `${move.from}${move.to}${move.promotion ?? ''}`,
        move_san: move.san,
      }),
      reasoning: '',
    };
  },
}));

const { requestAiMove } = await import('../src/ai/coordinator');
const { appendExchange, estimateExchangeTokens, estimateTokens } = await import('../src/ai/context');
import type { Exchange } from '../src/ai/context';

function cfg(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    protocol: 'anthropic',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'claude-sonnet-4-6',
    extraHeaders: '',
    stream: true,
    reasoning: true,
    effort: 'high',
    effortCustom: '',
    thinkingMode: 'auto',
    context: 'continuous',
    contextBudget: 64_000,
    maxTokens: 4096,
    timeoutSecs: 120,
    retries: 3,
    insecureTls: false,
    ...overrides,
  };
}

const cb = {
  onAttemptStart: () => {},
  onReasoning: () => {},
  onText: () => {},
  onAttemptEnd: () => {},
  onNotice: () => {},
};

/** One AI turn against a real chess position, always as White. */
async function playTurn(exchanges: Exchange[], chess: Chess, budget = 64_000): Promise<Exchange> {
  h.board = chess;
  const history = chess.history();
  const outcome = await requestAiMove(
    {
      cfg: cfg({ contextBudget: budget }),
      side: 'w',
      chess,
      history,
      edited: false,
      commentary: false,
      lang: 'zh',
      opponent: 'human',
      exchanges,
      signal: new AbortController().signal,
    },
    cb,
  );
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.exchange;
}

beforeEach(() => {
  h.sent.length = 0;
  h.reported = 0;
});

describe('multi-turn continuous context', () => {
  it('rejects a budget smaller than the fixed prompt before sending HTTP', async () => {
    await expect(playTurn([], new Chess(), 100)).rejects.toThrow('超过上下文预算');
    expect(h.sent).toEqual([]);
  });
  it('keeps a byte-identical prefix across consecutive turns', async () => {
    const chess = new Chess();
    let exchanges: Exchange[] = [];

    // The AI plays White on every one of its turns; the opponent's replies are
    // played directly on the engine, exactly like a human would move.
    for (let turn = 0; turn < 3; turn += 1) {
      const exchange = await playTurn(exchanges, chess);
      exchanges = appendExchange(exchanges, exchange);
      // Reply with Black's first legal move.
      const reply = chess.moves({ verbose: true })[0];
      chess.move({ from: reply.from, to: reply.to, promotion: reply.promotion });
    }

    // Every request shares the same system prompt.
    expect(new Set(h.sent.map((s) => s.system)).size).toBe(1);

    // Each request contains the previous request's whole message list as its
    // prefix, so the provider cache can read everything up to the last reply.
    const r2 = h.sent[1].messages;
    const r3 = h.sent[2].messages;
    expect(r3.slice(0, r2.length)).toEqual(r2.map(({ role, content }) => ({ role, content })));
  });

  it('moves the cache breakpoint forward without rewriting earlier ones', async () => {
    const chess = new Chess();
    let exchanges: Exchange[] = [];

    const first = await playTurn(exchanges, chess);
    exchanges = appendExchange(exchanges, first);
    chess.move({ from: 'g1', to: 'f3' });

    const second = await playTurn(exchanges, chess);

    // The breakpoint sits on the newest assistant reply, never on the fresh
    // position pack, so the cached prefix only ever grows.
    const r2 = h.sent[1].messages;
    expect(r2.at(-2)?.cache).toBe(true);
    expect(r2.at(-1)?.cache).toBeUndefined();
    void second;
  });

  it('never exceeds the configured token budget', async () => {
    const chess = new Chess();
    // The fixed position fits, but a previous full position pack does not.
    const budget = 1_900;
    let exchanges: Exchange[] = [];

    const first = await playTurn(exchanges, chess, budget);
    exchanges = appendExchange(exchanges, first, budget);
    chess.move({ from: 'g1', to: 'f3' });

    const second = await playTurn(exchanges, chess, budget);
    exchanges = appendExchange(exchanges, second, budget);

    for (const request of h.sent) {
      // System prompt + every message that was actually sent.
      const sent = estimateTokens(request.system) + request.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
      expect(sent).toBeLessThanOrEqual(budget);
    }
    // History must actually have been trimmed, not left to grow forever.
    expect(exchanges.length).toBeLessThan(3);
  });

  it('records each exchange size without double-counting the shared prefix', async () => {
    const chess = new Chess();
    const exchange = await playTurn([], chess);
    const size = estimateExchangeTokens(exchange);
    const ownChars = exchange.messages.reduce((n, m) => n + m.content.length, 0);
    // The stored size describes this exchange alone, not the whole request.
    expect(size).toBe(Math.ceil(ownChars / 2.5));
  });
});
