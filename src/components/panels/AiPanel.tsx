import { useEffect, useMemo, useRef } from 'react';
import { AlertTriangle, Brain, RotateCw, Wand2 } from 'lucide-react';
import { useGame } from '../../game/store';
import { cachedShare } from '../../ai/context';
import { isCoachOn } from '../../coach/types';
import type { AttemptRecord } from '../../ai/types';

export function AiPanel() {
  const aiTurn = useGame((s) => s.aiTurn);
  const thinking = useGame((s) => s.thinking);
  const aiError = useGame((s) => s.aiError);
  const retryAi = useGame((s) => s.retryAi);
  const playRandomMove = useGame((s) => s.playRandomMove);
  const mode = useGame((s) => s.mode);
  const coachOn = useGame((s) => s.coach.enabled);
  const showReasoning = useGame((s) => isCoachOn(s.coach, 'showReasoning'));
  const reasoningRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const reasoning = aiTurn?.reasoning ?? '';

  useEffect(() => {
    const el = reasoningRef.current;
    if (!el || !autoScroll.current) return;
    el.scrollTop = el.scrollHeight;
  }, [reasoning]);

  const attempts = aiTurn?.attempts ?? [];

  if (!aiTurn && !aiError) {
    return (
      <div className="empty-state">
        <Brain size={26} style={{ opacity: 0.5, marginBottom: 8 }} />
        <div>AI 还没有走过棋。</div>
        <div style={{ marginTop: 6 }}>
          开始一局并让 AI 执白或执黑，这里会实时显示它的思维链与每次请求的耗时；
          着法解释在「教练」页，需要先在新对局里开启教练模式。
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="ai-head">
        <span
          className="ai-badge"
          data-tone={thinking ? 'live' : aiError ? 'error' : 'ok'}
        >
          {thinking ? <span className="spinner" /> : <Brain size={12} />}
          {thinking ? '思考中' : aiError ? '请求失败' : '已完成'}
        </span>
        {aiTurn && (
          <span className="faint" style={{ fontSize: 11.5 }}>
            {aiTurn.profileName ? `${aiTurn.profileName} · ` : ''}
            第 {aiTurn.attempt}/{aiTurn.limit} 次尝试 · {aiTurn.side === 'w' ? '白方' : '黑方'} ·{' '}
            {(aiTurn.elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
        {aiTurn?.notice && (
          <span className="ai-badge" data-tone="live" style={{ fontSize: 11 }}>
            {aiTurn.notice}
          </span>
        )}
      </div>

      {aiError && (
        <div className="result-banner" data-kind="error">
          <AlertTriangle size={15} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            <span>{aiError}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn--sm" onClick={retryAi}>
                <RotateCw size={12} /> 再试一次
              </button>
              <button type="button" className="btn btn--sm" onClick={playRandomMove}>
                <Wand2 size={12} /> 随机合法着法
              </button>
              <span className="faint" style={{ fontSize: 11, alignSelf: 'center' }}>
                可先在设置中修复本局使用的配置，再点「再试一次」；也可用随机合法着法继续。
              </span>
            </div>
          </div>
        </div>
      )}

      {showReasoning && (
        <div className="thinking-block">
          <div className="thinking-head">
            <Brain size={13} /> 思维链（模型返回的 reasoning）
            {thinking && <span className="spinner" style={{ marginLeft: 'auto' }} />}
          </div>
          <div
            className="thinking-body"
            ref={reasoningRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {reasoning || (thinking ? '等待模型输出…' : '该模型本次没有返回思维链内容。')}
          </div>
        </div>
      )}

      {!coachOn && (
        <div className="faint" style={{ fontSize: 11.5 }}>
          教练模式没开，这里只显示请求记录与 token 用量。教练模式在「新对局」里开启，
          开启后 AI 的着法解释会出现在「教练」页。
        </div>
      )}

      {aiTurn?.usage && (
        <div className="meta-grid">
          <div className="meta-cell">
            <div className="meta-key">输入 tokens</div>
            <div className="meta-val">{aiTurn.usage.input ?? '—'}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-key">输出 tokens</div>
            <div className="meta-val">{aiTurn.usage.output ?? '—'}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-key">推理 tokens</div>
            <div className="meta-val">{aiTurn.usage.reasoning ?? '—'}</div>
          </div>
          <div className="meta-cell">
            <div className="meta-key">缓存命中</div>
            <div className="meta-val">
              {(() => {
                const pct = cachedShare(aiTurn.usage);
                return pct === null ? '—' : `${aiTurn.usage.cachedInput ?? 0}（${pct}%）`;
              })()}
            </div>
          </div>
          <div className="meta-cell">
            <div className="meta-key">总耗时</div>
            <div className="meta-val">{((aiTurn.elapsedMs ?? 0) / 1000).toFixed(1)}s</div>
          </div>
        </div>
      )}

      {attempts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="section-title">请求记录（{attempts.length}）</p>
          {attempts.map((attempt) => (
            <AttemptCard
              key={`${attempt.index}-${attempt.elapsedMs}`}
              attempt={attempt}
              showReasoning={showReasoning}
            />
          ))}
        </div>
      )}

      {mode === 'finished' && (
        <div className="faint" style={{ fontSize: 11.5 }}>
          对局已结束，AI 不会再走棋。
        </div>
      )}
    </>
  );
}

function AttemptCard({
  attempt,
  showReasoning,
}: {
  attempt: AttemptRecord;
  showReasoning: boolean;
}) {
  const state = attempt.error ? 'error' : 'ok';
  const preview = useMemo(() => {
    if (attempt.text.trim()) return attempt.text.trim();
    if (showReasoning && attempt.reasoning.trim()) return attempt.reasoning.trim();
    if (!attempt.text.trim() && !attempt.reasoning.trim()) return '(空)';
    return '(内容只有思维链，本次未显示)';
  }, [attempt.text, attempt.reasoning, showReasoning]);

  return (
    <div className="attempt" data-state={state}>
      <div className="attempt-head">
        <span className="attempt-title">#{attempt.index}</span>
        <span>{(attempt.elapsedMs / 1000).toFixed(1)}s</span>
        {attempt.status !== null && <span>HTTP {attempt.status}</span>}
        {attempt.usage?.output !== undefined && <span>out {attempt.usage.output} tok</span>}
        <span style={{ marginLeft: 'auto' }}>
          {attempt.error ? '未采用' : '已采用'}
        </span>
      </div>
      {attempt.notice && <div className="attempt-msg">{attempt.notice}</div>}
      {attempt.error && (
        <div className="attempt-msg" data-kind="error">
          {attempt.error}
        </div>
      )}
      <div className="attempt-raw">{preview.slice(0, 900)}</div>
    </div>
  );
}
