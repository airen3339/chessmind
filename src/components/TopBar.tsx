import { useMemo } from 'react';
import {
  Flag,
  FlipVertical2,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useGame } from '../game/store';
import { sideNameZh } from '../game/engine';

export interface TopBarProps {
  onNewGame(): void;
  onOpenSettings(): void;
}

export function TopBar({ onNewGame, onOpenSettings }: TopBarProps) {
  const mode = useGame((s) => s.mode);
  const turn = useGame((s) => s.turn);
  const players = useGame((s) => s.players);
  const thinking = useGame((s) => s.thinking);
  const result = useGame((s) => s.result);
  const aiTurn = useGame((s) => s.aiTurn);
  const aiError = useGame((s) => s.aiError);
  const togglePause = useGame((s) => s.togglePause);
  const undo = useGame((s) => s.undo);
  const flip = useGame((s) => s.flip);
  const openSetup = useGame((s) => s.openSetup);
  const finishGame = useGame((s) => s.finishGame);
  const snapshots = useGame((s) => s.snapshots);

  const status = useMemo(() => {
    if (mode === 'setup') return { tone: 'live', text: '摆棋编辑中 — 摆放完成后点击「开始对局」' };
    if (mode === 'idle') return { tone: '', text: '尚未开始对局 — 点击「新对局」开始' };
    if (mode === 'finished' && result) return { tone: 'done', text: `对局结束：${result.text}` };
    if (mode === 'paused') {
      if (aiError) return { tone: 'error', text: `AI 出错已暂停：${aiError}` };
      return { tone: '', text: '对局已暂停 — 点击继续恢复' };
    }
    if (thinking) {
      const attempt = aiTurn ? `（第 ${aiTurn.attempt}/${aiTurn.limit} 次尝试）` : '';
      return { tone: 'think', text: `${sideNameZh(turn)} AI 思考中${attempt}` };
    }
    const actor = players[turn];
    return {
      tone: 'live',
      text:
        actor === 'human'
          ? `轮到你走棋（${sideNameZh(turn)}）`
          : `轮到 ${sideNameZh(turn)} AI`,
    };
  }, [mode, result, aiError, thinking, aiTurn, players, turn]);

  const canUndo = snapshots.length > 1;
  const active = mode === 'playing' || mode === 'paused' || mode === 'finished';

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Sparkles size={18} />
        </span>
        <div>
          <div className="brand-title">ChessMind</div>
          <div className="brand-sub">LLM Chess Arena</div>
        </div>
      </div>

      <div className="status-pill" data-tone={status.tone} title={status.text}>
        <span className="dot" />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {status.text}
        </span>
      </div>

      <div className="topbar-actions">
        <button type="button" className="btn btn--primary" onClick={onNewGame} disabled={mode === 'setup'}>
          <Plus size={15} /> 新对局
        </button>
        <button
          type="button"
          className="btn"
          onClick={togglePause}
          disabled={mode !== 'playing' && mode !== 'paused'}
          title={mode === 'paused' ? '继续对局' : '暂停对局（会中断进行中的 AI 请求）'}
        >
          {mode === 'paused' ? <Play size={15} /> : <Pause size={15} />}
          {mode === 'paused' ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={undo}
          disabled={!canUndo}
          title="悔棋（回退到上一次你走棋的局面）"
        >
          <Undo2 size={15} /> 悔棋
        </button>
        <button type="button" className="btn" onClick={flip} title="翻转棋盘">
          <FlipVertical2 size={15} /> 翻转
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => openSetup({ source: active ? 'midgame' : 'new' })}
          disabled={mode === 'setup'}
          title="摆棋：任意增删棋子后开始或继续对局"
        >
          <LayoutGrid size={15} /> 摆棋
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => finishGame('resigned')}
          disabled={!active || mode === 'finished'}
          title="结束当前对局"
        >
          <Flag size={15} /> 结束
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings2 size={16} />
        </button>
      </div>
    </header>
  );
}
