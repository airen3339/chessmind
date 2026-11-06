// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config';
import type { AttemptResult } from '../src/ai/client';

const h = vi.hoisted(() => ({ compatible: vi.fn() }));
vi.mock('../src/ai/compatible', () => ({ runCompatibleAttempt: h.compatible }));
const { App } = await import('../src/App');
const { SettingsPanel } = await import('../src/components/panels/SettingsPanel');
const { useGame: game } = await import('../src/game/store');
const { useSettings: settings } = await import('../src/settings');
let container: HTMLDivElement;
let root: Root;
const render = async (component: ReturnType<typeof createElement>) => { await act(async () => { root.render(component); }); };
const clickText = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => { button!.click(); });
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.compatible.mockReset();
  localStorage.clear();
  settings.setState({ settings: structuredClone(DEFAULT_SETTINGS), loaded: false, loadError: null });
  game.getState().startGame({ players: { w: 'human', b: 'human' }, orientation: 'w' });
  settings.setState({ loaded: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  game.getState().abortAi();
  container.remove();
});

describe('audit: UI event integration', () => {
  it('tests the selected Responses transport and displays output-limit compatibility notices', async () => {
    await act(async () => { settings.getState().updateAi({ protocol: 'openai-responses', stream: true, effort: 'xhigh' }); });
    h.compatible.mockResolvedValue({ status: 200, aborted: false, error: null, usage: null, text: 'OK', reasoning: '', notices: ['使用服务商默认上限'] });
    await render(createElement(SettingsPanel));
    await clickText('测试连接');
    expect(h.compatible.mock.calls[0][0].cfg).toMatchObject({ protocol: 'openai-responses', stream: true, effort: 'xhigh' });
    expect(container.textContent).toContain('连接成功');
    expect(container.textContent).toContain('使用服务商默认上限');
  });

  it('consumes board Space without pausing and highlights the visual black-side cursor', async () => {
    await render(createElement(App));
    await act(async () => { game.getState().startGame({ players: { w: 'human', b: 'human' }, orientation: 'b' }); });
    const board = container.querySelector<HTMLElement>('[role=grid]')!;
    await act(async () => { board.focus(); });
    expect(container.querySelector('.sq--focus')?.getAttribute('data-square')).toBe('h1');
    await act(async () => { board.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    expect(container.querySelector('.sq--focus')?.getAttribute('data-square')).toBe('g1');
    await act(async () => { board.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    expect(game.getState().mode).toBe('playing');
    expect(container.querySelector('.sq--selected')?.getAttribute('data-square')).toBe('g1');
    await act(async () => { board.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
    expect(game.getState().mode).toBe('paused');
  });

  it('discards new-game profile and coach edits when the dialog is cancelled', async () => {
    await render(createElement(App));
    await act(async () => {
      settings.setState({ settings: { ...settings.getState().settings,
        aiProfiles: [
          { ...settings.getState().settings.aiProfiles[0], id: 'A' },
          { ...settings.getState().settings.aiProfiles[0], id: 'B', name: 'B' },
        ], aiSelection: { w: 'A', b: 'A' }, activeProfile: 'A' } });
    });
    const original = settings.getState().settings;
    await clickText('新对局');
    await clickText('我执白');
    const select = container.querySelector<HTMLSelectElement>('.modal select')!;
    await act(async () => { select.value = 'B'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await clickText('开启教练模式');
    await clickText('取消');
    expect(settings.getState().settings).toBe(original);
    expect(game.getState().coach.enabled).toBe(false);
  });

  it('ignores a stale connection result after changing the selected profile', async () => {
    let finish!: (result: AttemptResult) => void;
    h.compatible.mockImplementation(() => new Promise<AttemptResult>((resolve) => { finish = resolve; }));
    await render(createElement(SettingsPanel));
    await clickText('测试连接');
    const signal = h.compatible.mock.calls[0][0].signal as AbortSignal;
    await act(async () => { settings.getState().addProfile('another'); });
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ status: 200, aborted: false, error: null, usage: null, text: 'OLD_ENDPOINT', reasoning: '' }); });
    expect(container.textContent).not.toContain('OLD_ENDPOINT');
    expect(container.textContent).not.toContain('连接成功');
  });
});
