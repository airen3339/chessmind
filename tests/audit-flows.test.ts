import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnOptions, TurnOutcome } from '../src/ai/coordinator';
import type { CoachReply } from '../src/coach/request';
import { DEFAULT_AI, DEFAULT_SETTINGS } from '../src/config';
import { DEFAULT_COACH } from '../src/coach/types';
import { createCoachSession } from '../src/coach/session';

const h = vi.hoisted(() => ({ coach: vi.fn(), ai: vi.fn() }));
vi.mock('../src/coach/request', () => ({ requestCoach: h.coach }));
vi.mock('../src/ai/coordinator', () => ({ requestAiMove: h.ai }));
const { useGame: game, getEngine } = await import('../src/game/store');
const { useSettings: settings } = await import('../src/settings');
const coach = { ...DEFAULT_COACH, enabled: true };
const reply: CoachReply = { ok: true, text: JSON.stringify({ move_review: 'ok', position_read: 'even', suggestion_san: 'e4', why: 'centre' }), error: null, usage: null, elapsedMs: 1, attempts: 1 };
const flush = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: DEFAULT_COACH });
  await flush();
  h.coach.mockReset().mockResolvedValue(reply);
  h.ai.mockReset();
  settings.setState({ loaded: false, loadError: null });
  settings.getState().replace({ ...structuredClone(DEFAULT_SETTINGS), aiProfiles: [
    { id: 'A', name: 'A', config: { ...DEFAULT_AI, model: 'model-a' } },
    { id: 'B', name: 'B', config: { ...DEFAULT_AI, model: 'model-b' } },
  ], aiSelection: { w: 'A', b: 'A' }, activeProfile: 'A' });
});

afterEach(async () => {
  game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: DEFAULT_COACH });
  await flush();
  vi.useRealTimers();
});

describe('audit: game lifecycle', () => {
  it('keeps current profiles when next-game selections or saved profiles change', async () => {
    game.getState().startGame({ players: { w: 'human', b: 'ai' }, coach: { ...coach, profileId: 'A' } });
    settings.getState().updateCoach({ profileId: 'B' });
    settings.getState().setSideProfile('b', 'B');
    settings.getState().updateAi({ model: 'changed-a' });
    game.getState().humanMove('e2', 'e4');
    await flush();
    expect(h.coach.mock.calls[0][0].cfg.model).toBe('model-a');
    expect(game.getState().gameProfiles.b.config.model).toBe('model-a');
    h.ai.mockImplementation((opts: TurnOptions) => new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled', attempts: [] }))));
    await vi.advanceTimersByTimeAsync(420);
    expect(h.ai.mock.calls[0][0].cfg.model).toBe('model-a');
  });

  it('does not cancel the opening AI request when no undo target exists', async () => {
    let resolve!: (outcome: TurnOutcome) => void;
    h.ai.mockImplementation(() => new Promise<TurnOutcome>((done) => { resolve = done; }));
    game.getState().startGame({ players: { w: 'ai', b: 'human' }, coach: DEFAULT_COACH });
    await vi.advanceTimersByTimeAsync(420);
    const signal = h.ai.mock.calls[0][0].signal;
    game.getState().undo();
    expect(signal.aborted).toBe(false);
    expect(game.getState().thinking).toBe(true);
    resolve({ ok: false, error: 'test completion', attempts: [] });
    await flush();
  });

  it('picks up repaired settings on explicit retry without changing the pinned profile', async () => {
    h.ai.mockResolvedValue({ ok: false, error: 'bad key', attempts: [] });
    game.getState().startGame({ players: { w: 'ai', b: 'human' }, coach: DEFAULT_COACH });
    await vi.advanceTimersByTimeAsync(420);
    settings.getState().updateAi({ apiKey: 'repaired-key' });
    settings.getState().setSideProfile('w', 'B');
    game.getState().retryAi();
    await vi.advanceTimersByTimeAsync(420);
    expect(h.ai.mock.calls[1][0].cfg.model).toBe('model-a');
    expect(h.ai.mock.calls[1][0].cfg.apiKey).toBe('repaired-key');
  });

  it('preserves the first setup return state when entry is repeated', () => {
    game.getState().startGame({ players: { w: 'human', b: 'human' }, orientation: 'w', coach });
    const originalProfiles = game.getState().gameProfiles;
    game.getState().openSetup({ source: 'new', blank: true, players: { w: 'ai', b: 'human' }, orientation: 'b', coach: DEFAULT_COACH });
    game.getState().openSetup({ source: 'new' });
    game.getState().cancelSetup();
    expect(game.getState().players).toEqual({ w: 'human', b: 'human' });
    expect(game.getState().orientation).toBe('w');
    expect(game.getState().coach.enabled).toBe(true);
    expect(game.getState().gameProfiles).toBe(originalProfiles);
  });

  it('retains valid reviews and hint identity after a midgame edit and undo', async () => {
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach });
    game.getState().humanMove('e2', 'e4');
    await flush();
    game.getState().openSetup({ source: 'midgame' });
    expect(game.getState().applySetup()).toBe(true);
    game.getState().humanMove('e7', 'e5');
    await flush();
    game.getState().askHint();
    await flush();
    expect(game.getState().coachLog.at(-1)?.ply).toBe(game.getState().moveLog.length);
    game.getState().humanMove('g1', 'f3');
    await flush();
    game.getState().undo();
    expect(game.getState().coachLog.some((entry) => entry.san === 'e5')).toBe(true);
    expect(game.getState().coachLog.some((entry) => entry.san === 'Nf3')).toBe(false);
  });

  it('deduplicates repeated hints while a slow request runs', async () => {
    let finish!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(reply); }));
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach });
    game.getState().askHint(); game.getState().askHint(); game.getState().askHint();
    expect(h.coach).toHaveBeenCalledTimes(1);
    expect(game.getState().coachLog).toHaveLength(1);
    finish(); await flush();
    expect(h.coach).toHaveBeenCalledTimes(1);
    expect(game.getState().hintBusy).toBe(false);
  });

  it('bounds coach backlog and does not request discarded reviews', async () => {
    let finish!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(reply); }));
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: { ...coach, summary: false } });
    for (let i = 0; i < 20 && game.getState().mode === 'playing'; i++) {
      const moves = getEngine().moves({ verbose: true });
      const move = moves.find((item) => item.piece === 'p') ?? moves[0];
      game.getState().humanMove(move.from, move.to, move.promotion);
    }
    expect(h.coach).toHaveBeenCalledTimes(1);
    expect(game.getState().coachLog.filter((entry) => entry.pending).length).toBeLessThanOrEqual(9);
    expect(game.getState().coachLog.some((entry) => entry.skipReason?.includes('跳过积压'))).toBe(true);
    finish(); await flush();
    expect(h.coach.mock.calls.length).toBeLessThanOrEqual(9);
    expect(game.getState().coachLog.some((entry) => entry.pending)).toBe(false);
  });

  it('reviews every queued move in order when backlog skipping is disabled', async () => {
    let finish!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(reply); }));
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: { ...coach, skipBacklog: false, summary: false } });
    for (let i = 0; i < 20; i++) {
      const moves = getEngine().moves({ verbose: true });
      const move = moves.find((item) => item.piece === 'p') ?? moves[0];
      expect(game.getState().humanMove(move.from, move.to, move.promotion)).toBe(true);
    }
    expect(h.coach).toHaveBeenCalledTimes(1);
    expect(game.getState().coachLog.filter((entry) => entry.pending)).toHaveLength(20);
    finish();
    await flush();
    expect(h.coach).toHaveBeenCalledTimes(20);
    const reviewed = h.coach.mock.calls.map(([opts]) => opts.user);
    game.getState().coachLog.forEach((entry, index) => {
      expect(entry).toMatchObject({ pending: false, verdict: 'ok', read: 'even', error: null });
      expect(entry.skipReason).toBeUndefined();
      expect(reviewed[index]).toContain(entry.san);
    });
  });

  it('retains pending reviews beyond the 60-card display history when skipping is off', async () => {
    let finish!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(reply); }));
    let state: ReturnType<Parameters<typeof createCoachSession>[0]> = {
      coach: { ...coach, skipBacklog: false }, players: { w: 'human', b: 'human' },
      gameProfiles: game.getState().gameProfiles, coachLog: [], coachSummary: null, hintBusy: false,
    };
    const session = createCoachSession(() => state, (patch) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    });
    for (let index = 0; index < 70; index++) {
      const move = { number: index + 1, side: 'w' as const, san: 'e4' };
      const entryId = session.pushCoachEntry({ kind: 'review', ply: index + 1, ...move, verdict: null,
        read: null, error: null, elapsedMs: 0, pending: true, expects: { verdict: false, read: true } });
      session.queueCoach({ kind: 'review', entryId, afterFen: getEngine().fen(), before: null,
        move, fields: { review: false, position: true } });
    }
    expect(h.coach).toHaveBeenCalledTimes(1);
    expect(state.coachLog).toHaveLength(70);
    expect(state.coachLog.every((entry) => entry.pending)).toBe(true);
    finish();
    await flush();
    expect(h.coach).toHaveBeenCalledTimes(70);
    expect(state.coachLog.every((entry) => !entry.pending && entry.read === 'even' && !entry.skipReason)).toBe(true);
    session.cancelPendingCoach();
  });

  it('ignores an AI reply that arrives after pause', async () => {
    let finish!: (outcome: TurnOutcome) => void;
    h.ai.mockImplementation(() => new Promise<TurnOutcome>((resolve) => { finish = resolve; }));
    game.getState().startGame({ players: { w: 'ai', b: 'human' }, coach: DEFAULT_COACH });
    await vi.advanceTimersByTimeAsync(420);
    const move = getEngine().moves({ verbose: true })[0];
    game.getState().togglePause();
    finish({ ok: true, move, attempts: [], reasoning: '', commentary: null, usage: null, warnings: [], exchange: { ply: 0, messages: [] } });
    await flush();
    expect(game.getState().mode).toBe('paused');
    expect(game.getState().moveLog).toEqual([]);
  });

  it('prioritises the final summary over a slow move review', async () => {
    h.coach.mockImplementationOnce((opts: { signal: AbortSignal }) => new Promise((resolve) => {
      opts.signal.addEventListener('abort', () => resolve({ ...reply, ok: false, text: '' }), { once: true });
    })).mockResolvedValue({ ...reply, text: JSON.stringify({ summary: 'final review' }) });
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach, fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 1' });
    game.getState().humanMove('h1', 'h8');
    await flush();
    expect(h.coach.mock.calls[0][0].signal.aborted).toBe(true);
    expect(game.getState().coachSummary).toMatchObject({ state: 'done', text: 'final review' });
  });

  it('keeps round 38 visible and starts its summary even if an aborted review never acknowledges cancellation', async () => {
    let finishOld!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => {
      finishOld = () => resolve(reply);
    })).mockResolvedValue({ ...reply, text: JSON.stringify({ summary: 'review through round 38' }) });
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach,
      fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 31' });
    try {
      const rookPath = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h1'];
      for (let round = 0; round < 7; round++) {
        expect(game.getState().humanMove(rookPath[round], rookPath[round + 1])).toBe(true);
        expect(game.getState().humanMove(round % 2 ? 'b8' : 'a8', round % 2 ? 'a8' : 'b8')).toBe(true);
      }
      expect(h.coach).toHaveBeenCalledTimes(1);
      expect(game.getState().coachLog.some(entry => entry.skipReason?.includes('跳过积压'))).toBe(true);
      expect(game.getState().humanMove('h1', 'h8')).toBe(true);
      expect(game.getState().result?.reason).toBe('checkmate');
      expect.soft(game.getState().coachSummary?.state).toBe('running');
      expect.soft(game.getState().coachLog.at(-1)?.number).toBe(38);
      expect.soft(game.getState().coachLog.at(-1)?.san).toBe('Rh8#');
      await flush();
      expect.soft(h.coach).toHaveBeenCalledTimes(2);
      expect.soft(game.getState().coachSummary).toMatchObject({ state: 'done', text: 'review through round 38' });
      const summaryRequest = h.coach.mock.calls.find(([opts]) => opts.user.includes('## GAME'))?.[0];
      expect.soft(summaryRequest?.user).toContain('38. Rh8#');
      expect.soft(game.getState().coachLog.some(entry => entry.pending)).toBe(false);
      const finalSummary = game.getState().coachSummary;
      const finalLog = game.getState().coachLog;
      finishOld();
      await flush();
      expect(game.getState().coachSummary).toBe(finalSummary);
      expect(game.getState().coachLog).toBe(finalLog);
    } finally {
      finishOld?.();
      await flush();
    }
  });

  it('prioritises the summary and then completes retained reviews when skipping is off', async () => {
    let rejectOld!: (error: Error) => void;
    h.coach.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockImplementation(async (opts: { user: string }) => opts.user.includes('## GAME')
        ? { ...reply, text: '{"summary":"complete game"}' } : reply);
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: { ...coach, skipBacklog: false },
      fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 38' });
    expect(game.getState().humanMove('h1', 'h7')).toBe(true);
    expect(game.getState().humanMove('a8', 'b8')).toBe(true);
    expect(game.getState().humanMove('h7', 'h8')).toBe(true);
    expect(game.getState().result?.reason).toBe('checkmate');
    expect(game.getState().coachLog).toHaveLength(3);
    expect(game.getState().coachSummary?.state).toBe('running');
    await flush();
    expect(h.coach.mock.calls[0][0].signal.aborted).toBe(true);
    expect(h.coach.mock.calls[1][0].user).toContain('## GAME');
    expect(h.coach).toHaveBeenCalledTimes(5);
    expect(game.getState().coachSummary).toMatchObject({ state: 'done', text: 'complete game' });
    expect(game.getState().coachLog.every((entry) => !entry.pending && !entry.skipReason && entry.verdict === 'ok')).toBe(true);
    const finalLog = game.getState().coachLog;
    rejectOld(new Error('late transport cleanup failure'));
    await flush();
    expect(game.getState().coachLog).toBe(finalLog);
    expect(game.getState().coachSummary?.state).toBe('done');
  });

  it('retries a failed summary from the full game with updated pinned settings and deduplicates clicks', async () => {
    let finish!: () => void;
    h.coach.mockResolvedValueOnce({ ...reply, ok: false, text: '', error: 'temporary failure' })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ...reply, text: '{"summary":"retried game"}' }); }));
    game.getState().startGame({ players: { w: 'human', b: 'human' },
      coach: { ...coach, opponentMoves: false, position: false, profileId: 'A' },
      fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 38' });
    game.getState().humanMove('h1', 'h8');
    await flush();
    expect(game.getState().coachSummary).toMatchObject({ state: 'failed', error: 'temporary failure' });
    const moves = game.getState().moveLog;
    settings.getState().updateAi({ model: 'repaired-model-a' });
    settings.getState().updateCoach({ profileId: 'B' });
    game.getState().retryCoachSummary();
    game.getState().retryCoachSummary();
    await flush();
    expect(h.coach).toHaveBeenCalledTimes(2);
    expect(h.coach.mock.calls[1][0].user).toBe(h.coach.mock.calls[0][0].user);
    expect(h.coach.mock.calls[1][0].user).toContain('38. Rh8#');
    expect(h.coach.mock.calls[1][0].cfg.model).toBe('repaired-model-a');
    game.getState().finishGame('resigned');
    expect(game.getState().coachSummary?.state).toBe('running');
    expect(h.coach.mock.calls[1][0].signal.aborted).toBe(false);
    finish();
    await flush();
    expect(game.getState().coachSummary).toMatchObject({ state: 'done', text: 'retried game' });
    expect(game.getState().moveLog).toBe(moves);
  });

  it('starts coaching a new game without waiting for an aborted old transport', async () => {
    let finishOld!: () => void;
    h.coach.mockImplementationOnce(() => new Promise((resolve) => { finishOld = () => resolve(reply); }));
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach });
    game.getState().humanMove('e2', 'e4');
    game.getState().startGame({ players: { w: 'human', b: 'human' }, coach });
    game.getState().humanMove('d2', 'd4');
    await flush();
    expect(h.coach).toHaveBeenCalledTimes(2);
    expect(game.getState().coachLog).toHaveLength(1);
    expect(game.getState().coachLog[0]).toMatchObject({ san: 'd4', pending: false, verdict: 'ok' });
    const currentLog = game.getState().coachLog;
    finishOld();
    await flush();
    expect(game.getState().coachLog).toBe(currentLog);
  });
});
