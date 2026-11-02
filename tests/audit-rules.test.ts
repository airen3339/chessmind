import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { resolveMove } from '../src/ai/resolveMove';
import { appendExchange, trimExchanges } from '../src/ai/context';
import { draftFromFen, draftToChess, moveDraftPiece, toggleSquarePiece, validateDraft } from '../src/game/setup';
import { openaiResponses } from '../src/ai/providers/openaiResponses';
import { parseSettings } from '../src/config';

describe('audit: chess and response boundaries', () => {
  it('distinguishes bishop captures from b-file pawn captures', () => {
    const chess = new Chess('4k3/8/8/8/1B6/2n5/1P6/4K3 w - - 0 1');
    for (const san of ['Bxc3', 'bxc3']) {
      for (const raw of [JSON.stringify({ move_san: san }), san]) {
        const result = resolveMove(raw, chess);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.move.san).toBe(san);
      }
    }
  });

  it('clears en passant after moving or replacing a piece', () => {
    const draft = draftFromFen('4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1');
    expect(validateDraft(draft).ok).toBe(true);
    expect(draftToChess(draft).moves()).toContain('dxe3');
    const moved = moveDraftPiece(draft, 'e4', 'e5');
    expect(moved.ep).toBeNull();
    expect(draftToChess(moved).moves()).not.toContain('dxe3');
    expect(toggleSquarePiece(draft, 'e4', null).ep).toBeNull();
  });

  it('rejects impossible imported en passant metadata', () => {
    for (const fen of [
      '4k3/8/8/4P3/3p4/8/8/4K3 b - e3 0 1',
      '4k3/8/8/8/3pP3/8/8/4K3 w - e3 0 1',
      '4k3/8/8/8/3pP3/8/8/4K3 b - e3 1 1',
    ]) expect(validateDraft(draftFromFen(fen)).ok).toBe(false);
  });

  it('drops even a single oversized exchange', () => {
    const exchange = { ply: 0, messages: [{ role: 'user' as const, content: 'x'.repeat(25000) }] };
    expect(trimExchanges([exchange], 1000)).toEqual([]);
    expect(appendExchange([], exchange, 1000)).toEqual([]);
  });

  it('does not emit partial Responses output as a completed answer', () => {
    const texts: string[] = [];
    const errors: string[] = [];
    openaiResponses.parseFull({
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial answer' }] }],
    }, { text: (text) => texts.push(text), error: (_, error) => errors.push(error), reasoning() {}, usage() {}, done() {} });
    expect(texts).toEqual([]);
    expect(errors[0]).toContain('max_output_tokens');
  });

  it('surfaces malformed settings instead of pretending the load succeeded', () => {
    for (const raw of ['', '{broken', 'null', '[]']) expect(() => parseSettings(raw)).toThrow('设置文件内容损坏');
    expect(parseSettings(null).aiProfiles.length).toBeGreaterThan(0);
  });
});
