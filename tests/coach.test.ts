import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import {
  buildCoachReviewPrompt,
  buildCoachSummaryPrompt,
  buildCoachSystemPrompt,
  buildHintPrompt,
  buildHintSystemPrompt,
  buildSummarySystemPrompt,
  parseCoachReview,
  parseHint,
  parseSummary,
} from '../src/coach/prompt';
import { coachConfig, requestCoach } from '../src/coach/request';
import { legalMoves } from '../src/game/engine';
import { DEFAULT_AI } from '../src/config';

/** Scripted HTTP layer: each call pops the next canned reply. */
const client = vi.hoisted(() => ({
  calls: 0,
  queue: [] as Array<{ status: number | null; error: string | null; text: string }>,
}));

vi.mock('../src/ai/client', () => ({
  runAttempt: async () => {
    client.calls += 1;
    const next = client.queue.shift() ?? { status: 200, error: null, text: '' };
    return {
      status: next.status,
      aborted: false,
      error: next.error,
      usage: null,
      text: next.text,
      reasoning: '',
    };
  },
}));

function game(fen?: string): Chess {
  return fen ? new Chess(fen) : new Chess();
}

describe('coach prompts', () => {
  it('asks only for the fields the player enabled and names both keys', () => {
    const both = buildCoachSystemPrompt({
      studentSide: 'w',
      lang: 'zh',
      fields: { review: true, position: true },
    });
    expect(both).toContain('"move_review"');
    expect(both).toContain('"position_read"');
    expect(both).toContain('Simplified Chinese');

    const reviewOnly = buildCoachSystemPrompt({
      studentSide: 'w',
      lang: 'zh',
      fields: { review: true, position: false },
    });
    expect(reviewOnly).toContain('Do not include a "position_read" field');

    const readOnly = buildCoachSystemPrompt({
      studentSide: 'w',
      lang: 'zh',
      fields: { review: false, position: true },
    });
    expect(readOnly).toContain('Do not include a "move_review" field');
  });

  it('never lets the coach invent a move', () => {
    const system = buildCoachSystemPrompt({
      studentSide: 'b',
      lang: 'en',
      fields: { review: true, position: true },
    });
    expect(system).toContain('Every move you name must appear in the LEGAL MOVES list');
    expect(system).toContain('You are coaching the Black player');
  });

  it('addresses whoever just moved when both sides are human', () => {
    const system = buildCoachSystemPrompt({
      studentSide: null,
      lang: 'zh',
      fields: { review: true, position: false },
    });
    expect(system).toContain('Both sides are played by humans');
    expect(system).not.toContain('You are coaching');
  });

  it('gives the position before the move, the move, and the position after it', () => {
    const before = game();
    const prompt = buildCoachReviewPrompt({
      before: { fen: before.fen(), moves: legalMoves(before).map((move) => move.san) },
      move: { number: 1, side: 'w', san: 'e4' },
      after: game('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'),
    });
    expect(prompt).toContain('## POSITION BEFORE THE MOVE');
    expect(prompt).toContain(before.fen());
    expect(prompt).toContain('Nf3');
    expect(prompt).toContain('Move 1: White played e4.');
    expect(prompt).toContain('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(prompt).toContain('Side to move: Black');
  });

  it('drops the pre-move block when only a position read was asked for', () => {
    const prompt = buildCoachReviewPrompt({
      before: null,
      move: { number: 7, side: 'b', san: 'Nf6' },
      after: game('rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 2 2'),
    });
    expect(prompt).not.toContain('POSITION BEFORE THE MOVE');
    expect(prompt).toContain('Move 7: Black played Nf6.');
  });

  it('lists every legal move so a suggestion can be checked', () => {
    const chess = game();
    const prompt = buildHintPrompt({ chess, side: 'w', history: '' });
    for (const move of legalMoves(chess)) expect(prompt).toContain(move.san);
    expect(prompt).toContain('You are advising: White');
    expect(prompt).toContain('(no moves yet');
    expect(buildHintSystemPrompt({ side: 'w', lang: 'en' })).toContain(
      'must be copied verbatim from the LEGAL MOVES',
    );
  });

  it('includes the score, the moves and the result in the review request', () => {
    const prompt = buildCoachSummaryPrompt({
      startFen: new Chess().fen(),
      sanLine: '1. e4 e5 2. Nf3',
      result: '白方将杀获胜',
      lang: 'zh',
    });
    expect(prompt).toContain('1. e4 e5 2. Nf3');
    expect(prompt).toContain('白方将杀获胜');
    expect(prompt).toContain('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
    expect(buildSummarySystemPrompt({ studentSide: 'w', lang: 'ja' })).toContain('Japanese');
  });
});

describe('coach parsing', () => {
  it('reads both fields out of a clean JSON object', () => {
    const parsed = parseCoachReview(
      '{"move_review":"这步 e4 抢中心","position_read":"双方均势"}',
      { review: true, position: true },
    );
    expect(parsed.moveReview).toBe('这步 e4 抢中心');
    expect(parsed.positionRead).toBe('双方均势');
  });

  it('ignores a field that was not requested', () => {
    const parsed = parseCoachReview(
      '{"move_review":"还行","position_read":"黑方略优"}',
      { review: true, position: false },
    );
    expect(parsed.moveReview).toBe('还行');
    expect(parsed.positionRead).toBeNull();
  });

  it('keeps a prose answer instead of showing an empty card', () => {
    const parsed = parseCoachReview('这步不错，中心控制住了。', {
      review: true,
      position: false,
    });
    expect(parsed.moveReview).toContain('中心');
  });

  it('accepts only a legal suggested move', () => {
    const chess = game();
    expect(parseHint('{"suggestion_san":"e2e4","why":"占中心"}', chess)).toEqual({
      san: 'e4',
      why: '占中心',
    });
    expect(parseHint('{"suggestion_san":"e2e5","why":"不合法"}', chess).san).toBeNull();
    expect(parseHint('I would play Nf3 here.', chess).san).toBe('Nf3');
  });

  it('does not repeat the JSON object as the explanation', () => {
    const chess = game();
    expect(parseHint('{"suggestion_san":"d2d4"}', chess).why).toBe('');
  });

  it('reads a summary object and falls back to plain text', () => {
    expect(parseSummary('{"summary":"转折在第 12 回合"}')).toBe('转折在第 12 回合');
    expect(parseSummary('  这局棋的关键是王翼  ')).toBe('这局棋的关键是王翼');
  });
});

describe('coach request settings', () => {
  it('preserves the selected transport and cannot hang for longer than a minute', () => {
    const cfg = coachConfig({ ...DEFAULT_AI, stream: true, timeoutSecs: 300 });
    expect(cfg.stream).toBe(true);
    expect(coachConfig({ ...DEFAULT_AI, stream: false }).stream).toBe(false);
    expect(cfg.timeoutSecs).toBe(60);
    // A short game timeout is never extended by the coach.
    expect(coachConfig({ ...DEFAULT_AI, timeoutSecs: 20 }).timeoutSecs).toBe(20);
    // Everything else is left exactly as the user configured it.
    expect(cfg.model).toBe(DEFAULT_AI.model);
    expect(cfg.maxTokens).toBe(DEFAULT_AI.maxTokens);
    expect(cfg.effort).toBe(DEFAULT_AI.effort);
  });
});

describe('coach retries', () => {
  const call = () => ({
    cfg: DEFAULT_AI,
    system: 's',
    user: 'u',
    signal: new AbortController().signal,
  });

  it('tries again after a transient failure', async () => {
    client.calls = 0;
    client.queue = [
      { status: 503, error: 'upstream unavailable', text: '' },
      { status: 200, error: null, text: '{"move_review":"好"}' },
    ];
    const reply = await requestCoach(call());
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain('move_review');
    expect(reply.attempts).toBe(2);
    expect(client.calls).toBe(2);
  }, 10000);

  it('does not retry a plain 400', async () => {
    client.calls = 0;
    client.queue = [{ status: 400, error: 'bad request', text: '' }];
    const reply = await requestCoach(call());
    expect(reply.ok).toBe(false);
    expect(reply.attempts).toBe(1);
    expect(client.calls).toBe(1);
  });

  it('gives up after the second attempt and keeps the reason', async () => {
    client.calls = 0;
    client.queue = [
      { status: 429, error: 'rate limited', text: '' },
      { status: 429, error: 'rate limited', text: '' },
    ];
    const reply = await requestCoach(call());
    expect(reply.ok).toBe(false);
    expect(reply.attempts).toBe(2);
    expect(reply.error).toContain('rate limited');
  }, 10000);
});
