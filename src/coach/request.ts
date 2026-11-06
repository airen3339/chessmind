import { runCompatibleAttempt } from '../ai/compatible';
import type { AiConfig, Usage } from '../ai/types';

export interface CoachReply {
  ok: boolean;
  text: string;
  error: string | null;
  elapsedMs: number;
  usage: Usage | null;
  /** How many HTTP round trips this reply cost. */
  attempts: number;
  notices?: string[];
}

/**
 * A coach call follows the profile's transport, with a hard timeout well
 * below the move timeout. Coaching is a nice-to-have, so it must never hold up
 * the game. Transient failures (network, 429, 5xx) get one more try, because a
 * rate-limited gateway is the common case and a silent empty card is worse.
 */
const COACH_TIMEOUT_CAP_SECS = 60;
const COACH_ATTEMPTS = 2;
const COACH_RETRY_DELAY_MS = 1200;

export function coachConfig(cfg: AiConfig): AiConfig {
  return {
    ...cfg,
    timeoutSecs: Math.max(15, Math.min(cfg.timeoutSecs, COACH_TIMEOUT_CAP_SECS)),
  };
}

function isTransient(status: number | null, message: string): boolean {
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  if (status === null) return true;
  return /ECONNRESET|ETIMEDOUT|timed out|timeout|connection|network|fetch/i.test(message);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function requestCoach(opts: {
  cfg: AiConfig;
  system: string;
  user: string;
  signal: AbortSignal;
}): Promise<CoachReply> {
  const started = Date.now();
  let lastError = '教练请求失败';
  let usage: Usage | null = null;
  const notices = new Set<string>();

  for (let attempt = 1; attempt <= COACH_ATTEMPTS; attempt += 1) {
    if (opts.signal.aborted) {
      return { ok: false, text: '', error: '已取消', elapsedMs: Date.now() - started, usage, attempts: attempt, notices: [...notices] };
    }
    const result = await runCompatibleAttempt({
      cfg: coachConfig(opts.cfg),
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      signal: opts.signal,
      cb: { onReasoning: () => undefined, onText: () => undefined },
    });
    usage = result.usage ?? usage;
    for (const notice of result.notices ?? []) notices.add(notice);
    const elapsedMs = Date.now() - started;

    if (result.aborted) {
      return { ok: false, text: '', error: '已取消', elapsedMs, usage, attempts: attempt, notices: [...notices] };
    }

    // Some gateways put the whole answer into the reasoning channel.
    const text = (result.text || result.reasoning || '').trim();
    if (!result.error && text) {
      return { ok: true, text, error: null, elapsedMs, usage, attempts: attempt, notices: [...notices] };
    }

    lastError = result.error ?? '教练没有返回内容';
    const retryable = result.error && result.errorKind !== 'incomplete' ? isTransient(result.status, result.error) : false;
    if (attempt >= COACH_ATTEMPTS || !retryable) {
      return { ok: false, text: '', error: lastError, elapsedMs, usage, attempts: attempt, notices: [...notices] };
    }
    await delay(COACH_RETRY_DELAY_MS, opts.signal);
  }

  return { ok: false, text: '', error: lastError, elapsedMs: Date.now() - started, usage, attempts: COACH_ATTEMPTS, notices: [...notices] };
}
