import type { Side } from '../game/types';

export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';

/** How hard the model is asked to think. Mapped per protocol. */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_EFFORTS: ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Which wire format carries the thinking request. `auto` reads it off the model
 * id; the rest pin it so a renamed model or a proxy can never mis-route it.
 * `adaptive` only exists on Anthropic, `level` only on Gemini.
 */
export type ThinkingMode = 'auto' | 'adaptive' | 'budget' | 'level';

export const THINKING_MODES: ThinkingMode[] = ['auto', 'adaptive', 'budget', 'level'];

export const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

/**
 * Whether the model keeps the conversation from earlier moves.
 * `continuous` (default) lets it remember the plan it already committed to and
 * makes provider-side prompt caching hit; `isolated` re-sends only the current
 * position, which is cheaper per request but re-reasons from scratch every move.
 */
export type ContextMode = 'continuous' | 'isolated';

export const CONTEXT_MODES: ContextMode[] = ['continuous', 'isolated'];

export const CONTEXT_LABELS: Record<ContextMode, string> = {
  continuous: '连续上下文',
  isolated: '每次独立',
};

export interface AiConfig {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Raw JSON object with extra request headers. */
  extraHeaders: string;
  stream: boolean;
  /** Ask the provider to expose chain of thought / reasoning when supported. */
  reasoning: boolean;
  /** Reasoning budget/intensity; ignored when `reasoning` is false. */
  effort: ThinkingEffort;
  /**
   * Free-text effort value sent to the provider instead of the preset, e.g.
   * `minimal`, `none`, or a vendor-specific name. Empty means "use `effort`".
   * Passed through verbatim for string-based formats (OpenAI `reasoning_effort`,
   * Claude `output_config.effort`); level-only formats fall back to the preset
   * when the text is not one they recognise.
   */
  effortCustom: string;
  /** Wire shape for the thinking request; `auto` infers it from the model id. */
  thinkingMode: ThinkingMode;
  /** Keep earlier moves in the conversation so the model can follow its own plan. */
  context: ContextMode;
  /**
   * How many tokens of earlier conversation to keep in continuous mode,
   * counting the system prompt and the current position pack as well. The real
   * prompt size is read from each response's `usage`; the estimate is only used
   * to decide what to trim. 0 means "use the default".
   */
  contextBudget: number;
  maxTokens: number;
  timeoutSecs: number;
  /** How many *move* attempts the model gets before we give up. */
  retries: number;
  insecureTls: boolean;
}

/**
 * One saved endpoint + model + parameters, so several providers/models can be
 * kept around and picked per game (and per side in an AI-vs-AI game).
 */
export interface AiProfile {
  /** Stable id referenced by the game setup; never reused. */
  id: string;
  /** Shown in pickers; user editable. */
  name: string;
  config: AiConfig;
}

export interface StreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeout_secs: number;
  insecure_tls: boolean;
}

export type StreamEvent =
  | { kind: 'response'; status: number }
  | { kind: 'chunk'; text: string }
  | { kind: 'end' }
  | { kind: 'error'; status?: number | null; message: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Ask the provider to cache the request prefix up to and including this
   * message. Used only by Anthropic (cache_control); ignored elsewhere. Set on
   * the newest *history* message so the stable prefix stays cacheable while the
   * fresh position pack after it is left uncached.
   */
  cache?: boolean;
}

export interface Usage {
  input?: number;
  output?: number;
  reasoning?: number;
  /** Input tokens served from the provider's prompt cache (billed cheaper). */
  cachedInput?: number;
  /** Tokens written into the prompt cache by this request (billed ~1.25x). */
  cacheWrite?: number;
}

export interface EmitHandlers {
  reasoning(text: string): void;
  text(text: string): void;
  usage(usage: Usage): void;
  done(): void;
  error(status: number | null, message: string, kind?: 'incomplete'): void;
}

export interface Decoder {
  push(chunk: string): void;
  end(): void;
}

export interface Provider {
  id: Protocol;
  label: string;
  hint: string;
  defaultBaseUrl: string;
  defaultModel: string;
  buildRequest(cfg: AiConfig, system: string, messages: ChatMessage[], stream: boolean): StreamRequest;
  createDecoder(cfg: AiConfig, emit: EmitHandlers): Decoder;
  /** Parse a complete (non-streamed) JSON response body. */
  parseFull(payload: unknown, emit: EmitHandlers): void;
}

export interface TurnPrompt {
  side: Side;
  history: string[];
  edited: boolean;
  commentary?: boolean;
  lang?: string;
}

export interface AttemptRecord {
  index: number;
  reasoning: string;
  text: string;
  raw: string;
  error: string | null;
  elapsedMs: number;
  usage: Usage | null;
  status: number | null;
  notice: string | null;
}
