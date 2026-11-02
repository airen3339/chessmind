import { useEffect, useMemo, useState } from 'react';
import type { PieceSymbol } from 'chess.js';
import type { Move } from 'chess.js';
import { Lightbulb } from 'lucide-react';
import { useEditor } from '../editorTool';
import { legalMoves } from '../game/engine';
import { boardFromFen, squareIndex } from '../game/setup';
import { getEngine, useGame } from '../game/store';
import type { Side } from '../game/types';
import { useSettings } from '../settings';
import { Board } from './board/Board';
import { PieceGlyph } from './board/PieceGlyph';

interface PromotionState {
  from: string;
  to: string;
  color: Side;
}

export function BoardArea() {
  const mode = useGame((s) => s.mode);
  const fen = useGame((s) => s.fen);
  const turn = useGame((s) => s.turn);
  const players = useGame((s) => s.players);
  const orientation = useGame((s) => s.orientation);
  const lastMove = useGame((s) => s.lastMove);
  const moveSeq = useGame((s) => s.moveSeq);
  const thinking = useGame((s) => s.thinking);
  const setupDraft = useGame((s) => s.setupDraft);
  const humanMove = useGame((s) => s.humanMove);
  const setSetupPiece = useGame((s) => s.setSetupPiece);
  const moveSetupPiece = useGame((s) => s.moveSetupPiece);
  const ui = useSettings((s) => s.settings.ui);
  const coach = useGame((s) => s.coach);
  const askHint = useGame((s) => s.askHint);
  const hintBusy = useGame((s) => s.hintBusy);
  const coachLog = useGame((s) => s.coachLog);
  const playedMoves = useGame(
    (s) => s.moveLog.length,
  );
  const tool = useEditor((s) => s.tool);
  const paintPiece = useEditor((s) => s.piece);

  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<PromotionState | null>(null);

  const editing = mode === 'setup';
  const squares = useMemo(
    () => (editing && setupDraft ? setupDraft.squares : boardFromFen(fen)),
    [editing, setupDraft, fen],
  );

  const legal = useMemo(() => {
    if (editing) return [] as Move[];
    try {
      return legalMoves(getEngine());
    } catch {
      return [] as Move[];
    }
  }, [editing, fen, turn]);

  const targets = useMemo(() => {
    if (!selected || editing) return [];
    return legal
      .filter((move) => move.from === selected)
      .map((move) => ({ square: move.to, capture: Boolean(move.captured) }));
  }, [legal, selected, editing]);

  const checkSquare = useMemo(() => {
    if (editing) return null;
    try {
      const engine = getEngine();
      if (!engine.isCheck()) return null;
      for (const row of engine.board()) {
        for (const cell of row) {
          if (cell && cell.type === 'k' && cell.color === engine.turn()) return cell.square;
        }
      }
    } catch {
      return null;
    }
    return null;
  }, [editing, fen, turn]);

  useEffect(() => {
    if (mode !== 'playing') {
      setSelected(null);
      setPromotion(null);
    }
  }, [mode]);

  useEffect(() => {
    if (!selected || editing) return;
    const piece = squares[squareIndex(selected)];
    if (!piece || piece.color !== turn) setSelected(null);
  }, [fen, turn, selected, squares, editing]);

  const humanCanMove = !editing && mode === 'playing' && players[turn] === 'human' && !thinking;

  const canAskHint = humanCanMove && coach.enabled && coach.hint;
  /** The suggestion for the position currently on the board, if one was asked for. */
  const hint = useMemo(() => {
    for (let i = coachLog.length - 1; i >= 0; i -= 1) {
      const entry = coachLog[i];
      if (entry.kind === 'hint' && entry.ply === playedMoves) return entry;
    }
    return null;
  }, [coachLog, playedMoves]);

  /**
   * `applied` — the move is on the board; `pending` — a promotion choice is
   * open and the move will land later; `false` — not a legal move.
   */
  const tryMove = (from: string, to: string): 'applied' | 'pending' | false => {
    const candidates = legal.filter((move) => move.from === from && move.to === to);
    if (candidates.length === 0) return false;
    if (candidates.some((move) => move.promotion)) {
      const piece = squares[squareIndex(from)];
      setPromotion({ from, to, color: piece?.color ?? turn });
      return 'pending';
    }
    const ok = humanMove(from, to);
    if (ok) setSelected(null);
    return ok ? 'applied' : false;
  };

  const handleSquareClick = (square: string) => {
    if (editing) {
      const piece = squares[squareIndex(square)];
      if (tool === 'erase') {
        if (piece) setSetupPiece(square, null);
        return;
      }
      if (selected) {
        if (selected === square) {
          setSelected(null);
          return;
        }
        moveSetupPiece(selected, square);
        setSelected(null);
        return;
      }
      if (piece) {
        setSelected(square);
        return;
      }
      if (paintPiece) setSetupPiece(square, paintPiece);
      return;
    }
    if (!humanCanMove) return;
    const piece = squares[squareIndex(square)];
    if (selected) {
      if (square === selected) {
        setSelected(null);
        return;
      }
      if (tryMove(selected, square)) return;
      if (piece && piece.color === turn) {
        setSelected(square);
        return;
      }
      setSelected(null);
      return;
    }
    if (piece && piece.color === turn) setSelected(square);
  };

  const handleDrop = (from: string, to: string): boolean => {
    if (editing) {
      moveSetupPiece(from, to);
      return true;
    }
    if (!humanCanMove) return false;
    // A promotion still has to be picked, so the piece has not actually landed
    // yet — report "not applied" and let the slide play once it does.
    return tryMove(from, to) === 'applied';
  };

  const handleExternalDrop = (square: string, piece: { type: PieceSymbol; color: Side }) => {
    if (!editing) return;
    setSetupPiece(square, { type: piece.type, color: piece.color });
  };

  const handleRightClick = (square: string) => {
    if (!editing) return;
    if (squares[squareIndex(square)]) setSetupPiece(square, null);
  };

  const overlay = (
    <>
      <div className="board-overlay" data-visible={thinking ? 'true' : 'false'}>
        <div className="board-overlay-card">
          <span className="spinner" />
          {turn === 'w' ? '白方' : '黑方'} AI 正在思考…
        </div>
      </div>
      {promotion && (
        <div className="promo-backdrop" onClick={() => setPromotion(null)}>
          <div className="promo-card" onClick={(event) => event.stopPropagation()}>
            <div className="promo-title">选择升变棋子</div>
            <div className="promo-options">
              {(['q', 'r', 'b', 'n'] as PieceSymbol[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  className="promo-option"
                  onClick={() => {
                    humanMove(promotion.from, promotion.to, type);
                    setPromotion(null);
                    setSelected(null);
                  }}
                >
                  <PieceGlyph type={type} color={promotion.color} size={40} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      <div className="board-card">
        <Board
          squares={squares}
          orientation={orientation}
          boardTheme={ui.boardTheme}
          showCoordinates={ui.showCoordinates}
          editing={editing}
          selected={selected}
          targets={targets}
          lastMove={editing ? null : lastMove}
          moveSeq={editing ? 0 : moveSeq}
          checkSquare={checkSquare}
          interactive={editing || humanCanMove}
          onSquareClick={handleSquareClick}
          onPieceDrop={handleDrop}
          onSquareRightClick={handleRightClick}
          onExternalDrop={handleExternalDrop}
          onPickUp={(square) => {
            if (!humanCanMove) return;
            const piece = squares[squareIndex(square)];
            if (piece && piece.color === turn) setSelected(square);
          }}
          overlay={overlay}
        />
      </div>

      {canAskHint && (
        <div className="hint-bar">
          <div className="hint-row">
            <button
              type="button"
              className="btn btn--sm"
              onClick={askHint}
              disabled={hintBusy}
              title="让教练给一手推荐（快捷键 H）"
            >
              {hintBusy ? <span className="spinner" /> : <Lightbulb size={13} />}
              {hintBusy ? '请教中…' : hint ? '再问一次' : '请求指导'}
            </button>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {hintBusy
                ? '教练正在看这个局面…'
                : '教练的推荐只是参考，走棋还是你来。'}
            </span>
          </div>
          {hint && (
            <div
              className="hint-card"
              data-error={hint.error ? 'true' : undefined}
              data-pending={hint.pending ? 'true' : undefined}
            >
              {hint.pending ? (
                <span className="hint-why">
                  <span className="spinner" style={{ marginRight: 7 }} />
                  教练正在看这个局面…
                </span>
              ) : hint.error ? (
                <span className="hint-why">教练没能给出建议：{hint.error}</span>
              ) : hint.san ? (
                <>
                  <span className="hint-move">{hint.san}</span>
                  <span className="hint-why">{hint.verdict || '教练没有说明理由。'}</span>
                </>
              ) : (
                <span className="hint-why">教练没有给出合法的推荐着法。</span>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
