import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { Side } from '../../game/types';
import type { DraftPiece } from '../../game/setup';
import { BOARD_SQUARES, squareIndex } from '../../game/setup';
import { Piece } from './Piece';

export const PIECE_DRAG_MIME = 'application/x-chessmind-piece';

/** Duration of the piece slide, in ms. */
const SLIDE_MS = 240;

export interface BoardViewProps {
  squares: (DraftPiece | null)[];
  orientation: Side;
  boardTheme: string;
  showCoordinates: boolean;
  editing: boolean;
  selected: string | null;
  targets: { square: string; capture: boolean }[];
  lastMove: { from: string; to: string } | null;
  /** Bumped only when a move is actually played, so the slide animation runs once. */
  moveSeq: number;
  checkSquare: string | null;
  interactive: boolean;
  onSquareClick?(square: string): void;
  /** Returns true when the move was actually applied (used to skip slide playback). */
  onPieceDrop?(from: string, to: string): boolean | void;
  onSquareRightClick?(square: string): void;
  onExternalDrop?(square: string, piece: DraftPiece): void;
  /** Fired when a piece is picked up for dragging, so hints can appear. */
  onPickUp?(square: string): void;
  overlay?: ReactNode;
}

export function Board({
  squares,
  orientation,
  boardTheme,
  showCoordinates,
  editing,
  selected,
  targets,
  lastMove,
  moveSeq,
  checkSquare,
  interactive,
  onSquareClick,
  onPieceDrop,
  onSquareRightClick,
  onExternalDrop,
  onPickUp,
  overlay,
}: BoardViewProps) {
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  /** Keyboard cursor, as an index into the visual `order`. */
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  /** Last move sequence that has already been animated. */
  const animatedSeq = useRef(0);
  /** In-flight piece slide animations, keyed by the element they run on. */
  const slides = useRef(new Map<HTMLElement, Animation>());
  /**
   * The last move the user completed by dragging. The drag ghost already
   * travelled from origin to destination, so replaying the slide would make the
   * piece jump back and move again.
   */
  const draggedMove = useRef<{ from: string; to: string } | null>(null);

  const cancelSlides = () => {
    for (const [element, animation] of slides.current) {
      animation.cancel();
      delete element.dataset.sliding;
    }
    slides.current.clear();
  };

  const order = useMemo(() => {
    const indices: number[] = [];
    for (let r = 0; r < 8; r += 1) {
      for (let f = 0; f < 8; f += 1) indices.push(r * 8 + f);
    }
    if (orientation === 'b') indices.reverse();
    return indices;
  }, [orientation]);

  const targetMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const target of targets) map.set(target.square, target.capture);
    return map;
  }, [targets]);

  /**
   * Slide the just-moved piece from its old square to its new one.
   *
   * The board re-renders with every piece already standing on its destination,
   * so a move otherwise reads as "one piece vanished, another appeared" — easy
   * to miss, especially when the AI moves. Here we measure how far the piece
   * travelled and run a short Web Animations slide from the origin to its home,
   * so the motion is visible without touching the piece's resting styles.
   *
   * A castling move also moves the rook, which chess.js reports only as the
   * king's squares, so we add that leg by hand.
   */
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    // A new move can land while the previous slide is still in flight: cancel
    // whatever is still running so nothing fights over the same piece.
    cancelSlides();

    if (editing) {
      // A drag while rearranging pieces is not a game move; forget it.
      draggedMove.current = null;
      return;
    }
    if (!lastMove || moveSeq <= 0) return;
    if (moveSeq === animatedSeq.current) return;
    animatedSeq.current = moveSeq;

    // A drag already showed the piece travelling; do not replay it.
    const dragged = draggedMove.current;
    draggedMove.current = null;
    if (dragged && dragged.from === lastMove.from && dragged.to === lastMove.to) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const legs = [{ from: lastMove.from, to: lastMove.to }];
    if (squares[squareIndex(lastMove.to)]?.type === 'k') {
      const delta = lastMove.to.charCodeAt(0) - lastMove.from.charCodeAt(0);
      if (Math.abs(delta) === 2) {
        const rank = lastMove.to[1];
        legs.push({
          from: `${delta > 0 ? 'h' : 'a'}${rank}`,
          to: `${delta > 0 ? 'f' : 'd'}${rank}`,
        });
      }
    }

    for (const leg of legs) {
      const fromCell = board.querySelector<HTMLElement>(`[data-square="${leg.from}"]`);
      const toCell = board.querySelector<HTMLElement>(`[data-square="${leg.to}"]`);
      const piece = toCell?.querySelector<HTMLElement>('.sq-piece');
      if (!fromCell || !toCell || !piece) continue;
      const a = fromCell.getBoundingClientRect();
      const b = toCell.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (dx === 0 && dy === 0) continue;

      piece.dataset.sliding = 'true';
      const animation = piece.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0px, 0px)' },
        ],
        { duration: SLIDE_MS, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'both' },
      );
      slides.current.set(piece, animation);
      animation.addEventListener('finish', () => {
        animation.cancel();
        delete piece.dataset.sliding;
        slides.current.delete(piece);
      });
    }
  }, [editing, lastMove, moveSeq, orientation, squares]);

  // Drop any in-flight slides when the board goes away mid-move.
  useLayoutEffect(() => () => cancelSlides(), []);

  const handleDrop = (event: DragEvent<HTMLDivElement>, square: string) => {
    event.preventDefault();
    setDragOver(null);
    const from = dragFrom;
    setDragFrom(null);
    const external = event.dataTransfer.getData(PIECE_DRAG_MIME);
    if (external) {
      try {
        const piece = JSON.parse(external) as DraftPiece;
        if (piece && piece.type && piece.color) onExternalDrop?.(square, piece);
      } catch {
        // ignore malformed drag payloads
      }
      return;
    }
    const fromSquare = from || event.dataTransfer.getData('text/plain');
    if (fromSquare && fromSquare !== square) {
      // Only remember it when the move really landed, so a rejected drop still
      // gets its slide (e.g. a drag the rules refuse leaves the piece in place).
      if (onPieceDrop?.(fromSquare, square) !== false) {
        draggedMove.current = { from: fromSquare, to: square };
      }
    }
  };

  return (
    <div className="board-shell">
      <div
        ref={boardRef}
        className={`board${editing ? ' board--editing' : ''}${interactive ? ' board--interactive' : ''}`}
        data-board={boardTheme}
        style={{ width: '100%', aspectRatio: '1 / 1' }}
        role="grid"
        aria-label="棋盘"
        tabIndex={interactive ? 0 : -1}
        onFocus={() => setFocusIndex((current) => current ?? 0)}
        onBlur={() => setFocusIndex(null)}
        onKeyDown={(event) => {
          if (!interactive || focusIndex === null) return;
          const step = (delta: number) => {
            event.preventDefault();
            setFocusIndex(Math.min(order.length - 1, Math.max(0, focusIndex + delta)));
          };
          if (event.key === 'ArrowLeft') step(-1);
          else if (event.key === 'ArrowRight') step(1);
          else if (event.key === 'ArrowUp') step(-8);
          else if (event.key === 'ArrowDown') step(8);
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onSquareClick?.(BOARD_SQUARES[order[focusIndex]]);
          }
        }}
      >
        {order.map((index) => {
          const square = BOARD_SQUARES[index];
          const file = square[0];
          const rank = square[1];
          const piece = squares[index];
          const isLight = (index + Math.floor(index / 8)) % 2 === 0;
          const isTarget = targetMap.has(square);
          const isCapture = targetMap.get(square) === true;
          const isSelected = selected === square;
          const isFrom = lastMove?.from === square;
          const isTo = lastMove?.to === square;
          const isCheck = checkSquare === square;
          const showFile = showCoordinates && (orientation === 'w' ? rank === '1' : rank === '8');
          const showRank = showCoordinates && (orientation === 'w' ? file === 'a' : file === 'h');
          return (
            <div
              key={square}
              className={[
                'sq',
                isLight ? 'sq--light' : 'sq--dark',
                isFrom ? 'sq--last-from' : '',
                isTo ? 'sq--last-to' : '',
                isSelected ? 'sq--selected' : '',
                isCheck ? 'sq--check' : '',
                isTarget && !isCapture ? 'sq--target' : '',
                isCapture ? 'sq--capture' : '',
                dragOver === square ? 'sq--drop' : '',
                focusIndex !== null && order[focusIndex] === index ? 'sq--focus' : '',
                editing ? 'sq--editing' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-square={square}
              role="gridcell"
              aria-label={`${square}${piece ? ` ${piece.color === 'w' ? '白' : '黑'}${piece.type}` : ''}`}              onClick={() => onSquareClick?.(square)}
              onContextMenu={(event) => {
                if (!editing) return;
                event.preventDefault();
                onSquareRightClick?.(square);
              }}
              onDragOver={(event) => {
                if (!interactive) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragOver !== square) setDragOver(square);
              }}
              onDragLeave={() => setDragOver((current) => (current === square ? null : current))}
              onDrop={(event) => {
                if (!interactive) return;
                handleDrop(event, square);
              }}
            >
              {showFile && <span className="sq-coord sq-coord--file">{file}</span>}
              {showRank && <span className="sq-coord sq-coord--rank">{rank}</span>}
              {piece && (
                <div
                  className="sq-piece"
                  data-dragging={dragFrom === square}
                  draggable={interactive}
                  onDragStart={(event) => {
                    if (!interactive) {
                      event.preventDefault();
                      return;
                    }
                    setDragFrom(square);
                    onPickUp?.(square);
                    event.dataTransfer.setData('text/plain', square);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                >
                  <Piece type={piece.type} color={piece.color} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {overlay}
    </div>
  );
}
