import { useMemo } from 'react';
import { Bot, User, Crown } from 'lucide-react';
import { useGame } from '../../game/store';
import { getEngine } from '../../game/store';
import { materialOf } from '../../game/material';
import type { MoveEntry, Side } from '../../game/types';
import { PieceGlyph } from '../board/PieceGlyph';

export function GamePanel() {
  const players = useGame((s) => s.players);
  const turn = useGame((s) => s.turn);
  const moveLog = useGame((s) => s.moveLog);
  const result = useGame((s) => s.result);
  const mode = useGame((s) => s.mode);
  const thinking = useGame((s) => s.thinking);
  const fen = useGame((s) => s.fen);
  const version = useGame((s) => s.version);
  const gameProfiles = useGame((s) => s.gameProfiles);

  const labels = useMemo(
    () => ({
      w: gameProfiles.w.name,
      b: gameProfiles.b.name,
    }),
    [gameProfiles],
  );

  const material = useMemo(() => {
    try {
      return materialOf(getEngine());
    } catch {
      return null;
    }
  }, [fen, version]);

  const diff = material ? material.w - material.b : 0;
  const rows = useMemo(() => buildRows(moveLog), [moveLog]);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(['b', 'w'] as Side[]).map((side) => (
          <PlayerCard
            key={side}
            side={side}
            actor={players[side]}
            active={mode === 'playing' && turn === side}
            thinking={thinking && turn === side}
            model={labels[side]}
            advantage={
              material
                ? side === 'w'
                  ? diff > 0
                    ? `+${diff}`
                    : ''
                  : diff < 0
                    ? `+${-diff}`
                    : ''
                : ''
            }
          />
        ))}
      </div>

      {result && (
        <div
          className="result-banner"
          data-kind={result.winner === null ? 'draw' : 'win'}
        >
          <Crown size={15} />
          {result.text}
        </div>
      )}

      {material && (
        <div className="material-row">
          <span>子力</span>
          <span>
            白 {material.w} · 黑 {material.b}{' '}
            <span className="material-diff">
              {diff === 0 ? '均势' : diff > 0 ? `白 +${diff}` : `黑 +${-diff}`}
            </span>
          </span>
        </div>
      )}

      <div className="divider" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <p className="section-title">棋谱</p>
          <span className="faint" style={{ fontSize: 11 }}>
            {moveLog.filter((entry) => entry.actor !== 'edit').length} 半回合
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="empty-state" style={{ padding: '14px 8px' }}>
            还没有走子。开始对局后棋谱会显示在这里。
          </div>
        ) : (
          <div className="moves">
            {rows.map((row) => {
              if (row.kind === 'edit') {
                return (
                  <div key={row.key} className="move-row">
                    <div className="move-edit">— 局面已编辑，之后的对局从此处继续 —</div>
                  </div>
                );
              }
              return (
                <div key={row.key} className="move-row">
                  <div className="move-no">{row.number}.</div>
                  <div className="move-san" data-last={row.whiteIsLast}>
                    {row.white ?? ''}
                  </div>
                  <div className="move-san" data-last={row.blackIsLast}>
                    {row.black ?? ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="divider" />
      <div className="faint mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>
        {fen}
      </div>
    </>
  );
}

function PlayerCard({
  side,
  actor,
  active,
  thinking,
  model,
  advantage,
}: {
  side: Side;
  actor: 'human' | 'ai';
  active: boolean;
  thinking: boolean;
  /** Saved AI profile name, shown instead of a bare model id. */
  model: string;
  advantage: string;
}) {
  return (
    <div className="player-card" data-active={active}>
      <span className="player-swatch" data-side={side}>
        <PieceGlyph type="k" color={side} size={20} />
      </span>
      <div className="player-meta">
        <span className="player-name">
          {side === 'w' ? '白方' : '黑方'} · {actor === 'human' ? '人类' : 'AI'}
          {advantage ? ` ${advantage}` : ''}
        </span>
        <span className="player-sub">
          {actor === 'human' ? '点击或拖拽棋子走棋' : model}
        </span>
      </div>
      <span className="player-tag" data-kind={thinking ? 'thinking' : actor === 'ai' ? 'ai' : 'human'}>
        {thinking ? '思考中' : actor === 'ai' ? <Bot size={12} /> : <User size={12} />}
      </span>
    </div>
  );
}

type Row =
  | { kind: 'edit'; key: string }
  | {
      kind: 'move';
      key: string;
      number: number;
      white?: string;
      black?: string;
      whiteIsLast: boolean;
      blackIsLast: boolean;
    };

function buildRows(log: MoveEntry[]): Row[] {
  const rows: Row[] = [];
  const last = log[log.length - 1];
  let current: Extract<Row, { kind: 'move' }> | null = null;

  for (let i = 0; i < log.length; i += 1) {
    const entry = log[i];
    if (entry.actor === 'edit') {
      current = null;
      rows.push({ kind: 'edit', key: `edit-${i}` });
      continue;
    }
    if (!current || entry.color === 'w' || current.black !== undefined) {
      current = {
        kind: 'move',
        key: `move-${i}`,
        number: entry.number,
        whiteIsLast: false,
        blackIsLast: false,
      };
      rows.push(current);
    }
    if (entry.color === 'w') current.white = entry.san;
    else current.black = entry.san;
  }

  if (last && last.actor !== 'edit') {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.kind !== 'move') continue;
      if (last.color === 'w') row.whiteIsLast = true;
      else row.blackIsLast = true;
      break;
    }
  }

  return rows;
}
