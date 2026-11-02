import { Chess, type Move } from 'chess.js';
import type { Anchor, GameResult, MoveEntry, Side, SquareRef } from './types';

export { PIECE_NAMES, PIECE_VALUES, materialOf } from './material';

export function uciOf(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function parseUci(uci: string): SquareRef | null {
  const cleaned = uci.trim().toLowerCase().replace(/[\s\-_]/g, '');
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(cleaned);
  if (!match) return null;
  return { from: match[1], to: match[2], promotion: match[3] };
}

/** Rebuild the live engine from an anchor FEN plus the moves played after it. */
export function buildChess(anchor: Anchor, log: MoveEntry[]): Chess {
  const chess = new Chess(anchor.fen, { skipValidation: true });
  for (const entry of log.slice(anchor.logIndex)) {
    if (entry.actor === 'edit') continue;
    const ref = parseUci(entry.uci);
    if (!ref) continue;
    try {
      chess.move({ from: ref.from, to: ref.to, promotion: ref.promotion });
    } catch {
      // A corrupt log entry must never take the app down.
    }
  }
  return chess;
}

export function legalMoves(chess: Chess): Move[] {
  return chess.moves({ verbose: true }) as Move[];
}

export function findLegalMove(chess: Chess, ref: SquareRef): Move | null {
  const moves = legalMoves(chess);
  const candidates = moves.filter((m) => m.from === ref.from && m.to === ref.to);
  if (candidates.length === 0) return null;
  if (ref.promotion) {
    const exact = candidates.find((m) => m.promotion === ref.promotion);
    return exact ?? null;
  }
  const queen = candidates.find((m) => m.promotion === 'q');
  return queen ?? candidates[0];
}

export function gameResultOf(chess: Chess): GameResult | null {
  if (chess.isCheckmate()) {
    const winner: Side = chess.turn() === 'w' ? 'b' : 'w';
    return {
      winner,
      reason: 'checkmate',
      text: `${winner === 'w' ? '白方' : '黑方'}将杀获胜`,
    };
  }
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate', text: '逼和，和棋' };
  if (chess.isInsufficientMaterial())
    return { winner: null, reason: 'insufficient', text: '子力不足，和棋' };
  if (chess.isThreefoldRepetition())
    return { winner: null, reason: 'threefold', text: '三次重复局面，和棋' };
  if (chess.isDrawByFiftyMoves())
    return { winner: null, reason: 'fifty', text: '五十回合规则，和棋' };
  if (chess.isDraw()) return { winner: null, reason: 'stalemate', text: '和棋' };
  return null;
}

export function boardToAscii(chess: Chess): string {
  const rows: string[] = [];
  const board = chess.board();
  rows.push('    a b c d e f g h');
  for (let i = 0; i < 8; i += 1) {
    const rank = 8 - i;
    const cells = board[i]
      .map((cell) => {
        if (!cell) return '.';
        const letter = cell.type;
        return cell.color === 'w' ? letter.toUpperCase() : letter;
      })
      .join(' ');
    rows.push(`${rank}   ${cells}   ${rank}`);
  }
  rows.push('    a b c d e f g h');
  return rows.join('\n');
}

export function moveLogToSan(log: MoveEntry[], fromIndex = 0): string {
  const entries = log.slice(fromIndex).filter((e) => e.actor !== 'edit');
  if (entries.length === 0) return '(no moves yet)';
  const parts: string[] = [];
  let pending: string | null = null;
  let pendingNumber = 0;

  for (const entry of entries) {
    if (entry.color === 'w') {
      if (pending !== null) parts.push(pending);
      pending = `${entry.number}. ${entry.san}`;
      pendingNumber = entry.number;
    } else if (pending !== null && pendingNumber === entry.number) {
      pending = `${pending} ${entry.san}`;
      parts.push(pending);
      pending = null;
    } else {
      if (pending !== null) parts.push(pending);
      pending = `${entry.number}... ${entry.san}`;
      parts.push(pending);
      pending = null;
    }
  }
  if (pending !== null) parts.push(pending);
  return parts.join(' ');
}

export function sideNameZh(side: Side): string {
  return side === 'w' ? '白方' : '黑方';
}
