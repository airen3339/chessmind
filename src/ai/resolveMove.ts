import type { Chess, Move } from 'chess.js';
import { legalMoves } from '../game/engine';

export interface ResolvedMove {
  move: Move;
  uci: string;
  warnings: string[];
}

export type ResolveResult =
  | { ok: true; value: ResolvedMove }
  | { ok: false; reason: string };

function uciOf(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function normalizeUciCandidate(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-h1-8qrbn]/g, '')
    .replace(/=/, '');
}

function normalizeSan(raw: string): string {
  return raw
    .trim()
    .replace(/[–—]/g, '-')
    .replace(/[+#!?]+/g, '')
    .replace(/=([qrbn])/gi, (_, piece: string) => piece.toUpperCase())
    .replace(/e\.p\.?/gi, '')
    .replace(/\s+/g, '')
    .replace(/[0o]/g, 'O');
}

/** Some gateways embed reasoning in content instead of a separate channel. */
export function finalAnswerText(raw: string): string {
  let text = raw.trimStart();
  for (;;) {
    if (!/^<(think|thinking|analysis)>/i.test(text)) return text;
    const stack: string[] = [];
    let end = -1;
    for (const token of text.matchAll(/<\/?(think|thinking|analysis)>/gi)) {
      const tag = token[1].toLowerCase();
      if (token[0].startsWith('</')) {
        if (stack.pop() !== tag) return '';
        if (!stack.length) { end = token.index + token[0].length; break; }
      } else stack.push(tag);
    }
    // An unfinished reasoning block contains no final decision we may play.
    if (end < 0) return '';
    text = text.slice(end).trimStart();
  }
}

/** Collect every balanced {...} substring; a model may wrap JSON in prose or fences. */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          try {
            const parsed: unknown = JSON.parse(slice);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              objects.push(parsed as Record<string, unknown>);
            }
          } catch {
            // not valid JSON, ignore
          }
          start = -1;
        }
      }
    }
  }
  return objects;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out, depth + 1);
    }
  }
}

function findMove(
  moves: Move[],
  uciCandidates: string[],
  sanCandidates: string[],
): { move: Move; warnings: string[] } | null {
  const warnings: string[] = [];

  for (const candidate of uciCandidates) {
    const cleaned = normalizeUciCandidate(candidate);
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(cleaned);
    if (!match) continue;
    const [, from, to, promotion] = match;
    const exact = moves.filter((move) => move.from === from && move.to === to);
    if (exact.length === 0) continue;
    if (promotion) {
      const withPromotion = exact.find((move) => move.promotion === promotion);
      if (withPromotion) return { move: withPromotion, warnings };
      continue;
    }
    const queen = exact.find((move) => move.promotion === 'q');
    if (exact.length > 1) warnings.push('升变未指明棋子，已按升后处理');
    return { move: queen ?? exact[0], warnings };
  }

  const sanMap = new Map<string, Move>();
  for (const move of moves) sanMap.set(normalizeSan(move.san), move);
  for (const candidate of sanCandidates) {
    const normalized = normalizeSan(candidate);
    if (!normalized) continue;
    const direct = sanMap.get(normalized);
    if (direct) return { move: direct, warnings };
    const withoutCapture = normalized.replace(/x/g, '');
    const relaxed = [...sanMap].filter(([key]) => key.replace(/x/g, '') === withoutCapture);
    if (relaxed.length === 1) return { move: relaxed[0][1], warnings };
  }

  return null;
}

/**
 * Every distinct legal move mentioned in free text. Used only as a last resort:
 * an explanation like "if White plays Nf3 then…" must not silently win over the
 * move the model actually meant, so more than one candidate is a rejection.
 */
function collectTextMoves(moves: Move[], uciCandidates: string[], sanCandidates: string[]): Move[] {
  const found = new Map<string, Move>();
  const add = (move: Move) => {
    const key = `${move.from}${move.to}${move.promotion ?? ''}`;
    if (!found.has(key)) found.set(key, move);
  };
  for (const candidate of uciCandidates) {
    const cleaned = normalizeUciCandidate(candidate);
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(cleaned);
    if (!match) continue;
    const [, from, to, promotion] = match;
    for (const move of moves) {
      if (move.from !== from || move.to !== to) continue;
      if (promotion && move.promotion !== promotion) continue;
      add(move);
    }
  }
  for (const candidate of sanCandidates) {
    const normalized = normalizeSan(candidate);
    if (!normalized) continue;
    for (const move of moves) {
      if (normalizeSan(move.san) === normalized) add(move);
    }
  }
  return [...found.values()];
}

export function resolveMove(raw: string, chess: Chess): ResolveResult {
  const moves = legalMoves(chess);
  if (moves.length === 0) return { ok: false, reason: '当前局面没有任何合法着法' };

  const answer = finalAnswerText(raw);
  const objects = extractJsonObjects(answer);
  const uciCandidates: string[] = [];
  const sanCandidates: string[] = [];

  const pushField = (value: unknown, target: string[]) => {
    const strings: string[] = [];
    collectStrings(value, strings);
    for (const item of strings) {
      if (typeof item === 'string' && item.trim()) target.push(item.trim());
    }
  };

  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const object = objects[i];
    const uciField =
      object.move_uci ?? object.moveUci ?? object.uci ?? object.bestmove ?? object.bestMove;
    const sanField = object.move_san ?? object.moveSan ?? object.san;
    const generic = object.move ?? object.moves ?? object.best_move;
    if (uciField !== undefined) pushField(uciField, uciCandidates);
    if (sanField !== undefined) pushField(sanField, sanCandidates);
    if (generic !== undefined) {
      pushField(generic, uciCandidates);
      pushField(generic, sanCandidates);
    }
  }

  const fromJson = findMove(moves, uciCandidates, sanCandidates);
  if (fromJson) return { ok: true, value: { ...fromJson, uci: uciOf(fromJson.move) } };

  // Fall back to scanning the raw text: coordinate notation first, then SAN tokens.
  const textUci: string[] = [];
  const uciRegex = /[a-h][1-8][-\s]?[a-h][1-8](?:=?[qrbnQRBN])?/g;
  const uciMatches = answer.match(uciRegex);
  if (uciMatches) textUci.push(...uciMatches);
  const textSan: string[] = [];
  const tokens = answer.split(/[^A-Za-z0-9+#=/–—-]+/);
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (/^(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|O-O(?:-O)?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)$/.test(token)) {
      textSan.push(token);
    }
  }

  const textMoves = collectTextMoves(moves, textUci, textSan);
  if (textMoves.length === 1) {
    const [move] = textMoves;
    return { ok: true, value: { move, uci: uciOf(move), warnings: [] } };
  }
  if (textMoves.length > 1) {
    return {
      ok: false,
      reason:
        '回复正文提到了多个合法着法，无法判断实际要走哪一手。请用 {"move_uci":"..."} 明确给出唯一着法。',
    };
  }

  const hint = objects.length > 0 ? '（回复里没有可用的着法字段）' : '（回复里没有 JSON 对象）';
  return {
    ok: false,
    reason: `无法从回复中解析出合法着法${hint}。必须从合法着法列表中选择一手，并以 {"move_uci":"..."} 格式回答。`,
  };
}
