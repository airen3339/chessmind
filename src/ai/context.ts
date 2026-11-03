import type { ChatMessage, Usage } from './types';

/**
 * One AI move remembered as an exact FEN note and the actual choice/explanation.
 * The newest turn still receives a full position pack. Historical legal lists,
 * repeated logs and rejected attempts would only distract from that position.
 */
export interface Exchange {
  /** Number of moves on the board when the position pack was built. */
  ply: number;
  /**
   * The canonical memory for this turn: a past-position FEN note and an
   * assistant reply with the chosen move and any explanation.
   * Rejected replies and corrections are diagnostics only;
   * replaying them would pollute later turns with invalid candidate moves.
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Token size of *this exchange alone*. Estimates are fine here: it only
   * decides when to trim, and trimming is coarse by design.
   */
  tokens?: number;
}

/**
 * Default budget for the whole request (system prompt + earlier exchanges +
 * current position pack), in tokens. Kept well under every mainstream model's
 * window so replies and thinking still fit, and so a single trim is rare.
 *
 * Provider prompt caches are prefix-based: trimming rewrites the beginning of
 * every later request and costs one cache miss. Trimming therefore happens in
 * one large step (down to ~60%) instead of a little every turn.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 64_000;

/** Keep at most this share of the budget after a trim. */
const TRIM_RATIO = 0.6;

/**
 * Rough token estimate for prompts. The packs are a mix of ASCII (FEN,
 * coordinates, UCI) and short Chinese labels: ASCII tokenises near 2.5
 * chars/token, while CJK is close to one token per character. Counting CJK
 * separately keeps Chinese commentary from being under-budgeted by 2–3×.
 */
const CHARS_PER_TOKEN = 2.5;
/** No `g` flag: `.test()` on a global regex advances `lastIndex` and would
 *  skip every other CJK character. */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let cjk = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN + cjk);
}

export function estimateExchangeTokens(exchange: Exchange): number {
  if (exchange.tokens && exchange.tokens > 0) return exchange.tokens;
  let total = 0;
  for (const message of exchange.messages) total += estimateTokens(message.content);
  return total;
}

export function historyMessages(exchanges: Exchange[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const exchange of exchanges) {
    for (const message of exchange.messages) {
      messages.push({ role: message.role, content: message.content });
    }
  }
  return messages;
}

function sizeOf(exchanges: Exchange[]): number {
  let total = 0;
  for (const exchange of exchanges) total += estimateExchangeTokens(exchange);
  return total;
}

/** Tokens left for remembered exchanges once the fixed part is paid for. */
export function exchangeBudget(
  budget: number,
  fixedTokens: number,
): number {
  const limit = budget > 0 ? budget : DEFAULT_CONTEXT_TOKEN_BUDGET;
  return Math.max(0, limit - fixedTokens);
}

/**
 * Drop the oldest exchanges until they fit `budget`, in one coarse step down to
 * `TRIM_RATIO` of it. Called before a request so the prompt never outgrows the
 * setting. Because it leaves headroom, the common case after a trim is a run of
 * cache hits rather than a miss on every following turn.
 */
export function trimExchanges(exchanges: Exchange[], budget: number): Exchange[] {
  if (budget <= 0) return [];
  if (sizeOf(exchanges) <= budget) return exchanges;
  const target = Math.floor(budget * TRIM_RATIO);
  const list = [...exchanges];
  while (list.length > 0 && sizeOf(list) > target) list.shift();
  return list;
}

/**
 * Append one exchange. The caller normally trims precisely before each request
 * (`trimExchanges`); this cap is only a memory guard against unbounded growth
 * in long games, so it uses the full budget and is rarely hit. Trimming is
 * deliberately coarse: a per-turn trim would invalidate the prompt cache on
 * every single request.
 */
export function appendExchange(
  exchanges: Exchange[],
  next: Exchange,
  budget: number = DEFAULT_CONTEXT_TOKEN_BUDGET,
): Exchange[] {
  const limit = budget > 0 ? budget : DEFAULT_CONTEXT_TOKEN_BUDGET;
  const list = [...exchanges, next];
  if (sizeOf(list) <= limit) return list;
  const target = Math.floor(limit * TRIM_RATIO);
  let kept = list;
  while (kept.length > 0 && sizeOf(kept) > target) kept = kept.slice(1);
  return kept;
}

/** Drop exchanges whose move has been taken back by an undo. */
export function truncateForPly(exchanges: Exchange[], movesOnBoard: number): Exchange[] {
  return exchanges.filter((exchange) => exchange.ply < movesOnBoard);
}

/**
 * How many tokens of the *cached prefix* a request would report, for the usage
 * panel. Cache reads only count when the provider reports them.
 */
export function cachedShare(usage: Usage): number | null {
  if (usage.input === undefined || usage.input <= 0) return null;
  const cached = usage.cachedInput ?? 0;
  return Math.round((cached / usage.input) * 100);
}
