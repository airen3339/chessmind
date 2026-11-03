import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { resolveMove, extractJsonObjects } from '../src/ai/resolveMove';
import { buildPositionPrompt, buildSystemPrompt, buildCorrectionPrompt } from '../src/ai/prompt';
import { legalMoves } from '../src/game/engine';

function game(fen?: string): Chess {
  return fen ? new Chess(fen) : new Chess();
}

describe('resolveMove', () => {
  it('accepts a clean JSON object with uci + san', () => {
    const chess = game();
    const result = resolveMove(
      '{"move_uci":"e2e4","move_san":"e4","commentary":"中心控制"}',
      chess,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.move.san).toBe('e4');
      expect(result.value.uci).toBe('e2e4');
    }
  });

  it('derives SAN from a single explicit UCI without scanning candidate analysis', () => {
    const result = resolveMove('Consider Nf3 and d4. Final answer: {"move_uci":"e2e4"}', game());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('e4');
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const chess = game();
    const raw = 'Sure! Here is my move:\n```json\n{"move_uci": "g1f3", "move_san": "Nf3"}\n```\nGood luck.';
    const result = resolveMove(raw, chess);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('Nf3');
  });

  it('rejects an illegal move even when the JSON is valid', () => {
    const chess = game();
    const result = resolveMove('{"move_uci":"e2e5","move_san":"e5"}', chess);
    expect(result.ok).toBe(false);
  });

  it('falls back to coordinate notation found in plain text', () => {
    const chess = game();
    const result = resolveMove('I will play d2d4 here.', chess);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('d4');
  });

  it('falls back to SAN tokens in plain text', () => {
    const chess = game();
    const result = resolveMove('My move is Nf3, developing the knight.', chess);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('Nf3');
  });

  it('refuses to guess when prose mentions several legal moves', () => {
    const chess = game();
    const result = resolveMove(
      'If White plays Nf3 then e4 is possible, but d4 also looks fine.',
      chess,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('多个合法着法');
  });

  it.each(['think', 'thinking', 'analysis'])('ignores an explicit leading <%s> block when reading the final move', (tag) => {
    const result = resolveMove(`<${tag}>Compare Nf3, d4 and {"move_uci":"g1f3"}.</${tag}>\ne4`, game());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.uci).toBe('e2e4');
  });

  it('never plays a move mentioned inside an unfinished reasoning block', () => {
    expect(resolveMove('<think>I might choose {"move_uci":"e2e4"}', game()).ok).toBe(false);
    expect(resolveMove('<think><analysis>Check candidates.</analysis>{"move_uci":"e2e4"}', game()).ok).toBe(false);
  });

  it('still refuses ambiguous final prose after a closed reasoning block', () => {
    const result = resolveMove('<think>Analyze the board.</think>I might play Nf3 or d4.', game());
    expect(result.ok).toBe(false);
  });

  it('does not treat a reasoning tag inside a JSON commentary string as a block', () => {
    const result = resolveMove('{"move_uci":"e2e4","commentary":"<think>Nf3 or d4</think>"}', game());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.uci).toBe('e2e4');
  });

  it('still honours a single explicit JSON move surrounded by analysis', () => {
    const chess = game();
    const result = resolveMove(
      'Considering Nf3 and d4, I choose {"move_uci":"e2e4","move_san":"e4"}.',
      chess,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('e4');
  });

  it('handles castling notation variants', () => {
    const chess = game('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const result = resolveMove('{"move_san":"0-0"}', chess);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('O-O');
  });

  it('defaults a missing promotion piece to a queen', () => {
    const chess = game('8/P7/8/8/8/8/8/K6k w - - 0 1');
    const result = resolveMove('{"move_uci":"a7a8"}', chess);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.move.promotion).toBe('q');
      expect(result.value.warnings.length).toBeGreaterThan(0);
    }
  });

  it('prefers the JSON uci field over conflicting san', () => {
    const chess = game();
    const result = resolveMove('{"move_uci":"e2e4","move_san":"d4"}', chess);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.move.san).toBe('e4');
  });

  it('reports a readable failure when nothing usable is present', () => {
    const chess = game();
    const result = resolveMove('I am thinking about it.', chess);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('无法从回复中解析出合法着法');
  });

  it('extracts balanced JSON objects containing braces inside strings', () => {
    const objects = extractJsonObjects('prefix {"a":"}{","b":2} suffix');
    expect(objects).toHaveLength(1);
    expect(objects[0].a).toBe('}{');
  });
});

describe('prompt building', () => {
  it('lists every legal move in both SAN and UCI', () => {
    const chess = game();
    const prompt = buildPositionPrompt(chess, {
      side: 'w',
      history: [],
      edited: false,
    });
    for (const move of legalMoves(chess)) {
      expect(prompt).toContain(move.san);
    }
    expect(prompt).toContain('e2e4');
    expect(prompt).toContain('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  });

  it.each([
    'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    '8/P7/8/8/8/8/8/K6k w - - 0 1',
    '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1',
  ])('retains every castling, promotion and en passant choice: %s', (fen) => {
    const chess = game(fen);
    const prompt = buildPositionPrompt(chess, { side: chess.turn(), history: [], edited: true });
    const table = prompt.split('## LEGAL MOVES')[1].split('## ANSWER THIS TURN')[0];
    for (const move of legalMoves(chess)) {
      expect(table).toContain(`${move.from}${move.to}${move.promotion ?? ''}=${move.san}`);
    }
  });

  it('puts the complete one-move output contract in the current user message', () => {
    const chess = game();
    const prompt = buildPositionPrompt(chess, { side: 'w', history: [], edited: false });
    expect(prompt).toContain('{"move_uci":"<UCI>"}');
    expect(prompt).toContain('No other move fields');
  });

  it('states the commentary contract in the current user message too', () => {
    const prompt = buildPositionPrompt(game(), {
      side: 'w', history: [], edited: false, commentary: true, lang: 'zh',
    });
    expect(prompt).toContain('"commentary":"<your chosen move and plan>"');
    expect(prompt).toContain('Write commentary in Simplified Chinese');
  });

  it('renders an ASCII board with coordinates', () => {
    const chess = game();
    const prompt = buildPositionPrompt(chess, {
      side: 'w',
      history: [],
      edited: false,
    });
    expect(prompt).toContain('a b c d e f g h');
    expect(prompt).toContain('R N B Q K B N R');
    expect(prompt).toContain('r n b q k b n r');
  });

  it('forbids advising the human and includes the JSON contract', () => {
    const system = buildSystemPrompt('b', { commentary: true, lang: 'zh' });
    expect(system).toContain('Never give the human advice');
    expect(system).toContain('move_uci');
    expect(system).toContain('You play Black');
    expect(system).toContain('Simplified Chinese');
  });

  it('drops the commentary field when disabled', () => {
    const system = buildSystemPrompt('w', { commentary: false, lang: 'zh' });
    expect(system).toContain('Do not include the "commentary" field');
  });

  it('never states what a move would lead to', () => {
    // White can take on d5 and several moves give check; none of that is spelled
    // out for the model, which has to work the consequences out itself.
    const chess = game('4k3/8/8/3p4/8/8/8/3QK3 w - - 0 1');
    const prompt = buildPositionPrompt(chess, { side: 'w', history: [], edited: false });
    expect(prompt).not.toContain('## FACTS');
    expect(prompt).not.toMatch(/can capture/i);
    expect(prompt).not.toMatch(/give check/i);
    expect(prompt).not.toMatch(/attacked/i);
    expect(prompt).not.toMatch(/capturable/i);
  });

  it('marks edited positions in the history block', () => {
    const chess = game('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    const prompt = buildPositionPrompt(chess, {
      side: 'w',
      history: ['e2e4'],
      edited: true,
    });
    expect(prompt).toContain('the position was edited by the arbiter');
  });

  it('repairs the output against the current legal table without repeating rejected analysis', () => {
    const chess = game();
    const correction = buildCorrectionPrompt('move "e2e5" is not legal', chess);
    expect(correction).toContain('e2e5');
    expect(correction).toContain('e2e4');
    expect(correction).toContain('Legal moves (UCI=SAN)');
    expect(correction).toContain('do not restart the analysis');
  });
});
