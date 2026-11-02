import type { StreamRequest } from '../ai/types';
import type { Bridge, StreamHandlers } from './types';

const STORAGE_KEY = 'chessmind.settings.v1';

/** Browser fallback so the UI can be developed and tested in a plain tab. */
export const webBridge: Bridge = {
  kind: 'web',

  async stream(request: StreamRequest, handlers: StreamHandlers): Promise<void> {
    const controller = new AbortController();
    // The browser fallback has no Rust-side timeout; honour the same setting so
    // a stalled gateway cannot hang the UI forever.
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(10, request.timeout_secs ?? 180) * 1000,
    );
    const onAbort = () => controller.abort();
    handlers.signal.addEventListener('abort', onAbort, { once: true });
    if (handlers.signal.aborted) controller.abort();
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        redirect: 'error',
      });
      handlers.onEvent({ kind: 'response', status: response.status });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        handlers.onEvent({
          kind: 'error',
          status: response.status,
          message: text.slice(0, 2000) || response.statusText,
        });
        return;
      }
      if (!response.body) {
        const text = await response.text();
        handlers.onEvent({ kind: 'chunk', text });
        handlers.onEvent({ kind: 'end' });
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (handlers.signal.aborted) break;
        handlers.onEvent({ kind: 'chunk', text: decoder.decode(value, { stream: true }) });
      }
      const tail = decoder.decode();
      if (tail) handlers.onEvent({ kind: 'chunk', text: tail });
      handlers.onEvent({ kind: 'end' });
    } catch (error) {
      if (!handlers.signal.aborted) {
        const message =
          controller.signal.aborted && !handlers.signal.aborted
            ? `请求超时（${request.timeout_secs ?? 180}s）`
            : error instanceof Error
              ? error.message
              : String(error);
        handlers.onEvent({ kind: 'error', status: null, message });
      }
    } finally {
      clearTimeout(timeout);
      handlers.signal.removeEventListener('abort', onAbort);
    }
  },

  async loadSettings(): Promise<string | null> {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },

  async saveSettings(json: string): Promise<void> {
    try {
      window.localStorage.setItem(STORAGE_KEY, json);
    } catch {
      throw new Error('无法保存浏览器配置，请检查存储权限与可用空间');
    }
  },

  async appVersion(): Promise<string> {
    return 'web';
  },
};
