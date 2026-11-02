import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ onCloseRequested: vi.fn(), destroy: vi.fn(), flush: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: h.onCloseRequested, destroy: h.destroy }) }));
vi.mock('../src/bridge/types', () => ({ isTauri: () => true }));
vi.mock('../src/settings', () => ({ flushSettingsSave: h.flush }));
const { installCloseGuard } = await import('../src/windowLifecycle');

beforeEach(() => { h.onCloseRequested.mockReset().mockResolvedValue(() => {}); h.destroy.mockReset().mockResolvedValue(undefined); h.flush.mockReset(); });

describe('desktop close guard', () => {
  it('prevents native close until all settings writes finish', async () => {
    let finish!: () => void;
    h.flush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await installCloseGuard(vi.fn());
    const preventDefault = vi.fn();
    h.onCloseRequested.mock.calls[0][0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.destroy).not.toHaveBeenCalled();
    finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the window open and allows another close attempt after a failed save', async () => {
    h.flush.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const notify = vi.fn();
    await installCloseGuard(notify);
    const close = h.onCloseRequested.mock.calls[0][0];
    close({ preventDefault() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toContain('窗口保持打开');
    close({ preventDefault() {} });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.destroy).toHaveBeenCalledOnce();
  });
});
