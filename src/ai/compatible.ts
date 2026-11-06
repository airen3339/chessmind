import { runAttempt } from './client';
import { THINKING_EFFORTS } from './types';
import type { AiConfig, ThinkingEffort } from './types';

interface Capability {
  effort?: ThinkingEffort;
  noReasoning?: boolean;
  noCustom?: boolean;
  tokenCap?: number;
  omitMaxOutputTokens?: boolean;
}

// Shared by playing, coaching and connection tests. Bound the cache so editing
// many endpoints cannot retain an unlimited number of credentials/configs.
const capabilities = new Map<string, Capability>();

/** Distinguish an unsupported parameter name from an invalid numeric value. */
function rejectsResponsesOutputLimit(raw: string): boolean {
  let message = raw;
  try {
    const payload = JSON.parse(raw);
    const detail = payload?.error ?? payload;
    const param = typeof detail?.param === 'string' ? detail.param : '';
    if (param && param !== 'max_output_tokens') return false;
    if (typeof detail?.message === 'string') message = detail.message;
    if (detail?.code === 'unsupported_parameter') {
      return param === 'max_output_tokens' || /\bmax_output_tokens\b/i.test(message);
    }
    if (detail?.code && detail.code !== 'invalid_request_error') return false;
  } catch { /* Some gateways return an unstructured error body. */ }
  return /(?:unsupported|unknown|unrecognized)\s+(?:request\s+)?(?:parameter|argument|field)\s*[:：]?\s*["'`]?max_output_tokens\b/i.test(message)
    || /(?:暂)?不支持\s*[:：]\s*["'`]?max_output_tokens\b/i.test(message);
}

const DEFAULT_OUTPUT_NOTICE = '接口不支持 max_output_tokens，本次未发送输出上限，使用服务商默认上限；此兼容处理不改变思考强度。';

export async function runCompatibleAttempt(
  opts: Parameters<typeof runAttempt>[0] & {
    onNotice?(message: string): void;
    onReset?(): void;
  },
): ReturnType<typeof runAttempt> {
  const key = JSON.stringify([opts.cfg.protocol, opts.cfg.baseUrl, opts.cfg.model,
    opts.cfg.thinkingMode, opts.cfg.apiKey, opts.cfg.extraHeaders, opts.cfg.stream]);
  const learned = { ...capabilities.get(key) };
  const notices = new Set<string>();
  if (learned.omitMaxOutputTokens) {
    notices.add(DEFAULT_OUTPUT_NOTICE);
    opts.onNotice?.(DEFAULT_OUTPUT_NOTICE);
  }
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
    const result = await runAttempt({ ...opts, cfg, requestOptions: {
      ...opts.requestOptions,
      ...(learned.omitMaxOutputTokens ? { omitMaxOutputTokens: true } : {}),
    } });
    const finish = () => notices.size ? { ...result, notices: [...notices] } : result;
    if (result.aborted || !result.error || (result.status !== 400 && result.status !== 422)) return finish();
    let notice: string;
    if (cfg.protocol === 'openai-responses' && !learned.omitMaxOutputTokens && rejectsResponsesOutputLimit(result.error)) {
      learned.omitMaxOutputTokens = true;
      notice = DEFAULT_OUTPUT_NOTICE;
    } else if (cfg.protocol === 'openai-responses' && /\bmax_output_tokens\b/i.test(result.error)) {
      // Numeric range errors are not evidence that the parameter is unsupported.
      // Return the actual error instead of removing a valid cap or lowering
      // reasoning; an already attempted omission must not loop either.
      return finish();
    } else if (/reason|effort|think|budget/i.test(result.error) && cfg.reasoning) {
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
      } else return finish();
    } else if (/max_tokens|max_completion_tokens|max_output_tokens/i.test(result.error) && !learned.tokenCap && cfg.maxTokens > 4096) {
      learned.tokenCap = 4096;
      cfg.maxTokens = 4096;
      notice = '网关拒绝了输出长度，已降低长度重试…';
    } else return finish();
    if (capabilities.size >= 128) capabilities.delete(capabilities.keys().next().value!);
    capabilities.set(key, { ...learned });
    opts.onReset?.();
    notices.add(notice);
    opts.onNotice?.(notice);
    if (opts.signal.aborted) return { ...result, aborted: true, notices: [...notices] };
  }
}
