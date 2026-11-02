import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnOptions, TurnOutcome } from '../src/ai/coordinator';
import type { CoachReply } from '../src/coach/request';
import { DEFAULT_AI, DEFAULT_SETTINGS } from '../src/config';
import { DEFAULT_COACH } from '../src/coach/types';

const h = vi.hoisted(() => ({ coach: vi.fn(), ai: vi.fn() }));
vi.mock('../src/coach/request', () => ({ requestCoach: h.coach }));
vi.mock('../src/ai/coordinator', () => ({ requestAiMove: h.ai }));
const { useGame: game, getEngine } = await import('../src/game/store');
const { useSettings: settings } = await import('../src/settings');
const coach = { ...DEFAULT_COACH, enabled: true };
const reply: CoachReply = { ok: true, text: JSON.stringify({ move_review: 'ok', position_read: 'even', suggestion_san: 'e4', why: 'centre' }), error: null, usage: null, elapsedMs: 1, attempts: 1 };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

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
    expect(game.getState().coachLog.some((entry) => entry.error?.includes('跳过积压'))).toBe(true);
    finish(); await flush();
    expect(h.coach.mock.calls.length).toBeLessThanOrEqual(9);
    expect(game.getState().coachLog.some((entry) => entry.pending)).toBe(false);
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
});
