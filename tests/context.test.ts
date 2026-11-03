import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import {
  appendExchange,
  estimateExchangeTokens,
  estimateTokens,
  historyMessages,
  trimExchanges,
  truncateForPly,
  type Exchange,
} from '../src/ai/context';
import type { AiConfig } from '../src/ai/types';

/** Every request the coordinator sends: system prompt + full message list. */
const h = vi.hoisted(() => ({
  sent: [] as Array<{ system: string; messages: Array<{ role: string; content: string; cache?: boolean }> }>,
  /** When set, these replies are returned in order before falling back to e2e4. */
  script: [] as string[],
}));

vi.mock('../src/ai/client', () => ({
  runAttempt: async (opts: {
    system: string;
    messages: Array<{ role: string; content: string; cache?: boolean }>;
  }) => {
    h.sent.push({ system: opts.system, messages: opts.messages });
    return {
      status: 200,
      aborted: false,
      error: null,
      usage: null,
      text: h.script.shift() ?? '{"move_uci":"e2e4","move_san":"e4"}',
      reasoning: '',
    };
  },
}));

const { requestAiMove } = await import('../src/ai/coordinator');

function cfg(context: AiConfig['context']): AiConfig {
  return {
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    extraHeaders: '',
    stream: true,
    reasoning: false,
    effort: 'high',
    effortCustom: '',
    thinkingMode: 'auto',
    context,
    contextBudget: 64_000,
    maxTokens: 4096,
    timeoutSecs: 120,
    retries: 3,
    insecureTls: false,
  };
}

const cb = {
  onAttemptStart: () => {},
  onReasoning: () => {},
  onText: () => {},
  onAttemptEnd: () => {},
  onNotice: () => {},
};

function priorExchanges(): Exchange[] {
  return [
    { ply: 0, messages: [{ role: 'user', content: 'POSITION-turn-0' }, { role: 'assistant', content: '{"move_uci":"e2e4"}' }] },
    { ply: 1, messages: [{ role: 'user', content: 'POSITION-turn-1' }, { role: 'assistant', content: '{"move_uci":"e7e5"}' }] },
  ];
}

function turn(context: AiConfig['context'], exchanges: Exchange[]) {
  return requestAiMove(
    {
      cfg: cfg(context),
      side: 'w',
      chess: new Chess(),
      history: ['e4', 'e5'],
      edited: false,
      commentary: false,
      lang: 'zh',
      opponent: 'human',
      exchanges,
      signal: new AbortController().signal,
    },
    cb,
  );
}

beforeEach(() => {
  h.sent.length = 0;
  h.script.length = 0;
});

describe('continuous vs isolated context', () => {
  it('continuous mode replays prior exchanges before the current position', async () => {
    const outcome = await turn('continuous', priorExchanges());
    expect(outcome.ok).toBe(true);
    expect(h.sent).toHaveLength(1);
    const msgs = h.sent[0].messages;
    // 2 prior exchanges * 2 + current position pack = 5 messages.
    expect(msgs).toHaveLength(5);
    expect(msgs[0]).toEqual({ role: 'user', content: 'POSITION-turn-0' });
    expect(msgs[3].role).toBe('assistant');
    expect(msgs[4].role).toBe('user');
    expect(msgs[4].content).toContain('## POSITION');
  });

  it('isolated mode sends only the current position pack', async () => {
    const outcome = await turn('isolated', priorExchanges());
    expect(outcome.ok).toBe(true);
    expect(h.sent[0].messages).toHaveLength(1);
    expect(h.sent[0].messages[0].content).toContain('## POSITION');
  });

  it('marks the last history message as a cache breakpoint in continuous mode', async () => {
    await turn('continuous', priorExchanges());
    const msgs = h.sent[0].messages;
    expect(msgs[3].cache).toBe(true);
    expect(msgs[4].cache).toBeUndefined();
  });

  it('keeps the system prompt byte-identical across turns for cache hits', async () => {
    await turn('continuous', priorExchanges());
    await turn('continuous', [
      ...priorExchanges(),
      {
        ply: 2,
        messages: [{ role: 'user', content: 'POSITION-turn-2' }, { role: 'assistant', content: '{"move_uci":"g1f3"}' }],
      },
    ]);
    expect(h.sent[0].system).toBe(h.sent[1].system);
  });

  it('returns the exchange so the caller can remember it', async () => {
    const outcome = await turn('continuous', []);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.exchange.ply).toBe(2);
      expect(outcome.exchange.messages[0].content).toContain('## PAST TURN');
      expect(outcome.exchange.messages[0].content).toContain(new Chess().fen());
      expect(outcome.exchange.messages[0].content).not.toContain('LEGAL MOVES');
      expect(outcome.exchange.messages.at(-1)?.content).toContain('e2e4');
    }
  });

  it('repairs a rejected move within the turn without replaying it on future turns', async () => {
    h.script.push('{"move_uci":"e2e9","move_san":"Qh9"}');
    const outcome = await turn('continuous', []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const roles = outcome.exchange.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant']);
    expect(JSON.parse(outcome.exchange.messages[1].content)).toEqual({ move_uci: 'e2e4' });
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].raw).toContain('e2e9');
    expect(h.sent[1].messages[1].content).toContain('e2e9');
    expect(h.sent[1].messages[2].content).toContain('could not be used');

    h.sent.length = 0;
    await turn('continuous', [outcome.exchange]);
    expect(h.sent[0].messages).toHaveLength(3);
    expect(JSON.stringify(h.sent[0].messages)).not.toContain('e2e9');
    expect(JSON.stringify(h.sent[0].messages)).not.toContain('could not be used');
  });

  it('retains the selected move and commentary without storing surrounding candidate analysis', async () => {
    h.script.push('Considering Nf3 and d4.\n{"move_uci":"e2e4","commentary":"控制中心，为出子创造条件。"}');
    const outcome = await turn('continuous', []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.parse(outcome.exchange.messages[1].content)).toEqual({
      move_uci: 'e2e4', commentary: '控制中心，为出子创造条件。',
    });
    expect(outcome.attempts[0].raw).toContain('Considering Nf3');
  });

  it('does not save a commentary taken from a discarded reasoning block', async () => {
    h.script.push('<think>{"move_uci":"d2d4","commentary":"Rejected plan"}</think>{"move_uci":"e2e4"}');
    const outcome = await turn('continuous', []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.commentary).toBeNull();
    expect(JSON.parse(outcome.exchange.messages[1].content)).toEqual({ move_uci: 'e2e4' });
  });

  it('keeps the end of a long rejected reply for repair and avoids duplicating it', async () => {
    const raw = 'Long analysis. '.repeat(500) + 'Final candidate: Qh9.';
    h.script.push(raw);
    const outcome = await turn('continuous', []);
    expect(outcome.ok).toBe(true);
    const repairMessages = h.sent[1].messages;
    expect(repairMessages[1].content).toContain('Final candidate: Qh9.');
    expect(repairMessages[1].content.length).toBeLessThan(1600);
    expect(repairMessages[2].content).not.toContain('Long analysis');
  });
});

describe('context helpers', () => {
  it('historyMessages alternates user/assistant in order', () => {
    const msgs = historyMessages(priorExchanges());
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[0].content).toBe('POSITION-turn-0');
  });

  it('appendExchange keeps everything while under budget', () => {
    const list = appendExchange([], {
      ply: 0,
      messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }],
    });
    expect(list).toHaveLength(1);
  });

  it('truncateForPly drops exchanges at or beyond the board ply', () => {
    const kept = truncateForPly(priorExchanges(), 1);
    expect(kept).toHaveLength(1);
    expect(kept[0].ply).toBe(0);
  });

  it('uses the recorded token count when present', () => {
    const measured: Exchange = {
      ply: 0,
      messages: [{ role: 'user', content: 'x'.repeat(1000) }, { role: 'assistant', content: 'y' }],
      tokens: 1234,
    };
    expect(estimateExchangeTokens(measured)).toBe(1234);
  });

  it('falls back to an estimate when no token count was recorded', () => {
    const guessed: Exchange = {
      ply: 0,
      messages: [{ role: 'user', content: 'x'.repeat(250) }, { role: 'assistant', content: 'y'.repeat(250) }],
    };
    expect(estimateExchangeTokens(guessed)).toBe(200);
  });

  it('trimExchanges trims in one coarse step, leaving headroom', () => {
    // Each exchange is 200 tokens; budget 800 holds 4 of them.
    const list: Exchange[] = [0, 1, 2, 3, 4].map((ply) => ({
      ply,
      messages: [{ role: 'user', content: '' }],
      tokens: 200,
    }));
    // Over budget: drop down to ~60% (480 tokens) => 2 exchanges remain.
    expect(trimExchanges(list, 800).map((e) => e.ply)).toEqual([3, 4]);
    // Already under budget: untouched.
    expect(trimExchanges(list.slice(0, 4), 800).map((e) => e.ply)).toEqual([0, 1, 2, 3]);
    expect(trimExchanges(list, 0)).toEqual([]);
  });

  it('estimates non-ASCII text conservatively', () => {
    expect(estimateTokens('a'.repeat(25))).toBe(10);
  });

  it('counts every CJK character, not alternating ones', () => {
    // 10 Chinese chars ≈ 10 tokens; ASCII parts stay at 2.5 chars/token.
    expect(estimateTokens('这是一段中文解说')).toBe(8);
    expect(estimateTokens('中文中文中文中文')).toBe(8);
    expect(estimateTokens('abc中文')).toBe(4);
  });
});
