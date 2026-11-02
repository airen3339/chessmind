import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  boardToAscii,
  buildChess,
  findLegalMove,
  gameResultOf,
  legalMoves,
  moveLogToSan,
  parseUci,
  uciOf,
} from '../src/game/engine';
import { materialOf } from '../src/game/material';
import type { Anchor, MoveEntry } from '../src/game/types';

describe('uci helpers', () => {
  it('parses coordinate notation with and without promotion', () => {
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
    expect(parseUci('a7a8q')).toEqual({ from: 'a7', to: 'a8', promotion: 'q' });
    expect(parseUci('E2-E4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
    expect(parseUci('nonsense')).toBeNull();
  });

  it('round-trips a move through uci', () => {
    const chess = new Chess();
    const move = findLegalMove(chess, { from: 'g1', to: 'f3' });
    expect(move).not.toBeNull();
    if (move) expect(uciOf(move)).toBe('g1f3');
  });
});

describe('legal move lookup', () => {
  it('rejects a move that is not legal', () => {
    const chess = new Chess();
    expect(findLegalMove(chess, { from: 'e2', to: 'e5' })).toBeNull();
    expect(findLegalMove(chess, { from: 'a1', to: 'a3' })).toBeNull();
  });

  it('defaults a promotion to a queen and honours an explicit choice', () => {
    const chess = new Chess('8/P7/8/8/8/8/8/K6k w - - 0 1');
    const queen = findLegalMove(chess, { from: 'a7', to: 'a8' });
    expect(queen?.promotion).toBe('q');
    const knight = findLegalMove(chess, { from: 'a7', to: 'a8', promotion: 'n' });
    expect(knight?.promotion).toBe('n');
  });
});

describe('game result detection', () => {
  it('detects checkmate and names the winner', () => {
    const chess = new Chess();
    chess.move('f3');
    chess.move('e5');
    chess.move('g4');
    chess.move('Qh4');
    const result = gameResultOf(chess);
    expect(result?.reason).toBe('checkmate');
    expect(result?.winner).toBe('b');
  });

  it('detects stalemate', () => {
    const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(gameResultOf(chess)?.reason).toBe('stalemate');
  });

  it('detects insufficient material', () => {
    const chess = new Chess('8/8/8/4k3/8/8/8/4K3 w - - 0 1');
    expect(gameResultOf(chess)?.reason).toBe('insufficient');
  });

  it('returns null for a live position', () => {
    expect(gameResultOf(new Chess())).toBeNull();
  });
});

describe('ascii board', () => {
  it('draws ranks, files and both colours', () => {
    const ascii = boardToAscii(new Chess());
    expect(ascii).toContain('a b c d e f g h');
    expect(ascii).toContain('r n b q k b n r');
    expect(ascii).toContain('R N B Q K B N R');
    expect(ascii.trim().split('\n')).toHaveLength(10);
  });
});

describe('anchor + log replay', () => {
  it('rebuilds the position from an anchor plus moves', () => {
    const anchor: Anchor = { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', logIndex: 0 };
    const log: MoveEntry[] = [
      { ply: 0, number: 1, color: 'w', san: 'e4', uci: 'e2e4', actor: 'human' },
      { ply: 1, number: 1, color: 'b', san: 'e5', uci: 'e7e5', actor: 'ai' },
    ];
    const chess = buildChess(anchor, log);
    expect(chess.fen()).toBe(
      'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    );
  });

  it('ignores an edit marker and starts from the anchor', () => {
    const anchor: Anchor = { fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', logIndex: 1 };
    const log: MoveEntry[] = [
      { ply: 0, number: 1, color: 'w', san: 'e4', uci: 'e2e4', actor: 'human' },
      { ply: 1, number: 1, color: 'w', san: '—', uci: '', actor: 'edit' },
    ];
    const chess = buildChess(anchor, log);
    expect(chess.fen()).toBe('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  });

  it('survives a corrupt log entry', () => {
    const anchor: Anchor = { fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', logIndex: 0 };
    const log: MoveEntry[] = [
      { ply: 0, number: 1, color: 'w', san: '??', uci: 'zz99', actor: 'human' },
    ];
    expect(() => buildChess(anchor, log)).not.toThrow();
  });
});

describe('notation rendering', () => {
  it('groups plies into numbered rows', () => {
    const log: MoveEntry[] = [
      { ply: 0, number: 1, color: 'w', san: 'e4', uci: 'e2e4', actor: 'human' },
      { ply: 1, number: 1, color: 'b', san: 'e5', uci: 'e7e5', actor: 'ai' },
      { ply: 2, number: 2, color: 'w', san: 'Nf3', uci: 'g1f3', actor: 'human' },
    ];
    expect(moveLogToSan(log)).toBe('1. e4 e5 2. Nf3');
    expect(moveLogToSan([])).toBe('(no moves yet)');
  });
});

describe('material', () => {
  it('counts both sides and the difference', () => {
    const chess = new Chess('4k3/8/8/3q4/8/8/4P3/4K3 w - - 0 1');
    const summary = materialOf(chess);
    expect(summary.w).toBe(1);
    expect(summary.b).toBe(9);
    expect(summary.diff).toBe(-8);
    expect(summary.pieces.b.q).toBe(1);
  });
});

describe('legalMoves', () => {
  it('returns 20 opening moves', () => {
    expect(legalMoves(new Chess())).toHaveLength(20);
  });
});
