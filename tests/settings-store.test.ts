import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config';

const h = vi.hoisted(() => ({
  load: vi.fn<() => Promise<string | null>>(),
  save: vi.fn<(json: string) => Promise<void>>(),
}));

vi.mock('../src/bridge', () => ({
  bridge: {
    kind: 'web',
    loadSettings: h.load,
    saveSettings: h.save,
    stream: async () => undefined,
    appVersion: async () => 'test',
  },
}));

const { useSettings, flushSettingsSave } = await import('../src/settings');

beforeEach(() => {
  vi.useFakeTimers();
  h.load.mockReset();
  h.save.mockReset();
  h.save.mockResolvedValue(undefined);
  useSettings.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    loaded: false,
    loadError: null,
  });
});

describe('settings persistence', () => {
  it('does not write the in-memory defaults before the initial load finishes', () => {
    // Starting a game this early used to schedule a save of the default
    // profiles, overwriting the real settings file on disk.
    useSettings.getState().update({ players: { w: 'human', b: 'ai' } });
    vi.advanceTimersByTime(1000);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('persists edits after a successful load', async () => {
    h.load.mockResolvedValueOnce(null);
    await useSettings.getState().loadSettings();
    useSettings.getState().update({ players: { w: 'ai', b: 'ai' } });
    vi.advanceTimersByTime(400);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(h.save.mock.calls[0][0]);
    expect(saved.players).toEqual({ w: 'ai', b: 'ai' });
  });

  it('reports a failed load and keeps working on defaults', async () => {
    h.load.mockRejectedValueOnce(new Error('DPAPI 解密失败'));
    await useSettings.getState().loadSettings();
    const state = useSettings.getState();
    expect(state.loaded).toBe(true);
    expect(state.loadError).toContain('DPAPI');
    expect(state.settings.aiProfiles).toHaveLength(1);
  });

  it('flushSettingsSave writes a pending change immediately', async () => {
    h.load.mockResolvedValueOnce(null);
    await useSettings.getState().loadSettings();
    useSettings.getState().update({ orientation: 'b' });
    await flushSettingsSave();
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(h.save.mock.calls[0][0]);
    expect(saved.orientation).toBe('b');
  });

  it('blocks automatic saves after a malformed JSON load', async () => {
    h.load.mockResolvedValueOnce('{broken');
    await useSettings.getState().loadSettings();
    expect(useSettings.getState().loadError).toContain('设置文件内容损坏');
    useSettings.getState().updateUi({ theme: 'light' });
    vi.advanceTimersByTime(1000);
    expect(h.save).not.toHaveBeenCalled();
  });
});
