import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPersistence } from '../src/settingsPersistence';

afterEach(() => vi.useRealTimers());

describe('settings write ordering and close flush', () => {
  it('waits for an in-flight write and then saves the latest edit', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const persistence = new SettingsPersistence(write, vi.fn());
    persistence.schedule('first');
    vi.advanceTimersByTime(350);
    persistence.schedule('latest');
    const closed = vi.fn();
    const flushing = persistence.flush().then(closed);
    expect(closed).not.toHaveBeenCalled();
    expect(write.mock.calls.map((call) => call[0])).toEqual(['first']);
    finish();
    await flushing;
    expect(write.mock.calls.map((call) => call[0])).toEqual(['first', 'latest']);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('retains a failed payload for an explicit close retry', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const persistence = new SettingsPersistence(write, vi.fn());
    persistence.schedule('settings');
    await expect(persistence.flush()).rejects.toThrow('disk full');
    await persistence.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('settings');
  });
});
