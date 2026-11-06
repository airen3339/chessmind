// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config';
import type { AttemptResult } from '../src/ai/client';
import { DEFAULT_COACH } from '../src/coach/types';

const h = vi.hoisted(() => ({ compatible: vi.fn() }));
vi.mock('../src/ai/compatible', () => ({ runCompatibleAttempt: h.compatible }));
const { App } = await import('../src/App');
const { SettingsPanel } = await import('../src/components/panels/SettingsPanel');
const { CoachPanel } = await import('../src/components/panels/CoachPanel');
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
    await clickText('跳过积压点评');
    await clickText('取消');
    expect(settings.getState().settings).toBe(original);
    expect(game.getState().coach.enabled).toBe(false);
  });

  it('saves the backlog switch with the new game and restores it when reopened', async () => {
    await render(createElement(App));
    await clickText('新对局');
    await clickText('双人本地对弈');
    await clickText('开启教练模式');
    const backlogSwitch = () => [...container.querySelectorAll('[role=switch]')]
      .find((item) => item.textContent?.includes('跳过积压点评'))!;
    expect(backlogSwitch().getAttribute('aria-checked')).toBe('true');
    await clickText('跳过积压点评');
    expect(backlogSwitch().getAttribute('aria-checked')).toBe('false');
    expect(settings.getState().settings.coach.skipBacklog).toBe(true);
    await clickText('开始对局');
    await clickText('确认结束当前对局并开始');
    expect(game.getState().coach.skipBacklog).toBe(false);
    expect(settings.getState().settings.coach.skipBacklog).toBe(false);
    await clickText('新对局');
    expect(backlogSwitch().getAttribute('aria-checked')).toBe('false');
    await clickText('取消');
  });

  it.each(['failed', 'missing'] as const)('lets the user generate a %s summary from a finished game', async (state) => {
    const result: AttemptResult = { status: 401, aborted: false, error: 'authentication failed', usage: null, text: '', reasoning: '' };
    h.compatible.mockResolvedValueOnce(result);
    await act(async () => {
      game.getState().startGame({ players: { w: 'human', b: 'human' },
        coach: { ...DEFAULT_COACH, enabled: true, opponentMoves: false, position: false },
        fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 38' });
      game.getState().humanMove('h1', 'h8');
    });
    expect(game.getState().coachSummary?.state).toBe('failed');
    if (state === 'missing') game.setState({ coachSummary: null });
    let finish!: (reply: AttemptResult) => void;
    h.compatible.mockImplementationOnce(() => new Promise<AttemptResult>((resolve) => { finish = resolve; }));
    await render(createElement(CoachPanel));
    expect(container.textContent).toContain(state === 'failed' ? 'authentication failed' : '本局尚未生成简评');
    await clickText(state === 'failed' ? '重试简评' : '生成对局简评');
    expect(container.querySelector('.coach-summary')?.getAttribute('data-state')).toBe('running');
    expect(container.textContent).toContain('正在总结这局棋');
    expect(container.querySelector('.coach-summary button')).toBeNull();
    expect(h.compatible).toHaveBeenCalledTimes(2);
    expect(h.compatible.mock.calls[1][0].messages[0].content).toContain('38. Rh8#');
    await act(async () => { finish({ status: 200, aborted: false, error: null, usage: null, text: '{"summary":"最终简评"}', reasoning: '' }); });
    expect(container.textContent).toContain('最终简评');
    expect(container.querySelector('.coach-summary')?.getAttribute('data-state')).toBe('done');
  });

  it('keeps the final move visible and displays skipped coaching without an API failure', async () => {
    let finishOld!: (reply: AttemptResult) => void;
    h.compatible.mockImplementationOnce(() => new Promise<AttemptResult>((resolve) => { finishOld = resolve; }))
      .mockResolvedValue({ status: 200, aborted: false, error: null, usage: null, text: '{"summary":"终局总结"}', reasoning: '' });
    await act(async () => {
      game.getState().startGame({ players: { w: 'human', b: 'human' }, coach: { ...DEFAULT_COACH, enabled: true },
        fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 38' });
      game.getState().humanMove('h1', 'h8');
    });
    await render(createElement(CoachPanel));
    expect(container.textContent).toContain('第 38 回合');
    expect(container.textContent).toContain('Rh8#');
    expect(container.textContent).toContain('已跳过');
    expect(container.textContent).toContain('终局总结');
    expect(container.querySelector('.coach-error')).toBeNull();
    await act(async () => { finishOld({ status: 200, aborted: false, error: null, usage: null, text: '{"move_review":"过期点评"}', reasoning: '' }); });
    expect(container.textContent).not.toContain('过期点评');
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
