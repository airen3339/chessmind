import { Chess, type Move } from 'chess.js';
import { create } from 'zustand';
import { requestAiMove } from '../ai/coordinator';
import { appendExchange, truncateForPly } from '../ai/context';
import type { Exchange } from '../ai/context';
import type { AiProfile, AttemptRecord, Usage } from '../ai/types';
import { createCoachSession } from '../coach/session';
import type { CoachEntry, CoachSummary } from '../coach/session';
export type { CoachEntry, CoachSummary } from '../coach/session';
import { DEFAULT_COACH } from '../coach/types';
import type { CoachConfig } from '../coach/types';
import { useSettings, coachProfileFor, profileFor } from '../settings';
import {
  buildChess,
  findLegalMove,
  gameResultOf,
  legalMoves,
  moveLogToSan,
  uciOf,
} from './engine';
import type { DraftPiece, DraftValidation, SetupDraft } from './setup';
import type {
  Actor,
  Anchor,
  GameResult,
  GameSnapshot,
  Mode,
  MoveEntry,
  ResultReason,
  Side,
} from './types';
import { START_FEN } from './types';
import { createSetupActions } from './setupSession';

let engine: Chess = new Chess(START_FEN);

/**
 * Conversation carried across moves for continuous-context mode: each AI turn's
 * compact position note plus its chosen move/explanation. Kept outside the
 * state because it never needs to trigger a re-render. Reset on a new game / board edit and
 * truncated when moves are taken back.
 *
 * Kept PER SIDE: in an AI-vs-AI game the two engines are separate conversations,
 * and showing White's reasoning to Black would both leak its plan and break the
 * prompt-cache prefix (a different profile = a different request anyway).
 */
let exchangesBySide: Record<Side, Exchange[]> = { w: [], b: [] };

function clearExchanges(): void {
  exchangesBySide = { w: [], b: [] };
}

export function getEngine(): Chess {
  return engine;
}

let aiAbort: AbortController | null = null;
let aiToken = 0;
let aiTimer: ReturnType<typeof setTimeout> | null = null;
let toastSeq = 0;

export interface AiTurnView {
  id: number;
  side: Side;
  /** Saved AI profile used for this turn (name is for display). */
  profileName: string;
  attempt: number;
  limit: number;
  reasoning: string;
  text: string;
  notice: string | null;
  attempts: AttemptRecord[];
  error: string | null;
  commentary: string | null;
  usage: Usage | null;
  elapsedMs: number;
  phase: 'requesting' | 'done' | 'failed';
  startedAt: number;
}

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export type SetupSource = 'new' | 'midgame';

export interface GameStore {
  mode: Mode;
  players: { w: Actor; b: Actor };
  /** Profiles resolved when this game starts; next-game drafts cannot change them. */
  gameProfiles: { w: AiProfile; b: AiProfile; coach: AiProfile };
  orientation: Side;
  anchor: Anchor;
  fen: string;
  turn: Side;
  moveLog: MoveEntry[];
  lastMove: { from: string; to: string } | null;
  snapshots: GameSnapshot[];
  result: GameResult | null;
  thinking: boolean;
  aiTurn: AiTurnView | null;
  aiError: string | null;
  setupDraft: SetupDraft | null;
  setupValidation: DraftValidation | null;
  setupPast: SetupDraft[];
  setupFuture: SetupDraft[];
  setupReturn: GameSnapshot | null;
  /** Players/orientation/coach in effect before the setup editor opened. */
  setupReturnSides: {
    players: { w: Actor; b: Actor };
    orientation: Side;
    coach: CoachConfig;
    gameProfiles: GameStore['gameProfiles'];
  } | null;
  setupSource: SetupSource | null;
  toast: Toast | null;
  version: number;
  /** Increments only when a move is actually played, so the board can animate it. */
  moveSeq: number;
  /** Coach mode of the current game, chosen in the new-game dialog. */
  coach: CoachConfig;
  coachLog: CoachEntry[];
  /** A guidance request is queued or in flight. */
  hintBusy: boolean;
  coachSummary: CoachSummary | null;

  startGame(opts: {
    players: { w: Actor; b: Actor };
    fen?: string;
    orientation?: Side;
    coach?: CoachConfig;
    aiSelection?: { w: string; b: string };
  }): void;
  openSetup(opts: {
    source: SetupSource;
    blank?: boolean;
    fen?: string;
    /** Sides chosen in the new-game dialog; applied for the duration of the editor. */
    players?: { w: Actor; b: Actor };
    orientation?: Side;
    coach?: CoachConfig;
    aiSelection?: { w: string; b: string };
  }): void;
  setSetupPiece(square: string, piece: DraftPiece | null): void;
  moveSetupPiece(from: string, to: string): void;
  clearSetupBoard(): void;
  resetSetupStandard(): void;
  setupKingsOnly(): void;
  setSetupTurn(turn: Side): void;
  toggleSetupCastling(color: Side, side: 'k' | 'q'): void;
  setSetupCounters(halfmove: number, moveNumber: number): void;
  loadSetupFen(fen: string): boolean;
  setupUndo(): void;
  setupRedo(): void;
  applySetup(): boolean;
  cancelSetup(): void;
  humanMove(from: string, to: string, promotion?: string): boolean;
  undo(): void;
  flip(): void;
  togglePause(): void;
  finishGame(reason: ResultReason): void;
  /** Ask the coach for one suggested move in the current position. */
  askHint(): void;
  /** Regenerate the whole-game review after a natural end or a failed request. */
  retryCoachSummary(): void;
  retryAi(): void;
  playRandomMove(): void;
  abortAi(): void;
  notify(message: string, tone?: Toast['tone']): void;
  clearToast(): void;
}

function makeToast(message: string, tone: Toast['tone']): Toast {
  toastSeq += 1;
  return { id: toastSeq, message, tone };
}

function cancelPendingAi(): void {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (aiAbort) {
    aiAbort.abort();
    aiAbort = null;
  }
  aiToken += 1;
}

function resolveGameProfiles(
  players: { w: Actor; b: Actor },
  coach: CoachConfig,
  aiSelection = useSettings.getState().settings.aiSelection,
): GameStore['gameProfiles'] {
  const settings = { ...useSettings.getState().settings, coach, aiSelection };
  const copy = (profile: AiProfile): AiProfile => ({ ...profile, config: { ...profile.config } });
  return { w: copy(profileFor(settings, 'w')), b: copy(profileFor(settings, 'b')), coach: copy(coachProfileFor(settings, players)) };
}

export const useGame = create<GameStore>((set, get) => {
  const initialSnapshot: GameSnapshot = {
    anchor: { fen: START_FEN, logIndex: 0 },
    moveLog: [],
    lastMove: null,
    mode: 'idle',
    result: null,
    turn: 'w',
  };

  function commitSnapshot(snapshot: GameSnapshot, extra: Partial<GameStore> = {}): void {
    const state = get();
    set({
      mode: snapshot.mode,
      anchor: snapshot.anchor,
      moveLog: snapshot.moveLog,
      lastMove: snapshot.lastMove,
      result: snapshot.result,
      turn: snapshot.turn,
      fen: engine.fen(),
      snapshots: [...state.snapshots, snapshot],
      version: state.version + 1,
      ...extra,
    });
  }

  const { pushCoachEntry, cancelPendingCoach, dropPendingHints, queueCoach } = createCoachSession(get, set);
  const setupActions = createSetupActions(set, get, {
    getEngine: () => engine, setEngine: (chess) => { engine = chess; },
    abortAiInternal, clearExchanges, cancelPendingCoach, scheduleAi, resolveGameProfiles,
  });

  function queueGameSummary(): void {
    const state = get();
    if (state.mode !== 'finished' || !state.result || state.result.reason === 'resigned'
      || !state.coach.enabled || !state.coach.summary || state.moveLog.length === 0) return;
    queueCoach({
      kind: 'summary',
      startFen: state.anchor.fen,
      sanLine: moveLogToSan(state.moveLog, state.anchor.logIndex),
      result: state.result.text,
    });
  }

  function applyMove(
    from: string,
    to: string,
    promotion: string | undefined,
    actor: Actor,
    /** The engine's own explanation of this move, when it was asked for one. */
    ownCommentary: string | null = null,
  ): boolean {
    const state = get();
    const move = findLegalMove(engine, { from, to, promotion });
    if (!move) return false;
    const coach = state.coach;
    // Only a human move no engine explained itself is critiqued, and only that
    // case needs the position the move was played in (and its legal moves).
    const judgeMove = coach.enabled && actor === 'human' && coach.opponentMoves;
    const beforeFen = judgeMove ? engine.fen() : '';
    const beforeMoves = judgeMove ? legalMoves(engine).map((item) => item.san) : [];
    const number = engine.moveNumber();
    const applied = engine.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!applied) return false;
    const entry: MoveEntry = {
      ply: state.moveLog.length,
      number,
      color: applied.color,
      san: applied.san,
      uci: uciOf(applied),
      actor,
    };
    const moveLog = [...state.moveLog, entry];
    const result = gameResultOf(engine);
    commitSnapshot({
      anchor: state.anchor,
      moveLog,
      lastMove: { from: applied.from, to: applied.to },
      mode: result ? 'finished' : 'playing',
      result,
      turn: engine.turn(),
    });
    set({ moveSeq: state.moveSeq + 1 });

    // A suggestion is about the position that just went away.
    dropPendingHints();
    if (coach.enabled) {
      if (actor === 'human') {
        const review = coach.opponentMoves;
        if (review || coach.position) {
          const entryId = pushCoachEntry({
            kind: 'review',
            ply: moveLog.length,
            number,
            side: applied.color,
            san: applied.san,
            verdict: null,
            read: null,
            error: null,
            elapsedMs: 0,
            pending: true,
            expects: { verdict: review, read: coach.position },
          });
          queueCoach({
            kind: 'review',
            entryId,
            before: review ? { fen: beforeFen, moves: beforeMoves } : null,
            afterFen: engine.fen(),
            move: { number, side: applied.color, san: applied.san },
            fields: { review, position: coach.position },
          });
        }
      } else if (coach.ownMoves || coach.position) {
        // The engine narrates its own move (that text rides along with the move
        // request), so the coach only adds a read of the resulting position.
        const entryId = pushCoachEntry({
          kind: 'review',
          ply: moveLog.length,
          number,
          side: applied.color,
          san: applied.san,
          verdict: coach.ownMoves ? ownCommentary : null,
          read: null,
          error: null,
          elapsedMs: 0,
          pending: coach.position,
          expects: { verdict: coach.ownMoves, read: coach.position },
        });
        if (coach.position) {
          queueCoach({
            kind: 'review',
            entryId,
            before: null,
            afterFen: engine.fen(),
            move: { number, side: applied.color, san: applied.san },
            fields: { review: false, position: true },
          });
        }
      }
    }
    if (result) queueGameSummary();
    return true;
  }

  function scheduleAi(): void {
    const state = get();
    if (state.mode !== 'playing') return;
    if (state.players[state.turn] !== 'ai') return;
    if (aiTimer) clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      aiTimer = null;
      void runAiTurn();
    }, 420);
  }

  async function runAiTurn(): Promise<void> {
    const state = get();
    if (state.mode !== 'playing' || state.players[state.turn] !== 'ai') return;
    const settings = useSettings.getState().settings;
    const controller = new AbortController();
    aiAbort = controller;
    const token = (aiToken += 1);
    const side = state.turn;
    const chess = engine;
    // Each side can use a different saved AI profile (relevant for AI vs AI).
    const profile = state.gameProfiles[side];
    const cfg = profile.config;
    const history = state.moveLog
      .slice(state.anchor.logIndex)
      .filter((entry) => entry.actor !== 'edit')
      .map((entry) => entry.san);
    const edited = state.anchor.logIndex > 0;

    set({
      thinking: true,
      aiError: null,
      aiTurn: {
        id: token,
        side,
        profileName: profile.name,
        attempt: 1,
        limit: cfg.retries,
        reasoning: '',
        text: '',
        notice: null,
        attempts: [],
        error: null,
        commentary: null,
        usage: null,
        elapsedMs: 0,
        phase: 'requesting',
        startedAt: Date.now(),
      },
    });

    const isCurrent = () => token === aiToken && !controller.signal.aborted;

    try {
      const outcome = await requestAiMove(
        {
          cfg,
          side,
          chess,
          history,
          edited,
          commentary: state.coach.enabled && state.coach.ownMoves,
          lang: settings.ui.commentaryLang,
          opponent: state.players[side === 'w' ? 'b' : 'w'] === 'ai' ? 'ai' : 'human',
          exchanges: exchangesBySide[side],
          signal: controller.signal,
        },
        {
          onAttemptStart: (attempt, limit) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({
              aiTurn: {
                ...turn,
                attempt,
                limit,
                reasoning: '',
                text: '',
                notice: null,
                error: null,
              },
            });
          },
          onReasoning: (chunk) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, reasoning: turn.reasoning + chunk } });
          },
          onText: (chunk) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, text: turn.text + chunk } });
          },
          onAttemptEnd: (record) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, attempts: [...turn.attempts, record] } });
          },
          onNotice: (message) => {
            if (!isCurrent()) return;
            const turn = get().aiTurn;
            if (!turn) return;
            set({ aiTurn: { ...turn, notice: message } });
          },
        },
      );

      if (!isCurrent()) return;

      if (!outcome.ok) {
        const turn = get().aiTurn;
        set({
          thinking: false,
          aiError: outcome.error,
          aiTurn: turn
            ? { ...turn, phase: 'failed', error: outcome.error, elapsedMs: Date.now() - turn.startedAt }
            : null,
          mode: get().mode === 'playing' ? 'paused' : get().mode,
        });
        return;
      }

      const current = get();
      if (current.mode !== 'playing' || current.turn !== side) return;
      const turn = get().aiTurn;
      set({
        thinking: false,
        aiTurn: turn
          ? {
              ...turn,
              phase: 'done',
              reasoning: outcome.reasoning || turn.reasoning,
              commentary: outcome.commentary,
              usage: outcome.usage,
              elapsedMs: Date.now() - turn.startedAt,
              error: null,
            }
          : null,
      });
      applyMove(outcome.move.from, outcome.move.to, outcome.move.promotion, 'ai', outcome.commentary);
      exchangesBySide[side] = appendExchange(
        exchangesBySide[side],
        outcome.exchange,
        cfg.contextBudget,
      );
      if (outcome.warnings.length > 0) {
        get().notify(outcome.warnings.join('；'), 'info');
      }
      scheduleAi();
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      const turn = get().aiTurn;
      set({
        thinking: false,
        aiError: message,
        aiTurn: turn ? { ...turn, phase: 'failed', error: message } : null,
        mode: get().mode === 'playing' ? 'paused' : get().mode,
      });
    } finally {
      if (aiAbort === controller) aiAbort = null;
    }
  }

  function abortAiInternal(): void {
    cancelPendingAi();
    const state = get();
    if (!state.thinking) return;
    const turn = state.aiTurn;
    set({
      thinking: false,
      aiTurn: turn
        ? { ...turn, phase: 'failed', error: turn.error ?? '已中断', elapsedMs: Date.now() - turn.startedAt }
        : null,
    });
  }

  function findUndoTarget(snapshots: GameSnapshot[], players: { w: Actor; b: Actor }): number | null {
    const hasHuman = players.w === 'human' || players.b === 'human';
    for (let i = snapshots.length - 2; i >= 0; i -= 1) {
      const snapshot = snapshots[i];
      if (snapshot.mode === 'setup') continue;
      if (!hasHuman) return i;
      if (players[snapshot.turn] === 'human') return i;
    }
    return null;
  }


  return {
    mode: 'idle',
    players: { w: 'human', b: 'ai' },
    gameProfiles: resolveGameProfiles({ w: 'human', b: 'ai' }, DEFAULT_COACH),
    orientation: 'w',
    anchor: { fen: START_FEN, logIndex: 0 },
    fen: START_FEN,
    turn: 'w',
    moveLog: [],
    lastMove: null,
    snapshots: [initialSnapshot],
    result: null,
    thinking: false,
    aiTurn: null,
    aiError: null,
    setupDraft: null,
    setupValidation: null,
    setupPast: [],
    setupFuture: [],
    setupReturn: null,
    setupReturnSides: null,
    setupSource: null,
    toast: null,
    version: 0,
    moveSeq: 0,
    coach: { ...DEFAULT_COACH },
    coachLog: [],
    hintBusy: false,
    coachSummary: null,

    startGame({ players, fen, orientation, coach, aiSelection }) {
      abortAiInternal();
      clearExchanges();
      cancelPendingCoach();
      const nextCoach: CoachConfig = { ...(coach ?? get().coach) };
      const startFen = fen ?? START_FEN;
      engine = new Chess(startFen, { skipValidation: true });
      const anchor: Anchor = { fen: startFen, logIndex: 0 };
      const result = gameResultOf(engine);
      const snapshot: GameSnapshot = {
        anchor,
        moveLog: [],
        lastMove: null,
        mode: result ? 'finished' : 'playing',
        result,
        turn: engine.turn(),
      };
      set({
        mode: snapshot.mode,
        players,
        gameProfiles: resolveGameProfiles(players, nextCoach, aiSelection),
        orientation: orientation ?? get().orientation,
        coach: nextCoach,
        coachLog: [],
        coachSummary: null,
        hintBusy: false,
        anchor,
        moveLog: [],
        lastMove: null,
        snapshots: [snapshot],
        result,
        thinking: false,
        aiTurn: null,
        aiError: null,
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: get().version + 1,
      });
      useSettings.getState().update({
        players,
        ...(aiSelection ? { aiSelection } : {}),
        orientation: orientation ?? get().orientation,
        coach: nextCoach,
      });
      scheduleAi();
    },

    ...setupActions,

    humanMove(from, to, promotion) {
      const state = get();
      if (state.mode !== 'playing') return false;
      if (state.players[state.turn] !== 'human') return false;
      if (state.thinking) return false;
      const ok = applyMove(from, to, promotion, 'human');
      if (ok) scheduleAi();
      return ok;
    },

    undo() {
      const state = get();
      if (state.mode === 'setup') return;
      const target = findUndoTarget(state.snapshots, state.players);
      if (target === null) {
        get().notify('没有可以悔棋的着法', 'info');
        return;
      }
      abortAiInternal();
      const snapshot = state.snapshots[target];
      engine = buildChess(snapshot.anchor, snapshot.moveLog);
      // Same count as the `history` array fed to the AI: committed moves after
      // the anchor, excluding arbiter edits. Exchanges with a larger ply were
      // about positions that no longer exist, so drop them (and their plans).
      const playedMoves = snapshot.moveLog
        .slice(snapshot.anchor.logIndex)
        .filter((entry) => entry.actor !== 'edit').length;
      exchangesBySide = {
        w: truncateForPly(exchangesBySide.w, playedMoves),
        b: truncateForPly(exchangesBySide.b, playedMoves),
      };
      // Coach remarks about positions that no longer exist go too.
      cancelPendingCoach();
      set({
        mode: snapshot.mode === 'finished' ? 'playing' : snapshot.mode,
        anchor: snapshot.anchor,
        moveLog: snapshot.moveLog,
        lastMove: snapshot.lastMove,
        result: snapshot.mode === 'finished' ? null : snapshot.result,
        snapshots: state.snapshots.slice(0, target + 1),
        coachLog: state.coachLog.filter((entry) => entry.ply <= snapshot.moveLog.length),
        coachSummary: null,
        thinking: false,
        aiTurn: null,
        aiError: null,
        fen: engine.fen(),
        turn: engine.turn(),
        version: state.version + 1,
      });
      scheduleAi();
    },

    flip() {
      const orientation: Side = get().orientation === 'w' ? 'b' : 'w';
      set({ orientation });
      useSettings.getState().update({ orientation });
    },

    togglePause() {
      const state = get();
      if (state.mode === 'playing') {
        abortAiInternal();
        // Nothing should be hitting the network while the game is paused.
        cancelPendingCoach();
        set({ mode: 'paused', thinking: false, version: state.version + 1 });
      } else if (state.mode === 'paused') {
        set({ mode: 'playing', aiError: null, version: state.version + 1 });
        scheduleAi();
      }
    },

    finishGame(reason) {
      const state = get();
      if (state.mode !== 'playing' && state.mode !== 'paused') return;
      abortAiInternal();
      cancelPendingCoach();
      // "resigned" is the UI's "结束对局": the side that ended it concedes.
      const winner: Side | null = reason === 'resigned' ? (state.turn === 'w' ? 'b' : 'w') : null;
      const result: GameResult = {
        winner,
        reason,
        text: reason === 'resigned' ? '对局已手动结束' : '对局已结束',
      };
      commitSnapshot({
        anchor: state.anchor,
        moveLog: state.moveLog,
        lastMove: state.lastMove,
        mode: 'finished',
        result,
        turn: state.turn,
      });
      set({ thinking: false, aiTurn: null, aiError: null });
    },

    retryCoachSummary() {
      const state = get();
      if (state.mode !== 'finished' || !state.result || state.result.reason === 'resigned'
        || !state.coach.enabled || !state.coach.summary || state.moveLog.length === 0
        || state.coachSummary?.state === 'running') return;
      const pinned = state.gameProfiles.coach;
      const saved = useSettings.getState().settings.aiProfiles.find((profile) => profile.id === pinned.id);
      if (saved) set({ gameProfiles: { ...state.gameProfiles, coach: { ...saved, config: { ...saved.config } } } });
      queueGameSummary();
    },

    askHint() {
      const state = get();
      if (!state.coach.enabled || !state.coach.hint) return;
      if (state.hintBusy) return;
      if (state.mode !== 'playing' || state.thinking) return;
      if (state.players[state.turn] !== 'human') return;
      const ply = state.moveLog.length;
      // Asking again replaces the previous suggestion for the same position.
      set({ coachLog: state.coachLog.filter((e) => !(e.kind === 'hint' && e.ply === ply)) });
      const number = engine.moveNumber();
      const entryId = pushCoachEntry({
        kind: 'hint',
        ply,
        number,
        side: state.turn,
        san: null,
        verdict: null,
        read: null,
        error: null,
        elapsedMs: 0,
        pending: true,
        expects: { verdict: true, read: false },
      });
      queueCoach(
        {
          kind: 'hint',
          entryId,
          fen: engine.fen(),
          side: state.turn,
          history: moveLogToSan(state.moveLog, state.anchor.logIndex),
        },
        true,
      );
    },

    retryAi() {
      const state = get();
      if (state.mode !== 'paused' || !state.aiError || state.players[state.turn] !== 'ai') return;
      // An explicit retry can pick up repaired credentials/parameters for the
      // same pinned profile; a next-game selection never changes its identity.
      const saved = useSettings.getState().settings.aiProfiles;
      const refresh = (profile: AiProfile): AiProfile => {
        const next = saved.find((item) => item.id === profile.id) ?? profile;
        return { ...next, config: { ...next.config } };
      };
      set({
        mode: 'playing', aiError: null, thinking: false, version: state.version + 1,
        gameProfiles: { w: refresh(state.gameProfiles.w), b: refresh(state.gameProfiles.b), coach: refresh(state.gameProfiles.coach) },
      });
      scheduleAi();
    },

    playRandomMove() {
      const state = get();
      // Offered in the AI panel when a request failed and the game is paused,
      // so it must accept both the normal and the paused state.
      if (state.mode !== 'playing' && state.mode !== 'paused') return;
      if (state.thinking) return;
      if (state.players[state.turn] !== 'ai') return;
      const moves = engine.moves({ verbose: true }) as Move[];
      if (moves.length === 0) return;
      const move = moves[Math.floor(Math.random() * moves.length)];
      if (state.mode === 'paused') set({ mode: 'playing', aiError: null, version: state.version + 1 });
      applyMove(move.from, move.to, move.promotion, 'ai');
      get().notify('已替 AI 随机走一手（用于继续对局）', 'info');
      scheduleAi();
    },

    abortAi() {
      abortAiInternal();
      set({ thinking: false });
    },

    notify(message, tone = 'info') {
      set({ toast: makeToast(message, tone) });
    },

    clearToast() {
      set({ toast: null });
    },
  };
});
