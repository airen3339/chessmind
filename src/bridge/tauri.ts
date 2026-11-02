import { Channel, invoke } from '@tauri-apps/api/core';
import type { StreamEvent, StreamRequest } from '../ai/types';
import type { Bridge, StreamHandlers } from './types';

export const tauriBridge: Bridge = {
  kind: 'tauri',

  async stream(request: StreamRequest, handlers: StreamHandlers): Promise<void> {
    const id = `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = new Channel<StreamEvent>();
    const abort = () => {
      void invoke('llm_abort', { id }).catch(() => undefined);
    };
    channel.onmessage = (event) => {
      if (handlers.signal.aborted) return;
      handlers.onEvent(event);
    };
    if (handlers.signal.aborted) {
      handlers.onEvent({ kind: 'error', status: null, message: '请求已取消' });
      return;
    }
    handlers.signal.addEventListener('abort', abort, { once: true });
    try {
      await invoke('llm_stream', { id, request, onEvent: channel });
    } catch (error) {
      if (!handlers.signal.aborted) {
        handlers.onEvent({ kind: 'error', status: null, message: String(error) });
      }
    } finally {
      handlers.signal.removeEventListener('abort', abort);
    }
  },

  async loadSettings(): Promise<string | null> {
    // Let failures surface: silently falling back to the defaults would look
    // like the user's profiles and keys had been wiped.
    return await invoke<string | null>('read_settings');
  },

  async saveSettings(json: string): Promise<void> {
    await invoke('write_settings', { json });
  },

  async appVersion(): Promise<string> {
    try {
      return await invoke<string>('app_version');
    } catch {
      return '1.1.1';
    }
  },
};
