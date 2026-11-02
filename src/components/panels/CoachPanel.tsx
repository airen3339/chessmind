import { useEffect, useMemo, useRef } from 'react';
import { GraduationCap, Lightbulb, MessageSquareQuote, TrendingUp, Trophy } from 'lucide-react';
import { COACH_OPTIONS } from '../../coach/types';
import type { CoachEntry } from '../../game/store';
import { useGame } from '../../game/store';
import type { Actor, Side } from '../../game/types';

function sideWord(side: Side): string {
  return side === 'w' ? '白方' : '黑方';
}

export function CoachPanel() {
  const coach = useGame((s) => s.coach);
  const log = useGame((s) => s.coachLog);
  const summary = useGame((s) => s.coachSummary);
  const players = useGame((s) => s.players);
  const profile = useGame((s) => s.gameProfiles.coach);
  const chipsRef = useRef<HTMLDivElement>(null);

  // Newest card is at the top, so a new entry arrives where the eye already is.
  useEffect(() => {
    const scroller = chipsRef.current?.closest('.panel-body');
    if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
  }, [log.length, summary?.state]);

  const active = useMemo(() => COACH_OPTIONS.filter((option) => coach[option.key]), [coach]);
  const busy = log.some((entry) => entry.pending) || summary?.state === 'running';

  return (
    <>
      <div className="ai-head">
        <span className="ai-badge" data-tone={busy ? 'live' : 'ok'}>
          {busy ? <span className="spinner" /> : <GraduationCap size={12} />}
          {busy ? '请求中' : '教练模式'}
        </span>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {profile.name} · {profile.config.model || '未设置模型'}
        </span>
      </div>

      <div className="coach-chips" ref={chipsRef}>
        {active.length === 0 ? (
          <span className="coach-chip" data-on="false">
            六个选项全关，教练不会说话
          </span>
        ) : (
          active.map((option) => (
            <span key={option.key} className="coach-chip">
              {option.label}
            </span>
          ))
        )}
      </div>

      {summary && (
        <div className="coach-summary" data-state={summary.state}>
          <div className="thinking-head">
            <Trophy size={13} /> 对局简评
            {summary.state === 'running' && (
              <span className="spinner" style={{ marginLeft: 'auto' }} />
            )}
          </div>
          <div className="coach-summary-body">
            {summary.state === 'failed'
              ? `教练没能给出简评：${summary.error ?? '请求失败'}`
              : (summary.text ?? '正在总结这局棋…')}
          </div>
        </div>
      )}

      {log.length === 0 && !summary ? (
        <div className="empty-state">
          <GraduationCap size={26} style={{ opacity: 0.5, marginBottom: 8 }} />
          <div>教练还没有说话。</div>
          <div style={{ marginTop: 6 }}>
            走完一步后会在这里出现点评与局势解读；轮到你走棋时也可以在棋盘下方请求指导。
          </div>
        </div>
      ) : (
        [...log]
          .reverse()
          .map((entry) => <CoachCard key={entry.id} entry={entry} players={players} />)
      )}
    </>
  );
}

function CoachCard({
  entry,
  players,
}: {
  entry: CoachEntry;
  players: { w: Actor; b: Actor };
}) {
  const hint = entry.kind === 'hint';
  // For an engine move the first paragraph is the engine's own explanation;
  // for a human move it is the coach's verdict.
  const ownMove = !hint && players[entry.side] === 'ai';

  return (
    <div className="coach-entry" data-kind={entry.kind} data-pending={entry.pending}>
      <div className="coach-entry-head">
        <span className="coach-entry-round">第 {entry.number} 回合</span>
        <span className="coach-entry-side">{sideWord(entry.side)}</span>
        {!hint && entry.san && <span className="coach-entry-san">{entry.san}</span>}
        <span className="coach-entry-state">
          {entry.pending ? (
            <>
              <span className="spinner" /> 请求中
            </>
          ) : entry.error ? (
            '失败'
          ) : (
            `${(entry.elapsedMs / 1000).toFixed(1)}s`
          )}
        </span>
      </div>

      {hint && (
        <section className="coach-part" data-part="hint">
          <header className="coach-part-head">
            <Lightbulb size={11} /> 建议
          </header>
          {entry.pending ? (
            <p className="coach-text">教练正在看这个局面…</p>
          ) : entry.san ? (
            <>
              <span className="coach-suggest">{entry.san}</span>
              <p className="coach-text">{entry.verdict || '教练没有说明理由。'}</p>
            </>
          ) : (
            <p className="coach-text">教练没有给出合法的推荐着法。</p>
          )}
        </section>
      )}

      {!hint && (entry.verdict !== null || (entry.pending && entry.expects.verdict)) && (
        <section className="coach-part" data-part="verdict">
          <header className="coach-part-head">
            <MessageSquareQuote size={11} />
            {ownMove ? '着法解释' : '点评'}
          </header>
          <p className="coach-text">{entry.verdict ?? '教练正在看这一手…'}</p>
        </section>
      )}

      {!hint && (entry.read !== null || (entry.pending && entry.expects.read)) && (
        <section className="coach-part" data-part="read">
          <header className="coach-part-head">
            <TrendingUp size={11} /> 局势
          </header>
          <p className="coach-text">{entry.read ?? '正在读这个局面…'}</p>
        </section>
      )}

      {entry.error && <div className="coach-error">教练请求失败：{entry.error}</div>}
    </div>
  );
}
