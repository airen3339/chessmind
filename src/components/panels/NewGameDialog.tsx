import { useEffect, useState } from 'react';
import { Bot, GraduationCap, LayoutGrid, Users } from 'lucide-react';
import { useGame } from '../../game/store';
import { useSettings, coachProfileFor } from '../../settings';
import { COACH_OPTIONS } from '../../coach/types';
import type { CoachConfig, CoachOptionKey } from '../../coach/types';
import type { Actor, Side } from '../../game/types';
import { Modal } from '../ui/Modal';
import { Switch } from '../ui/Switch';

export interface NewGameDialogProps {
  open: boolean;
  onClose(): void;
}

type Preset = 'white' | 'black' | 'ai-vs-ai' | 'human-vs-human';

const PRESETS: {
  id: Preset;
  title: string;
  sub: string;
  players: { w: Actor; b: Actor };
  orientation: Side;
  icon: typeof Bot;
}[] = [
  {
    id: 'white',
    title: '我执白，AI 执黑',
    sub: '你先走，AI 应战',
    players: { w: 'human', b: 'ai' },
    orientation: 'w',
    icon: Users,
  },
  {
    id: 'black',
    title: '我执黑，AI 执白',
    sub: 'AI 先走，你后手',
    players: { w: 'ai', b: 'human' },
    orientation: 'b',
    icon: Users,
  },
  {
    id: 'ai-vs-ai',
    title: 'AI 对 AI',
    sub: '两个模型自动对弈，可随时暂停',
    players: { w: 'ai', b: 'ai' },
    orientation: 'w',
    icon: Bot,
  },
  {
    id: 'human-vs-human',
    title: '双人本地对弈',
    sub: '同一台电脑轮流走棋',
    players: { w: 'human', b: 'human' },
    orientation: 'w',
    icon: Users,
  },
];

type Start = 'standard' | 'blank' | 'current';

export function NewGameDialog({ open, onClose }: NewGameDialogProps) {
  const [preset, setPreset] = useState<Preset>('white');
  const [start, setStart] = useState<Start>('standard');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const startGame = useGame((s) => s.startGame);
  const openSetup = useGame((s) => s.openSetup);
  const currentFen = useGame((s) => s.fen);
  const mode = useGame((s) => s.mode);
  const settings = useSettings((s) => s.settings);
  const [selection, setSelection] = useState({ ...settings.aiSelection });
  const [coach, setCoach] = useState({ ...settings.coach });
  const setSideProfile = (side: Side, id: string) => setSelection((current) => ({ ...current, [side]: id }));
  const updateCoach = (patch: Partial<CoachConfig>) => setCoach((current) => ({ ...current, ...patch }));
  const updateCoachOption = (key: CoachOptionKey, value: boolean) => updateCoach({ [key]: value });
  useEffect(() => {
    if (!open) return;
    const saved = useSettings.getState().settings;
    setSelection({ ...saved.aiSelection });
    setCoach({ ...saved.coach });
    setPreset(PRESETS.find((item) => item.players.w === saved.players.w && item.players.b === saved.players.b)?.id ?? 'white');
    setConfirmReplace(false);
  }, [open]);

  const chosen = PRESETS.find((item) => item.id === preset) ?? PRESETS[0];
  const needsWhite = chosen.players.w === 'ai';
  const needsBlack = chosen.players.b === 'ai';
  /** There is a live game whose result would be discarded by starting over. */
  const hasLiveGame = mode === 'playing' || mode === 'paused' || mode === 'finished';
  /** Profile that will answer coach requests for the setup chosen above. */
  const coachPick = coachProfileFor({ ...settings, coach, aiSelection: selection }, chosen.players);

  const profileLabel = (id: string): string => {
    const profile = settings.aiProfiles.find((item) => item.id === id);
    if (!profile) return '未设置';
    const c = profile.config;
    return `${profile.name} · ${c.model || '未设置模型'}`;
  };

  // A fresh dialog must not open pre-armed with the previous confirmation.
  useEffect(() => {
    if (!open) setConfirmReplace(false);
  }, [open]);

  const begin = () => {
    if (mode === 'setup') return;
    // Starting over mid-game discards the current one; make that explicit
    // instead of silently replacing it. Choosing "从当前局面开始" keeps the
    // position, so it does not need the warning.
    if (hasLiveGame && start !== 'current' && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    if (start === 'blank') {
      onClose();
      openSetup({
        source: 'new',
        blank: true,
        players: chosen.players,
        orientation: chosen.orientation,
        coach,
        aiSelection: selection,
      });
      return;
    }
    if (start === 'current' && mode !== 'idle') {
      onClose();
      openSetup({
        source: 'new',
        fen: currentFen,
        players: chosen.players,
        orientation: chosen.orientation,
        coach,
        aiSelection: selection,
      });
      return;
    }
    startGame({
      players: chosen.players,
      orientation: chosen.orientation,
      coach,
      aiSelection: selection,
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="开始新对局" subtitle="选择谁执白、谁执黑，以及起始局面。">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="section-title">对局双方</p>
        <div className="choice-grid">
          {PRESETS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="choice"
              data-active={preset === item.id}
              onClick={() => setPreset(item.id)}
            >
              <span className="choice-title">
                <item.icon size={14} /> {item.title}
              </span>
              <span className="choice-sub">{item.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {(needsWhite || needsBlack) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="section-title">AI 配置</p>
          <div className="row">
            {needsWhite && (
              <label className="field">
                <span className="field-label">白方 AI</span>
                <select
                  className="select"
                  value={selection.w}
                  onChange={(event) => setSideProfile('w', event.target.value)}
                >
                  {settings.aiProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.config.model}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {needsBlack && (
              <label className="field">
                <span className="field-label">黑方 AI</span>
                <select
                  className="select"
                  value={selection.b}
                  onChange={(event) => setSideProfile('b', event.target.value)}
                >
                  {settings.aiProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.config.model}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <span className="field-hint">
            每个配置在「设置 → AI 配置」中管理。对局开始时固定所选配置，后续修改用于下一局。
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="section-title">
          <GraduationCap size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          教练模式
        </p>
        <div className="coach-block" data-on={coach.enabled}>
          <Switch
            title="开启教练模式"
            sub="AI 除了走棋，还会给你讲棋。"
            on={coach.enabled}
            onChange={(value) => updateCoach({ enabled: value })}
          />
          {coach.enabled && (
            <div className="coach-block-body">
              {COACH_OPTIONS.map((option) => (
                <Switch
                  key={option.key}
                  title={option.label}
                  sub={option.sub}
                  on={coach[option.key]}
                  onChange={(value) => updateCoachOption(option.key, value)}
                />
              ))}
              <label className="field">
                <span className="field-label">教练配置</span>
                <select
                  className="select"
                  value={coach.profileId}
                  onChange={(event) => updateCoach({ profileId: event.target.value })}
                >
                  <option value="">自动</option>
                  {settings.aiProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.config.model}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  教练将使用：{coachPick.name} · {coachPick.config.model || '未设置模型'}。
                  「自动」会跟随对手 AI，没有 AI 时自动选择。
                </span>
              </label>
              <span className="field-hint">
                思维链与自己的着法解释只对 AI 一方生效；点评在 AI 对 AI 时不出现。
              </span>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="section-title">起始局面</p>
        <div className="choice-grid">
          <button
            type="button"
            className="choice"
            data-active={start === 'standard'}
            onClick={() => setStart('standard')}
          >
            <span className="choice-title">标准开局</span>
            <span className="choice-sub">常规初始局面</span>
          </button>
          <button
            type="button"
            className="choice"
            data-active={start === 'blank'}
            onClick={() => setStart('blank')}
          >
            <span className="choice-title">
              <LayoutGrid size={14} /> 空白棋盘自由摆放
            </span>
            <span className="choice-sub">进入摆棋编辑器，任意增删棋子后开始</span>
          </button>
          <button
            type="button"
            className="choice"
            data-active={start === 'current'}
            onClick={() => setStart('current')}
            disabled={mode === 'idle'}
          >
            <span className="choice-title">从当前局面开始</span>
            <span className="choice-sub">
              {mode === 'idle' ? '当前还没有局面' : '复制当前棋盘局面，棋谱清空'}
            </span>
          </button>
        </div>
      </div>

      <div className="alert">
        {needsWhite && (
          <div>白方：{profileLabel(selection.w)}</div>
        )}
        {needsBlack && (
          <div>黑方：{profileLabel(selection.b)}</div>
        )}
        {!needsWhite && !needsBlack && <div>本局没有 AI 参与。</div>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn--primary" onClick={begin}>
          {confirmReplace
            ? '确认结束当前对局并开始'
            : start === 'blank'
              ? '进入摆棋'
              : '开始对局'}
        </button>
      </div>
      {confirmReplace && (
        <div className="alert" style={{ marginTop: 8 }}>
          当前对局尚未结束，开始新对局会丢弃它的棋谱。再点一次「确认结束当前对局并开始」即可继续。
        </div>
      )}
    </Modal>
  );
}
