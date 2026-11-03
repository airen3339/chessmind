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
import { buildCorrectionPrompt, buildPastTurnPrompt, buildPositionPrompt, buildSystemPrompt } from './prompt';
import { extractJsonObjects, finalAnswerText, resolveMove } from './resolveMove';
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
      /** Compact past-position note and actual choice for continuous context. */
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

function isTimeout(message: string): boolean {
  return /\btimed?\s*out\b|\btimeout\b|\bETIMEDOUT\b|超时/i.test(message);
}

export function extractCommentary(raw: string): string | null {
  for (const object of extractJsonObjects(finalAnswerText(raw)).reverse()) {
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
  // Keep remembered turns stable as a cacheable prefix. Only the current turn
  // needs a full board/history/legal table; past positions are exact FEN notes.
  const positionPrompt = buildPositionPrompt(opts.chess, {
    side: opts.side,
    history: opts.history,
    edited: opts.edited,
    commentary: opts.commentary,
    lang: opts.lang,
  });
  const movesOnBoard = opts.history.length;
  const pastTurnPrompt = buildPastTurnPrompt(opts.chess, movesOnBoard, opts.history.at(-1));
  // Budget covers the whole request: system prompt + remembered turns + this
  // position pack. Remembered turns are trimmed (rarely, in one coarse step)
  // only down to the room that is actually left, so the newest pack always fits.
  const budget = opts.cfg.contextBudget > 0 ? opts.cfg.contextBudget : DEFAULT_CONTEXT_TOKEN_BUDGET;
  const fixedTokens = estimateTokens(system) + estimateTokens(positionPrompt);
  if (fixedTokens > budget) return { ok: false, error: '当前局面和系统提示超过上下文预算，请提高上限（约需 ' + fixedTokens + ' tokens）', attempts };
  let kept = continuous
    ? trimExchanges(opts.exchanges, exchangeBudget(opts.cfg.contextBudget, fixedTokens))
    : [];
  // Retries belong to this turn, not to the next turn's strategic memory.
  // AttemptRecord retains their full output for diagnostics in the UI.
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

    if (result.error && result.errorKind !== 'incomplete' && !isTimeout(result.error) && isTransient(result.status, result.error)) {
      cb.onNotice(`请求失败（${result.status ?? '网络错误'}），1.2 秒后自动重试…`);
      await delay(1200, opts.signal);
      if (opts.signal.aborted) return { ok: false, error: '已取消', attempts };
      reasoning = '';
      text = '';
      cb.onAttemptStart(index + 1, limit);
      result = await once();
      if (result.aborted) return { ok: false, error: '已取消', attempts };
    }

    if (!result.error && !result.text.trim()) {
      // A few gateways put a complete JSON answer in the reasoning channel.
      // Accept that explicit object, never a scan of unfinished candidate prose.
      let answer: unknown;
      try { answer = JSON.parse(result.reasoning.trim()); } catch { /* no final JSON */ }
      result = answer && typeof answer === 'object' && !Array.isArray(answer)
        ? { ...result, text: result.reasoning.trim() }
        : { ...result, error: '接口没有返回最终回答（只有推理或空内容），已停止自动重试。可手动重试或调整输出、超时设置。', errorKind: 'incomplete' };
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
      // Repeating the same capped request cannot repair missing output. In
      // particular, never parse an unfinished chain of thought as a chess move.
      if (result.errorKind === 'incomplete' || isTimeout(result.error)) {
        if (isTimeout(result.error)) cb.onNotice('请求已超时，已停止自动重试；可手动重试或调整请求超时。');
        return { ok: false, error: record.error!, attempts };
      }
      if (index + 1 < limit) {
        cb.onNotice('请求失败，正在重试…');
        await delay(800, opts.signal);
      }
      continue;
    }

    const resolved = resolveMove(raw, opts.chess);
    if (resolved.ok) {
      const commentary = extractCommentary(raw);
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
        commentary,
        usage: result.usage,
        warnings: resolved.value.warnings,
        exchange: {
          ply: movesOnBoard,
          // Preserve every old board exactly as FEN, plus its actual move and
          // explanation, without replaying old legal lists or failed attempts.
          // Once saved, these compact pairs form a growing cacheable prefix.
          messages: [
            { role: 'user', content: pastTurnPrompt },
            { role: 'assistant', content: JSON.stringify({
              move_uci: resolved.value.uci,
              ...(commentary ? { commentary } : {}),
            }) },
          ],
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
    // The final decision tends to be at the end. Do not replay thousands of
    // tokens of candidate analysis or duplicate the reply inside the repair.
    const rejected = raw.length > 1500 ? `[Earlier analysis omitted]\n${raw.slice(-1500)}` : raw;
    const correction = buildCorrectionPrompt(resolved.reason, opts.chess);
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
