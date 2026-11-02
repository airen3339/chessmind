import { runAttempt } from './client';
import { THINKING_EFFORTS } from './types';
import type { AiConfig, ThinkingEffort } from './types';

interface Capability {
  effort?: ThinkingEffort;
  noReasoning?: boolean;
  noCustom?: boolean;
  tokenCap?: number;
}

// Shared by playing, coaching and connection tests. Bound the cache so editing
// many endpoints cannot retain an unlimited number of credentials/configs.
const capabilities = new Map<string, Capability>();

export async function runCompatibleAttempt(
  opts: Parameters<typeof runAttempt>[0] & {
    onNotice?(message: string): void;
    onReset?(): void;
  },
): ReturnType<typeof runAttempt> {
  const key = JSON.stringify([opts.cfg.protocol, opts.cfg.baseUrl, opts.cfg.model,
    opts.cfg.thinkingMode, opts.cfg.apiKey, opts.cfg.extraHeaders]);
  const learned = { ...capabilities.get(key) };
  let cfg: AiConfig = { ...opts.cfg };
  if (learned.effort && THINKING_EFFORTS.indexOf(learned.effort) < THINKING_EFFORTS.indexOf(cfg.effort)) {
    cfg.effort = learned.effort;
  }
  if (learned.noCustom) cfg.effortCustom = '';
  if (learned.noReasoning) cfg.reasoning = false;
  if (learned.tokenCap) cfg.maxTokens = Math.min(cfg.maxTokens, learned.tokenCap);

  // At most one retry for each compatibility change, independent of transient
  // network retries and illegal-move correction.
  for (;;) {
    const result = await runAttempt({ ...opts, cfg });
    if (result.aborted || !result.error || (result.status !== 400 && result.status !== 422)) return result;
    let notice: string;
    if (/reason|effort|think|budget/i.test(result.error) && cfg.reasoning) {
      if (cfg.effortCustom.trim() && !learned.noCustom) {
        learned.noCustom = true;
        cfg.effortCustom = '';
        notice = '该模型不接受自定义思考强度，已改回档位重试…';
      } else if ((cfg.effort === 'max' || cfg.effort === 'xhigh') && !learned.effort) {
        learned.effort = 'high';
        cfg.effort = 'high';
        notice = '该模型不接受当前思考强度，已降为 high 重试…';
      } else if (!learned.noReasoning) {
        learned.noReasoning = true;
        learned.tokenCap = 4096;
        cfg = { ...cfg, reasoning: false, maxTokens: Math.min(cfg.maxTokens, 4096) };
        notice = '网关拒绝了思考参数，已自动降级参数重试…';
      } else return result;
    } else if (/max_tokens|max_completion_tokens|max_output_tokens/i.test(result.error) && !learned.tokenCap && cfg.maxTokens > 4096) {
      learned.tokenCap = 4096;
      cfg.maxTokens = 4096;
      notice = '网关拒绝了输出长度，已降低长度重试…';
    } else return result;
    if (capabilities.size >= 128) capabilities.delete(capabilities.keys().next().value!);
    capabilities.set(key, { ...learned });
    opts.onNotice?.(notice);
    opts.onReset?.();
    if (opts.signal.aborted) return { ...result, aborted: true };
  }
}
