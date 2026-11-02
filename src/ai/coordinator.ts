import type { Chess, Move } from 'chess.js';
import type { Side } from '../game/types';
import { runCompatibleAttempt } from './compatible';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  exchangeBudget,
  historyMessages,
  trimExchanges,
  type Exchange,
} from './context';
import { buildCorrectionPrompt, buildPositionPrompt, buildSystemPrompt } from './prompt';
import { extractJsonObjects, resolveMove } from './resolveMove';
import type { AiConfig, AttemptRecord, ChatMessage, Usage } from './types';

export interface TurnCallbacks {
  onAttemptStart(attempt: number, limit: number): void;
  onReasoning(text: string): void;
  onText(text: string): void;
  onAttemptEnd(record: AttemptRecord): void;
  onNotice(message: string): void;
}

export interface TurnOptions {
  cfg: AiConfig;
  side: Side;
  chess: Chess;
  history: string[];
  edited: boolean;
  commentary: boolean;
  lang: string;
  opponent: 'human' | 'ai';
  /** Earlier moves kept in the conversation for continuous context. */
  exchanges: Exchange[];
  signal: AbortSignal;
}

export type TurnOutcome =
  | {
      ok: true;
      move: Move;
      attempts: AttemptRecord[];
      reasoning: string;
      commentary: string | null;
      usage: Usage | null;
      warnings: string[];
      /** The exchange to remember for continuous context (position pack + reply). */
      exchange: Exchange;
    }
  | { ok: false; error: string; attempts: AttemptRecord[] };

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

function isTransient(status: number | null, message: string): boolean {
  if (status === 429) return true;
  if (status !== null && status >= 500) return true;
  if (status === null) return true;
  return /ECONNRESET|ETIMEDOUT|timed out|timeout|connection|network/i.test(message);
}

export function extractCommentary(raw: string): string | null {
  for (const object of extractJsonObjects(raw).reverse()) {
    for (const key of ['commentary', 'comment', 'explanation', 'thoughts']) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

export async function requestAiMove(opts: TurnOptions, cb: TurnCallbacks): Promise<TurnOutcome> {
  const limit = Math.min(5, Math.max(1, Math.round(opts.cfg.retries) || 1));
  const attempts: AttemptRecord[] = [];
  const continuous = opts.cfg.context === 'continuous';
  const system = buildSystemPrompt(opts.side, {
    commentary: opts.commentary,
    lang: opts.lang,
    opponent: opts.opponent,
    continuous,
  });
  // The current position pack. In continuous mode it is appended *after* the
  // remembered exchanges so the stable prefix (system + old turns) is untouched
  // and the provider's prefix cache keeps hitting.
  const positionPrompt = buildPositionPrompt(opts.chess, {
    side: opts.side,
    history: opts.history,
    edited: opts.edited,
  });
  const movesOnBoard = opts.history.length;
  // Budget covers the whole request: system prompt + remembered turns + this
  // position pack. Remembered turns are trimmed (rarely, in one coarse step)
  // only down to the room that is actually left, so the newest pack always fits.
  const budget = opts.cfg.contextBudget > 0 ? opts.cfg.contextBudget : DEFAULT_CONTEXT_TOKEN_BUDGET;
  const fixedTokens = estimateTokens(system) + estimateTokens(positionPrompt);
  if (fixedTokens > budget) return { ok: false, error: '当前局面和系统提示超过上下文预算，请提高上限（约需 ' + fixedTokens + ' tokens）', attempts };
  let kept = continuous
    ? trimExchanges(opts.exchanges, exchangeBudget(opts.cfg.contextBudget, fixedTokens))
    : [];
  /**
   * Everything this turn appended after the remembered history: the position
   * pack, plus any rejected reply and its correction prompt. Saved verbatim as
   * the next turn's history so the model sees the same conversation it had.
   */
  const turnMessages: ChatMessage[] = [{ role: 'user', content: positionPrompt }];

  for (let index = 0; index < limit; index += 1) {
    if (opts.signal.aborted) return { ok: false, error: '已取消', attempts };
    const tokens = (items: ChatMessage[]) => items.reduce((n, m) => n + estimateTokens(m.content), 0);
    if (estimateTokens(system) + tokens(turnMessages) > budget) {
      turnMessages.splice(1);
      cb.onNotice('纠错内容超过上下文预算，已从当前局面重新请求…');
    }
    kept = trimExchanges(kept, budget - estimateTokens(system) - tokens(turnMessages));
    const historyMsgs = historyMessages(kept);
    if (historyMsgs.length) historyMsgs[historyMsgs.length - 1].cache = true;
    const messages: ChatMessage[] = [...historyMsgs, ...turnMessages];
    cb.onAttemptStart(index + 1, limit);

    let reasoning = '';
    let text = '';
    const started = Date.now();

    const once = () =>
      runCompatibleAttempt({
        cfg: opts.cfg,
        onNotice: cb.onNotice,
        onReset: () => {
          reasoning = '';
          text = '';
          cb.onAttemptStart(index + 1, limit);
        },
        system,
        messages,
        signal: opts.signal,
        cb: {
          onReasoning: (chunk) => {
            reasoning += chunk;
            cb.onReasoning(chunk);
          },
          onText: (chunk) => {
            text += chunk;
            cb.onText(chunk);
          },
        },
      });

    let result = await once();

    if (result.aborted) return { ok: false, error: '已取消', attempts };

    if (result.error && isTransient(result.status, result.error)) {
      cb.onNotice(`请求失败（${result.status ?? '网络错误'}），1.2 秒后自动重试…`);
      await delay(1200, opts.signal);
      if (opts.signal.aborted) return { ok: false, error: '已取消', attempts };
      reasoning = '';
      text = '';
      cb.onAttemptStart(index + 1, limit);
      result = await once();
      if (result.aborted) return { ok: false, error: '已取消', attempts };
    }

    const elapsedMs = Date.now() - started;
    const raw = (result.text || result.reasoning).trim();

    if (result.error) {
      const record: AttemptRecord = {
        index: index + 1,
        reasoning,
        text,
        raw,
        error: `请求失败：${result.error}`,
        elapsedMs,
        usage: result.usage,
        status: result.status,
        notice: null,
      };
      attempts.push(record);
      cb.onAttemptEnd(record);
      if (index + 1 < limit) {
        cb.onNotice('请求失败，正在重试…');
        await delay(800, opts.signal);
      }
      continue;
    }

    const resolved = resolveMove(raw, opts.chess);
    if (resolved.ok) {
      const record: AttemptRecord = {
        index: index + 1,
        reasoning,
        text,
        raw,
        error: null,
        elapsedMs,
        usage: result.usage,
        status: result.status,
        notice: resolved.value.warnings.length > 0 ? resolved.value.warnings.join('；') : null,
      };
      attempts.push(record);
      cb.onAttemptEnd(record);
      return {
        ok: true,
        move: resolved.value.move,
        attempts,
        reasoning,
        commentary: extractCommentary(raw),
        usage: result.usage,
        warnings: resolved.value.warnings,
        exchange: {
          ply: movesOnBoard,
          // Replay exactly what this turn put on the wire, including any
          // rejected reply + correction prompt, so the next turn continues the
          // same conversation instead of silently dropping the retries.
          messages: [...turnMessages, { role: 'assistant', content: raw || resolved.value.move.san }],
        },
      };
    }

    const record: AttemptRecord = {
      index: index + 1,
      reasoning,
      text,
      raw,
      error: resolved.reason,
      elapsedMs,
      usage: result.usage,
      status: result.status,
      notice: null,
    };
    attempts.push(record);
    cb.onAttemptEnd(record);
    const rejected = raw.slice(0, 4000);
    const correction = buildCorrectionPrompt(resolved.reason, raw, opts.chess);
    turnMessages.push({ role: 'assistant', content: rejected });
    turnMessages.push({ role: 'user', content: correction });
    if (index + 1 < limit) {
      cb.onNotice(`着法不合法或格式错误，正在让模型重新选择（第 ${index + 1}/${limit} 次）…`);
    }
  }

  return {
    ok: false,
    error: attempts.at(-1)?.error ?? 'AI 未能给出合法着法',
    attempts,
  };
}
