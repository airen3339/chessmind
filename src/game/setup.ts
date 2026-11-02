import { Chess, SQUARES, type PieceSymbol, type Square } from 'chess.js';
import type { Side } from './types';

export interface DraftPiece {
  type: PieceSymbol;
  color: Side;
}

/** A free-form position used by the setup editor. Index 0 = a8, index 63 = h1. */
export interface SetupDraft {
  squares: (DraftPiece | null)[];
  turn: Side;
  castling: { w: { k: boolean; q: boolean }; b: { k: boolean; q: boolean } };
  ep: string | null;
  halfmove: number;
  moveNumber: number;
}

export const BOARD_SQUARES = SQUARES as string[];

export function squareIndex(square: string): number {
  return BOARD_SQUARES.indexOf(square);
}

export function indexSquare(index: number): string {
  return BOARD_SQUARES[index];
}

/** Parse only the piece-placement field of a FEN into a 64-cell array. */
export function boardFromFen(fen: string): (DraftPiece | null)[] {
  const squares: (DraftPiece | null)[] = new Array(64).fill(null);
  const rows = (fen.split(' ')[0] ?? '').split('/');
  for (let r = 0; r < 8; r += 1) {
    let file = 0;
    for (const char of rows[r] ?? '') {
      if (char >= '1' && char <= '8') {
        file += Number.parseInt(char, 10);
        continue;
      }
      if (file < 8 && /[prnbqkPRNBQK]/.test(char)) {
        squares[r * 8 + file] = {
          type: char.toLowerCase() as PieceSymbol,
          color: char === char.toUpperCase() ? 'w' : 'b',
        };
      }
      file += 1;
    }
  }
  return squares;
}

export function emptyDraft(turn: Side = 'w'): SetupDraft {
  return {
    squares: new Array<DraftPiece | null>(64).fill(null),
    turn,
    castling: { w: { k: false, q: false }, b: { k: false, q: false } },
    ep: null,
    halfmove: 0,
    moveNumber: 1,
  };
}

export function standardDraft(): SetupDraft {
  return draftFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
}

export function kingsOnlyDraft(turn: Side = 'w'): SetupDraft {
  const draft = emptyDraft(turn);
  draft.squares[squareIndex('e1')] = { type: 'k', color: 'w' };
  draft.squares[squareIndex('e8')] = { type: 'k', color: 'b' };
  return draft;
}

export function cloneDraft(draft: SetupDraft): SetupDraft {
  return {
    squares: draft.squares.map((p) => (p ? { ...p } : null)),
    turn: draft.turn,
    castling: {
      w: { ...draft.castling.w },
      b: { ...draft.castling.b },
    },
    ep: draft.ep,
    halfmove: draft.halfmove,
    moveNumber: draft.moveNumber,
  };
}

export function draftFromFen(fen: string): SetupDraft {
  const draft = emptyDraft('w');
  let tokens: string[];
  try {
    const chess = new Chess(fen, { skipValidation: true });
    // Keep the supplied EP target so validation can report an inconsistent
    // target instead of silently accepting a normalised engine position.
    tokens = fen.trim().split(/\s+/);
    const board = chess.board();
    for (let r = 0; r < 8; r += 1) {
      for (let f = 0; f < 8; f += 1) {
        const cell = board[r][f];
        if (!cell) continue;
        draft.squares[r * 8 + f] = { type: cell.type, color: cell.color };
      }
    }
  } catch {
    return draft;
  }
  draft.turn = tokens[1] === 'b' ? 'b' : 'w';
  const rights = tokens[2] ?? '-';
  draft.castling = {
    w: { k: rights.includes('K'), q: rights.includes('Q') },
    b: { k: rights.includes('k'), q: rights.includes('q') },
  };
  draft.ep = tokens[3] && tokens[3] !== '-' ? tokens[3] : null;
  draft.halfmove = Number.parseInt(tokens[4] ?? '0', 10) || 0;
  draft.moveNumber = Number.parseInt(tokens[5] ?? '1', 10) || 1;
  return normalizeCastling(draft);
}

export function draftToFen(draft: SetupDraft): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r += 1) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f += 1) {
      const piece = draft.squares[r * 8 + f];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      const letter = piece.type;
      row += piece.color === 'w' ? letter.toUpperCase() : letter;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  let rights = '';
  if (draft.castling.w.k) rights += 'K';
  if (draft.castling.w.q) rights += 'Q';
  if (draft.castling.b.k) rights += 'k';
  if (draft.castling.b.q) rights += 'q';
  if (!rights) rights = '-';
  return [
    rows.join('/'),
    draft.turn,
    rights,
    draft.ep ?? '-',
    String(Math.max(0, Math.floor(draft.halfmove))),
    String(Math.max(1, Math.floor(draft.moveNumber))),
  ].join(' ');
}

export function findKing(draft: SetupDraft, color: Side): number {
  return draft.squares.findIndex((p) => p && p.type === 'k' && p.color === color);
}

export function countPieces(draft: SetupDraft): { w: number; b: number } {
  let w = 0;
  let b = 0;
  for (const piece of draft.squares) {
    if (!piece) continue;
    if (piece.color === 'w') w += 1;
    else b += 1;
  }
  return { w, b };
}

function kingsAdjacent(draft: SetupDraft): boolean {
  const w = findKing(draft, 'w');
  const b = findKing(draft, 'b');
  if (w < 0 || b < 0) return false;
  const wf = w % 8;
  const wRank = Math.floor(w / 8);
  const bf = b % 8;
  const bRank = Math.floor(b / 8);
  return Math.abs(wf - bf) <= 1 && Math.abs(wRank - bRank) <= 1;
}

export interface DraftValidation {
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/** A target is possible only immediately after the opposite pawn's double push. */
export function validEnPassant(draft: SetupDraft): boolean {
  if (draft.ep === null) return true;
  const rank = draft.turn === 'w' ? '6' : '3';
  if (!new RegExp(`^[a-h]${rank}$`).test(draft.ep) || draft.halfmove !== 0) return false;
  const file = draft.ep[0];
  const pawn = draft.squares[squareIndex(`${file}${draft.turn === 'w' ? '5' : '4'}`)];
  const origin = draft.squares[squareIndex(`${file}${draft.turn === 'w' ? '7' : '2'}`)];
  return !draft.squares[squareIndex(draft.ep)] && !origin &&
    pawn?.type === 'p' && pawn.color !== draft.turn;
}

/** Structural + semantic validation that chess.js's validateFen does not cover. */
export function validateDraft(draft: SetupDraft): DraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const whiteKings = draft.squares.filter((p) => p && p.type === 'k' && p.color === 'w').length;
  const blackKings = draft.squares.filter((p) => p && p.type === 'k' && p.color === 'b').length;

  if (whiteKings !== 1) errors.push(whiteKings === 0 ? '缺少白方国王' : '白方有多个国王');
  if (blackKings !== 1) errors.push(blackKings === 0 ? '缺少黑方国王' : '黑方有多个国王');

  for (let i = 0; i < 64; i += 1) {
    const piece = draft.squares[i];
    if (!piece || piece.type !== 'p') continue;
    const rank = 8 - Math.floor(i / 8);
    if (rank === 1 || rank === 8) {
      errors.push(`兵不能放在第 ${rank} 横线（${indexSquare(i)}）`);
    }
  }

  if (kingsAdjacent(draft)) errors.push('双方国王不能相邻');

  if (whiteKings === 1 && blackKings === 1) {
    if (!validEnPassant(draft)) errors.push('吃过路兵格与行棋方、兵的位置或半回合钟不符');
    // chess.js cannot compute moves for structurally impossible boards (e.g. a
    // pawn on the back rank), so only probe the engine once the board is sane.
    if (errors.length === 0) {
      try {
        const chess = draftToChess(draft, { applyCastling: false });
        const waiting: Side = draft.turn === 'w' ? 'b' : 'w';
        const waitingKing = findKing(draft, waiting);
        if (waitingKing >= 0 && chess.isAttacked(indexSquare(waitingKing) as Square, draft.turn)) {
          errors.push(
            `${waiting === 'w' ? '白方' : '黑方'}未行棋却被将军：该局面不可能出现（上一手不能把自己的王留在被将军状态）`,
          );
        }
        if (errors.length === 0 && chess.moves().length === 0) {
          warnings.push('当前行棋方没有任何合法着法：开始对局后会立即判负/和棋');
        }
      } catch {
        errors.push('该局面无法被规则引擎解析，请检查棋子摆放');
      }
    }
  }

  for (const color of ['w', 'b'] as Side[]) {
    for (const side of ['k', 'q'] as const) {
      if (draft.castling[color][side] && !castlingAvailable(draft, color, side)) {
        warnings.push(
          `${color === 'w' ? '白方' : '黑方'}${side === 'k' ? '王翼' : '后翼'}易位权无效：王与车必须在初始格，已自动取消`,
        );
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** Castling is only possible when the king and the matching rook stand on their original squares. */
export function castlingAvailable(draft: SetupDraft, color: Side, side: 'k' | 'q'): boolean {
  const king = findKing(draft, color);
  if (king < 0) return false;
  const kingSquare = indexSquare(king);
  const expectedKing = color === 'w' ? 'e1' : 'e8';
  if (kingSquare !== expectedKing) return false;
  const rookSquare = color === 'w' ? (side === 'k' ? 'h1' : 'a1') : side === 'k' ? 'h8' : 'a8';
  const rook = draft.squares[squareIndex(rookSquare)];
  return Boolean(rook && rook.type === 'r' && rook.color === color);
}

/**
 * Drop castling rights that the current placement cannot honour. Keeping them
 * in the draft while warning "已自动取消" produced a mismatch: the FEN still
 * carried the right and chess.js silently stripped it later.
 */
export function normalizeCastling(draft: SetupDraft): SetupDraft {
  let changed = false;
  const next = cloneDraft(draft);
  for (const color of ['w', 'b'] as Side[]) {
    for (const side of ['k', 'q'] as const) {
      if (next.castling[color][side] && !castlingAvailable(next, color, side)) {
        next.castling[color][side] = false;
        changed = true;
      }
    }
  }
  return changed ? next : draft;
}

/** Build a playable engine from the draft. Throws when the draft is not playable. */
export function draftToChess(draft: SetupDraft, opts: { applyCastling?: boolean } = {}): Chess {
  const fen = draftToFen(draft);
  const chess = new Chess(fen, { skipValidation: true });
  if (opts.applyCastling !== false) {
    chess.setCastlingRights('w', { k: draft.castling.w.k, q: draft.castling.w.q });
    chess.setCastlingRights('b', { k: draft.castling.b.k, q: draft.castling.b.q });
  }
  return chess;
}

export function toggleSquarePiece(
  draft: SetupDraft,
  square: string,
  piece: DraftPiece | null,
): SetupDraft {
  const next = cloneDraft(draft);
  const idx = squareIndex(square);
  if (idx < 0) return draft;
  next.squares[idx] = piece ? { ...piece } : null;
  next.ep = null;
  return next;
}

export function moveDraftPiece(draft: SetupDraft, from: string, to: string): SetupDraft {
  const fromIdx = squareIndex(from);
  const toIdx = squareIndex(to);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return draft;
  const next = cloneDraft(draft);
  const piece = next.squares[fromIdx];
  if (!piece) return draft;
  next.squares[toIdx] = piece;
  next.squares[fromIdx] = null;
  next.ep = null;
  return next;
}
