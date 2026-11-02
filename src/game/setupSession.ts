import type { StoreApi } from 'zustand';
import { Chess } from 'chess.js';
import { useSettings } from '../settings';
import type { AiProfile } from '../ai/types';
import type { CoachConfig } from '../coach/types';
import type { GameStore } from './store';
import type { Actor, Anchor, GameResult, GameSnapshot, Mode, MoveEntry, Side } from './types';
import { START_FEN } from './types';
import { buildChess, gameResultOf } from './engine';
import type { SetupDraft } from './setup';
import {
  castlingAvailable,
  cloneDraft,
  draftFromFen,
  draftToChess,
  draftToFen,
  emptyDraft,
  kingsOnlyDraft,
  moveDraftPiece,
  normalizeCastling,
  standardDraft,
  toggleSquarePiece,
  validateDraft,
} from './setup';
function snapshotOf(state: {
  anchor: Anchor;
  moveLog: MoveEntry[];
  lastMove: { from: string; to: string } | null;
  mode: Mode;
  result: GameResult | null;
  turn: Side;
}): GameSnapshot {
  return {
    anchor: state.anchor,
    moveLog: state.moveLog,
    lastMove: state.lastMove,
    mode: state.mode,
    result: state.result,
    turn: state.turn,
  };
}

interface SetupRuntime {
  getEngine(): Chess;
  setEngine(chess: Chess): void;
  abortAiInternal(): void;
  clearExchanges(): void;
  cancelPendingCoach(): void;
  scheduleAi(): void;
  resolveGameProfiles(players: { w: Actor; b: Actor }, coach: CoachConfig, selection?: { w: string; b: string }): { w: AiProfile; b: AiProfile; coach: AiProfile };
}

/** Owns entering, editing, applying and restoring a setup session. */
export function createSetupActions(set: StoreApi<GameStore>['setState'], get: () => GameStore, runtime: SetupRuntime) {
  const { abortAiInternal, clearExchanges, cancelPendingCoach, scheduleAi, resolveGameProfiles } = runtime;
  function pushSetup(next: SetupDraft): void {
    const state = get();
    // Editing the board can strand castling rights (king or rook moved); drop
    // them here so the draft never claims a right the position cannot honour.
    const normalized = normalizeCastling(next);
    set({
      setupDraft: normalized,
      setupPast: [...state.setupPast, state.setupDraft ?? normalized].slice(-120),
      setupFuture: [],
      setupValidation: validateDraft(cloneDraft(normalized)),
    });
  }

  const actions: Pick<GameStore, 'openSetup' | 'setSetupPiece' | 'moveSetupPiece' | 'clearSetupBoard' | 'resetSetupStandard' | 'setupKingsOnly' | 'setSetupTurn' | 'toggleSetupCastling' | 'setSetupCounters' | 'loadSetupFen' | 'setupUndo' | 'setupRedo' | 'applySetup' | 'cancelSetup'> = {
    openSetup({ source, blank, fen, players: nextPlayers, orientation: nextOrientation, coach, aiSelection }) {
      if (get().mode === 'setup') return;
      abortAiInternal();
      cancelPendingCoach();
      const state = get();
      let draft: SetupDraft;
      if (source === 'new') {
        draft = blank ? emptyDraft('w') : fen ? draftFromFen(fen) : standardDraft();
      } else {
        draft = draftFromFen(runtime.getEngine().fen());
      }
      // Always remember the live game so "取消" can restore it, whatever the entry point.
      const hasLiveGame =
        state.mode === 'playing' || state.mode === 'paused' || state.mode === 'finished';
      const returnSnapshot = hasLiveGame
        ? snapshotOf({
            anchor: state.anchor,
            moveLog: state.moveLog,
            lastMove: state.lastMove,
            mode: state.mode,
            result: state.result,
            turn: state.turn,
          })
        : state.setupReturn;
      set({
        mode: 'setup',
        players: nextPlayers ?? state.players,
        orientation: nextOrientation ?? state.orientation,
        coach: coach ? { ...coach } : state.coach,
        gameProfiles: source === 'new'
          ? resolveGameProfiles(nextPlayers ?? state.players, coach ?? state.coach, aiSelection)
          : state.gameProfiles,
        setupDraft: draft,
        setupValidation: validateDraft(cloneDraft(draft)),
        setupPast: [],
        setupFuture: [],
        setupReturn: returnSnapshot,
        setupReturnSides: {
          players: state.players,
          orientation: state.orientation,
          coach: state.coach,
          gameProfiles: state.gameProfiles,
        },
        setupSource: source,
        thinking: false,
        aiTurn: null,
        aiError: null,
      });
    },

    setSetupPiece(square, piece) {
      const draft = get().setupDraft;
      if (!draft) return;
      const next = toggleSquarePiece(draft, square, piece);
      pushSetup(next);
    },

    moveSetupPiece(from, to) {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(moveDraftPiece(draft, from, to));
    },

    clearSetupBoard() {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(emptyDraft(draft.turn));
    },

    resetSetupStandard() {
      pushSetup(standardDraft());
    },

    setupKingsOnly() {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup(kingsOnlyDraft(draft.turn));
    },

    setSetupTurn(turn) {
      const draft = get().setupDraft;
      if (!draft) return;
      pushSetup({ ...cloneDraft(draft), turn, ep: null });
    },

    toggleSetupCastling(color, side) {
      const draft = get().setupDraft;
      if (!draft) return;
      if (!castlingAvailable(draft, color, side)) {
        get().notify('易位权要求王与车在初始格', 'error');
        return;
      }
      const next = cloneDraft(draft);
      next.castling[color][side] = !next.castling[color][side];
      pushSetup(next);
    },

    setSetupCounters(halfmove, moveNumber) {
      const draft = get().setupDraft;
      if (!draft) return;
      const next = cloneDraft(draft);
      next.halfmove = Number.isFinite(halfmove) ? Math.max(0, Math.floor(halfmove)) : 0;
      next.moveNumber = Number.isFinite(moveNumber) ? Math.max(1, Math.floor(moveNumber)) : 1;
      if (next.halfmove !== 0) next.ep = null;
      pushSetup(next);
    },

    loadSetupFen(fen) {
      try {
        // Validate the structural FEN first so the user gets a precise message.
        const probe = new Chess();
        probe.load(fen, { skipValidation: false });
        const draft = draftFromFen(fen);
        pushSetup(draft);
        get().notify('已载入 FEN', 'success');
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        get().notify(`FEN 无法解析：${message}`, 'error');
        return false;
      }
    },

    setupUndo() {
      const state = get();
      if (state.setupPast.length === 0 || !state.setupDraft) return;
      const previous = state.setupPast[state.setupPast.length - 1];
      set({
        setupDraft: previous,
        setupPast: state.setupPast.slice(0, -1),
        setupFuture: [state.setupDraft, ...state.setupFuture],
        setupValidation: validateDraft(cloneDraft(previous)),
      });
    },

    setupRedo() {
      const state = get();
      if (state.setupFuture.length === 0 || !state.setupDraft) return;
      const next = state.setupFuture[0];
      set({
        setupDraft: next,
        setupPast: [...state.setupPast, state.setupDraft],
        setupFuture: state.setupFuture.slice(1),
        setupValidation: validateDraft(cloneDraft(next)),
      });
    },

    applySetup() {
      const state = get();
      const draft = state.setupDraft;
      if (!draft) return false;
      const validation = validateDraft(cloneDraft(draft));
      if (!validation.ok) {
        set({ setupValidation: validation });
        get().notify(validation.errors[0] ?? '局面不合法', 'error');
        return false;
      }
      abortAiInternal();
      // The board was rearranged, so every remembered position pack is stale.
      clearExchanges();
      cancelPendingCoach();
      const fen = draftToFen(draft);
      const chess = draftToChess(draft);
      const result = gameResultOf(chess);
      const isMidgame = state.setupSource === 'midgame' && state.setupReturn !== null;
      const moveLog: MoveEntry[] = isMidgame
        ? [
            ...state.moveLog,
            {
              ply: state.moveLog.length,
              number: Math.max(1, Math.floor(draft.moveNumber)),
              color: chess.turn(),
              san: '—',
              uci: '',
              actor: 'edit',
            },
          ]
        : [];
      const anchor: Anchor = { fen, logIndex: moveLog.length };
      runtime.setEngine(chess);
      const snapshot: GameSnapshot = {
        anchor,
        moveLog,
        lastMove: null,
        mode: result ? 'finished' : 'playing',
        result,
        turn: runtime.getEngine().turn(),
      };
      set({
        mode: snapshot.mode,
        anchor,
        moveLog,
        lastMove: null,
        result,
        coachLog: [],
        coachSummary: null,
        snapshots: isMidgame ? [...state.snapshots, snapshot] : [snapshot],
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        thinking: false,
        aiTurn: null,
        aiError: null,
        fen: runtime.getEngine().fen(),
        turn: runtime.getEngine().turn(),
        version: state.version + 1,
      });
      get().notify(isMidgame ? '已按新摆放继续对局' : '已按新摆放开始对局', 'success');
      if (!isMidgame) {
        useSettings.getState().update({
          players: state.players, orientation: state.orientation, coach: state.coach,
          aiSelection: { w: state.gameProfiles.w.id, b: state.gameProfiles.b.id },
        });
      }
      scheduleAi();
      return true;
    },

    cancelSetup() {
      const state = get();
      const back = state.setupReturn;
      if (!back) {
        runtime.setEngine(new Chess(START_FEN, { skipValidation: true }));
        clearExchanges();
        set({
          mode: 'idle',
          players: state.setupReturnSides?.players ?? state.players,
          orientation: state.setupReturnSides?.orientation ?? state.orientation,
          coach: state.setupReturnSides?.coach ?? state.coach,
          gameProfiles: state.setupReturnSides?.gameProfiles ?? state.gameProfiles,
          anchor: { fen: START_FEN, logIndex: 0 },
          moveLog: [],
          lastMove: null,
          result: null,
          snapshots: [
            {
              anchor: { fen: START_FEN, logIndex: 0 },
              moveLog: [],
              lastMove: null,
              mode: 'idle',
              result: null,
              turn: 'w',
            },
          ],
          setupDraft: null,
          setupValidation: null,
          setupPast: [],
          setupFuture: [],
          setupReturn: null,
          setupReturnSides: null,
          setupSource: null,
          fen: START_FEN,
          turn: 'w',
          version: state.version + 1,
        });
        return;
      }
      runtime.setEngine(buildChess(back.anchor, back.moveLog));
      set({
        mode: back.mode,
        players: state.setupReturnSides?.players ?? state.players,
        orientation: state.setupReturnSides?.orientation ?? state.orientation,
        coach: state.setupReturnSides?.coach ?? state.coach,
        gameProfiles: state.setupReturnSides?.gameProfiles ?? state.gameProfiles,
        anchor: back.anchor,
        moveLog: back.moveLog,
        lastMove: back.lastMove,
        result: back.result,
        setupDraft: null,
        setupValidation: null,
        setupPast: [],
        setupFuture: [],
        setupReturn: null,
        setupReturnSides: null,
        setupSource: null,
        fen: runtime.getEngine().fen(),
        turn: runtime.getEngine().turn(),
        version: state.version + 1,
      });
      scheduleAi();
    },

  };
  return actions;
}
