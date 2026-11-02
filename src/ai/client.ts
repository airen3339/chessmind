import { bridge } from '../bridge';
import { getProvider } from './providers';
import type { AiConfig, ChatMessage, EmitHandlers, Usage } from './types';

export interface AttemptResult {
  status: number | null;
  aborted: boolean;
  error: string | null;
  usage: Usage | null;
  text: string;
  reasoning: string;
}

export interface AttemptCallbacks {
  onReasoning(text: string): void;
  onText(text: string): void;
}

/** One HTTP round trip against the configured provider. */
export async function runAttempt(opts: {
  cfg: AiConfig;
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  cb: AttemptCallbacks;
}): Promise<AttemptResult> {
  let reasoning = '';
  let text = '';
  let usage: Usage | null = null;
  let error: string | null = null;
  let status: number | null = null;

  const emit: EmitHandlers = {
    reasoning(chunk) {
      reasoning += chunk;
      opts.cb.onReasoning(chunk);
    },
    text(chunk) {
      text += chunk;
      opts.cb.onText(chunk);
    },
    usage(next) {
      // Streams report usage across several events (Anthropic sends input
      // tokens at `message_start` and output at `message_delta`). Merge only
      // defined fields so a later partial event cannot erase an earlier value.
      const merged: Usage = { ...(usage ?? {}) };
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) merged[key as keyof Usage] = value;
      }
      usage = merged;
    },
    done() {
      // The transport end event is authoritative.
    },
    error(nextStatus, message) {
      error = message;
      if (nextStatus !== null) status = nextStatus;
    },
  };

  const provider = getProvider(opts.cfg.protocol);
  const request = provider.buildRequest(opts.cfg, opts.system, opts.messages, opts.cfg.stream);

  if (!opts.cfg.stream) {
    let body = '';
    await bridge.stream(request, {
      signal: opts.signal,
      onEvent: (event) => {
        if (event.kind === 'chunk') body += event.text;
        else if (event.kind === 'response') status = event.status;
        else if (event.kind === 'error') {
          error = event.message;
          status = event.status ?? null;
        }
      },
    });
    if (error || opts.signal.aborted) return { status, aborted: opts.signal.aborted, error, usage, text, reasoning };
    let payload: unknown = null;
    try {
      payload = JSON.parse(body);
    } catch {
      return {
        status,
        aborted: false,
        error: `无法解析响应内容：${body.slice(0, 300)}`,
        usage,
        text,
        reasoning,
      };
    }
    provider.parseFull(payload, emit);
    return { status, aborted: opts.signal.aborted, error, usage, text, reasoning };
  }

  const decoder = provider.createDecoder(opts.cfg, emit);
  await bridge.stream(request, {
    signal: opts.signal,
    onEvent: (event) => {
      if (event.kind === 'chunk') decoder.push(event.text);
      else if (event.kind === 'response') status = event.status;
      else if (event.kind === 'end') decoder.end();
      else {
        error = event.message;
        status = event.status ?? null;
      }
    },
  });

  if (error) return { status, aborted: opts.signal.aborted, error, usage, text, reasoning };
  if (!text && reasoning) {
    // Some gateways put the whole answer into the reasoning channel.
    text = reasoning;
  }
  return { status, aborted: opts.signal.aborted, error, usage, text, reasoning };
}
