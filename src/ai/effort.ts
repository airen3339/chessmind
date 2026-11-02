import type { ThinkingEffort, ThinkingMode } from './types';

/**
 * Map our five-level effort scale onto each vendor's own scale.
 *
 * - OpenAI: `ReasoningEffort` accepts `none | minimal | low | medium | high |
 *   xhigh | max`, so all five levels pass straight through. Not every model
 *   supports every value; the coordinator steps down once on a 400.
 * - Anthropic: models up to 4.5 take `thinking: {type: enabled, budget_tokens}`;
 *   from 4.6 they use adaptive thinking plus `output_config.effort`, which has
 *   the same five names as our scale.
 * - Gemini: 2.5 and older take `thinkingBudget` tokens; 3 and newer take
 *   `thinkingLevel` (minimal/low/medium/high) and reject budgets.
 */

export function openAiEffort(effort: ThinkingEffort): string {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    default:
      return 'medium';
  }
}
/* ----------------------------------------------------- custom effort string */

/** Trim and lower-case user input; empty string means "use the preset". */
export function normalizeEffortText(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The effort value to put on the wire: the user's free text when set, else the
 * preset. Applied by every string-based effort field (OpenAI reasoning_effort,
 * Claude output_config.effort).
 */
export function resolveEffortText(effort: ThinkingEffort, custom: string | undefined): string {
  const text = normalizeEffortText(custom ?? '');
  return text.length > 0 ? text : openAiEffort(effort);
}

/* ------------------------------------------------------------------ Gemini */

/** Fixed token budgets for Gemini 2.5 and older (Gemini 3 rejects them). */
export function geminiThinkingBudget(effort: ThinkingEffort): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 12288;
    case 'xhigh':
      return 24576;
    case 'max':
      return 32768;
    default:
      return 4096;
  }
}

/**
 * Gemini's budget mode has no textual effort — it only takes a number. Derive
 * one from a custom effort string when we recognise it, otherwise keep the
 * preset budget.
 */
export function geminiBudgetForText(effort: ThinkingEffort, custom: string | undefined): number {
  const text = normalizeEffortText(custom ?? '');
  if (!text) return geminiThinkingBudget(effort);
  if (text === 'none') return 0;
  if (text === 'minimal') return 1024;
  if (text === 'low') return 1024;
  if (text === 'medium') return 4096;
  if (text === 'high') return 12288;
  if (text === 'xhigh') return 24576;
  if (text === 'max') return 32768;
  return geminiThinkingBudget(effort);
}

function normalizeGeminiId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');
}

/** Gemini 3 replaced token budgets with a coarse level; 2.5 keeps budgets. */
export function geminiUsesThinkingLevel(model: string): boolean {
  const name = normalizeGeminiId(model);
  if (/^gemma/.test(name)) return false;
  // gemini-1.x / gemini-2.x (and bare "gemini-2") still speak thinkingBudget.
  return !/^gemini-(1|2)([.-]|$)/.test(name);
}

export type GeminiThinkingPlan =
  | { kind: 'budget'; budget: number }
  | { kind: 'level'; level: GeminiThinkingLevelValue };

export type GeminiThinkingLevelValue = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Gemini 3 Pro only accepts `low` and `high`; 3.1 Pro and the Flash line accept
 * `minimal`/`medium` too. Anything newer is assumed to accept all four.
 */
export function geminiThinkingLevel(
  model: string,
  effort: ThinkingEffort,
): GeminiThinkingLevelValue {
  const name = normalizeGeminiId(model);
  const mediumSupported = !/gemini-3-pro(?![-.]?\d)/.test(name);
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return mediumSupported ? 'medium' : 'high';
    default:
      return 'high';
  }
}

/**
 * Gemini 3 only accepts `minimal|low|medium|high`. A custom effort string is
 * mapped onto that set; unrecognised text keeps the preset mapping.
 */
export function geminiLevelForText(
  model: string,
  effort: ThinkingEffort,
  custom: string | undefined,
): GeminiThinkingLevelValue {
  const text = normalizeEffortText(custom ?? '');
  if (!text) return geminiThinkingLevel(model, effort);
  if (text === 'minimal') return 'minimal';
  if (text === 'low') return 'low';
  if (text === 'medium') return geminiThinkingLevel(model, 'medium');
  if (text === 'high' || text === 'xhigh' || text === 'max') return 'high';
  return geminiThinkingLevel(model, effort);
}

export function geminiThinkingPlan(
  model: string,
  effort: ThinkingEffort,
  mode: ThinkingMode = 'auto',
  custom?: string,
): GeminiThinkingPlan {
  const forced = mode === 'level' || mode === 'budget';
  const useLevel = mode === 'level' ? true : mode === 'budget' ? false : geminiUsesThinkingLevel(model);
  if (useLevel) {
    // A pinned format means the user knows their endpoint; send the literal
    // level instead of second-guessing it against the model id.
    const level = forced && !custom ? literalGeminiLevel(effort) : geminiLevelForText(model, effort, custom);
    return { kind: 'level', level };
  }
  return { kind: 'budget', budget: geminiBudgetForText(effort, custom) };
}

/** No per-model corrections: low/medium/high map straight across. */
function literalGeminiLevel(effort: ThinkingEffort): GeminiThinkingLevelValue {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    default:
      return 'high';
  }
}

/* --------------------------------------------------------------- Anthropic */

/** Budget-based thinking, still the only option up to Claude 4.5. */
export function anthropicThinkingBudget(effort: ThinkingEffort): number {
  switch (effort) {
    case 'low':
      return 2048;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    case 'max':
      return 32000;
    default:
      return 4096;
  }
}

/**
 * Claude's budget mode also has no textual effort. Map a custom effort string
 * onto the equivalent token budget when possible.
 */
export function anthropicBudgetForText(effort: ThinkingEffort, custom: string | undefined): number {
  const text = normalizeEffortText(custom ?? '');
  if (!text) return anthropicThinkingBudget(effort);
  switch (text) {
    case 'none':
      return 1024;
    case 'minimal':
    case 'low':
      return 2048;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    case 'max':
      return 32000;
    default:
      return anthropicThinkingBudget(effort);
  }
}

interface ClaudeModelInfo {
  /** 4.6+ uses adaptive thinking; earlier models use an explicit token budget. */
  adaptive: boolean;
  /** `output_config.effort: "max"` (Opus 4.6 and later only). */
  maxOk: boolean;
  /** `output_config.effort: "xhigh"` (4.7 and later). */
  xhighOk: boolean;
  /** Explicit thinking summaries are documented from 4.7 on. */
  summaryDisplay: boolean;
}

/**
 * Read the family/version out of a Claude model id. Unknown or aliased ids are
 * treated as the modern surface — the coordinator falls back if the model
 * disagrees, which is cheaper than shipping a stale model table.
 */
export function parseClaudeModel(model: string): ClaudeModelInfo {
  const name = model.trim().toLowerCase();
  // Modern ids: claude-opus-4-6, claude-sonnet-4.5, claude-opus-4-20250514…
  const modern = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/.exec(name);
  if (modern) {
    const family = modern[1];
    const major = Number(modern[2]);
    let minor = modern[3] ? Number(modern[3]) : 0;
    if (minor > 100) minor = 0; // date-stamped id such as claude-opus-4-20250514
    const version = major + minor / 10;
    const adaptive = version >= 4.6;
    return {
      adaptive,
      maxOk: adaptive && family === 'opus',
      xhighOk: adaptive && version >= 4.7,
      summaryDisplay: adaptive && version >= 4.7,
    };
  }
  // Legacy ids put the version first: claude-3-5-sonnet-20241022,
  // claude-3-opus-20240229. Those are all pre-4.6 and need explicit budgets.
  if (/claude-\d/.test(name)) {
    return { adaptive: false, maxOk: false, xhighOk: false, summaryDisplay: false };
  }
  // Unknown alias (e.g. a gateway-specific name): prefer the modern surface.
  return { adaptive: true, maxOk: false, xhighOk: false, summaryDisplay: false };
}

export type AnthropicThinkingPlan =
  | { mode: 'budget'; thinking: { type: 'enabled'; budget_tokens: number }; maxTokens: number }
  | {
      mode: 'adaptive';
      thinking: { type: 'adaptive'; display?: 'summarized' };
      /** Free text: the user's custom value, or one of our presets. */
      effort: string;
      maxTokens: number;
    };

/**
 * Thinking tokens are billed inside `max_tokens`, so adaptive requests need
 * headroom or the model gets truncated mid-thought.
 */
const ANTHROPIC_ADAPTIVE_FLOOR: Record<ThinkingEffort, number> = {
  low: 8192,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

export function anthropicThinkingPlan(
  model: string,
  effort: ThinkingEffort,
  requestedMaxTokens: number,
  mode: ThinkingMode = 'auto',
  custom?: string,
): AnthropicThinkingPlan {
  const info = parseClaudeModel(model);
  const forced = mode === 'adaptive' || mode === 'budget';
  const useAdaptive = mode === 'adaptive' ? true : mode === 'budget' ? false : info.adaptive;
  if (!useAdaptive) {
    const budget = anthropicBudgetForText(effort, custom);
    // Anthropic requires budget_tokens < max_tokens.
    return {
      mode: 'budget',
      thinking: { type: 'enabled', budget_tokens: budget },
      maxTokens: Math.max(requestedMaxTokens, budget + 4096),
    };
  }

  // Adaptive thinking takes an arbitrary effort string; unrecognised values are
  // still sent, because the provider — not our table — is authoritative.
  const text = normalizeEffortText(custom ?? '');
  let level: string = text.length > 0 ? text : effort;
  if (!forced && !text) {
    if (level === 'max' && !info.maxOk) level = 'xhigh';
    if (level === 'xhigh' && !info.xhighOk) level = 'high';
  }

  const thinking: { type: 'adaptive'; display?: 'summarized' } = { type: 'adaptive' };
  // A pinned format means the user knows the endpoint supports summaries.
  if (info.summaryDisplay || forced) thinking.display = 'summarized';

  return {
    mode: 'adaptive',
    thinking,
    effort: level,
    maxTokens: Math.max(requestedMaxTokens, ANTHROPIC_ADAPTIVE_FLOOR[effort]),
  };
}
