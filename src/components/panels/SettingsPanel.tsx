import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Pencil, PlugZap, Plus, Trash2 } from 'lucide-react';
import { PROTOCOL_OPTIONS, getProvider } from '../../ai/providers';
import { EFFORT_LABELS, THINKING_EFFORTS } from '../../ai/types';
import type { Protocol, ThinkingEffort, ThinkingMode } from '../../ai/types';
import { CONTEXT_LABELS, CONTEXT_MODES } from '../../ai/types';
import type { ContextMode } from '../../ai/types';
import {
  anthropicThinkingPlan,
  geminiThinkingPlan,
  normalizeEffortText,
  resolveEffortText,
} from '../../ai/effort';
import { LANG_OPTIONS, BOARD_THEMES } from '../../config';
import { useSettings, activeProfileOf } from '../../settings';
import { runCompatibleAttempt } from '../../ai/compatible';
import { bridge } from '../../bridge';
import { Switch } from '../ui/Switch';

const EFFORT_HINTS: Record<ThinkingEffort, string> = {
  low: '低思考强度',
  medium: '中等思考强度',
  high: '高思考强度',
  xhigh: '极高思考强度',
  max: '最高思考强度',
};

const CONTEXT_HINTS: Record<ContextMode, string> = {
  continuous: '保留历史对话，延续既定计划',
  isolated: '每次只发当前局面，模型重新推理',
};

/** Mirrors exactly what the provider will put on the wire. */
function describeEffort(
  protocol: Protocol,
  model: string,
  effort: ThinkingEffort,
  maxTokens: number,
  mode: ThinkingMode,
  custom: string,
): string {
  const text = normalizeEffortText(custom);
  if (protocol === 'anthropic') {
    const plan = anthropicThinkingPlan(model, effort, maxTokens, mode, custom);
    if (plan.mode === 'adaptive') {
      return `thinking 自适应 · output_config.effort="${plan.effort}"${
        text ? '（自定义文本直接发送）' : ''
      }`;
    }
    return `thinking budget ${plan.thinking.budget_tokens} tokens${
      text ? '（该模型只接受预算，自定义强度已换算）' : ''
    }`;
  }
  if (protocol === 'gemini') {
    const plan = geminiThinkingPlan(model, effort, mode, custom);
    if (plan.kind === 'level') {
      return `thinkingLevel="${plan.level}"${text ? '（自定义强度已映射到该档）' : ''}`;
    }
    return `thinkingBudget ${plan.budget} tokens${text ? '（该模型只接受预算，自定义强度已换算）' : ''}`;
  }
  return `reasoning_effort="${resolveEffortText(effort, custom)}"${text ? '（自定义文本直接发送）' : ''}`;
}

interface ModeOption {
  value: ThinkingMode;
  label: string;
  code: string;
  hint: string;
}

const ANTHROPIC_MODES: ModeOption[] = [
  {
    value: 'auto',
    label: '自动',
    code: 'auto',
    hint: '按模型名判断',
  },
  {
    value: 'adaptive',
    label: '自适应',
    code: 'effort',
    hint: 'thinking: adaptive + output_config.effort —— Claude 4.6 及以上',
  },
  {
    value: 'budget',
    label: '预算',
    code: 'budget',
    hint: 'thinking: {type: enabled, budget_tokens} —— Claude 4.5 及更早',
  },
];

const GEMINI_MODES: ModeOption[] = [
  {
    value: 'auto',
    label: '自动',
    code: 'auto',
    hint: '按模型名判断',
  },
  {
    value: 'level',
    label: '级别',
    code: 'level',
    hint: 'thinkingConfig.thinkingLevel —— Gemini 3 及以上',
  },
  {
    value: 'budget',
    label: '预算',
    code: 'budget',
    hint: 'thinkingConfig.thinkingBudget —— Gemini 2.5 及更早',
  },
];

export function SettingsPanel() {
  const settings = useSettings((s) => s.settings);
  const activeProfile = activeProfileOf(settings);
  const ai = activeProfile.config;
  const ui = settings.ui;
  const updateAi = useSettings((s) => s.updateAi);
  const updateUi = useSettings((s) => s.updateUi);
  const selectProfile = useSettings((s) => s.selectProfile);
  const addProfile = useSettings((s) => s.addProfile);
  const duplicateProfile = useSettings((s) => s.duplicateProfile);
  const renameProfile = useSettings((s) => s.renameProfile);
  const removeProfile = useSettings((s) => s.removeProfile);
  const [showKey, setShowKey] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** Id of the profile awaiting delete confirmation (pinned, not the live selection). */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(activeProfile.name);
  const [testState, setTestState] = useState<
    { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const testRequest = useRef<AbortController | null>(null);
  const configKey = JSON.stringify([activeProfile.id, ai]);
  const currentConfigKey = useRef(configKey);
  currentConfigKey.current = configKey;

  useEffect(() => {
    setRenaming(false);
    setDeletingId(null);
    setDraftName(activeProfile.name);
  }, [activeProfile.id, activeProfile.name]);

  const provider = getProvider(ai.protocol);
  const protocolHint =
    PROTOCOL_OPTIONS.find((option) => option.value === ai.protocol)?.hint ?? provider.hint;

  const modeOptions =
    ai.protocol === 'anthropic' ? ANTHROPIC_MODES : ai.protocol === 'gemini' ? GEMINI_MODES : null;
  const activeMode: ThinkingMode =
    modeOptions?.some((option) => option.value === ai.thinkingMode) ? ai.thinkingMode : 'auto';

  useEffect(() => {
    testRequest.current?.abort();
    testRequest.current = null;
    setTestState({ kind: 'idle' });
    return () => { testRequest.current?.abort(); testRequest.current = null; };
  }, [configKey]);

  const runTest = async () => {
    testRequest.current?.abort();
    setTestState({ kind: 'running' });
    const controller = new AbortController();
    testRequest.current = controller;
    const isCurrent = () => testRequest.current === controller && currentConfigKey.current === configKey;
    const timeout = setTimeout(() => controller.abort(), Math.min(ai.timeoutSecs, 60) * 1000);
    try {
      const result = await runCompatibleAttempt({
        cfg: { ...ai, stream: false, maxTokens: Math.min(ai.maxTokens, 4096), retries: 1, timeoutSecs: Math.min(ai.timeoutSecs, 60) },
        system: 'You are a connection test. Reply with the single word: OK',
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        signal: controller.signal,
        cb: { onReasoning: () => undefined, onText: () => undefined },
      });
      if (!isCurrent()) return;
      if (result.aborted) {
        setTestState({ kind: 'error', message: '测试已取消' });
      } else if (result.error) {
        setTestState({ kind: 'error', message: result.error.slice(0, 400) });
      } else {
        const sample = (result.text || result.reasoning || '(空响应)').trim().slice(0, 120);
        setTestState({ kind: 'ok', message: `连接成功，模型返回：${sample}` });
      }
    } catch (error) {
      if (!isCurrent()) return;
      setTestState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
      if (testRequest.current === controller) testRequest.current = null;
    }
  };

  return (
    <div className="settings-form">
      <div className="settings-group">
        <div className="group-head">
          <p className="section-title">AI 配置</p>
          <span className="faint" style={{ fontSize: 11 }}>
            可保存多套接口，开始对局时选择
          </span>
        </div>

        <label className="field">
          <span className="field-label">当前编辑</span>
          <select
            className="select"
            value={activeProfile.id}
            onChange={(event) => selectProfile(event.target.value)}
          >
            {settings.aiProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.config.model}
              </option>
            ))}
          </select>
        </label>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--sm" onClick={() => addProfile()}>
            <Plus size={13} /> 新建
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => duplicateProfile(activeProfile.id)}
          >
            <Copy size={13} /> 复制
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setRenaming(!renaming)}>
            <Pencil size={13} /> 重命名
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={settings.aiProfiles.length <= 1}
            title={settings.aiProfiles.length <= 1 ? '至少保留一个配置' : '删除当前配置'}
            onClick={() => setDeletingId(activeProfile.id)}
          >
            <Trash2 size={13} /> 删除
          </button>
        </div>

        {deletingId !== null && (
          <div className="confirm-strip">
            <span>
              删除配置「
              {settings.aiProfiles.find((profile) => profile.id === deletingId)?.name ?? '已删除的配置'}
              」？此操作无法撤销。
            </span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button type="button" className="btn btn--sm" onClick={() => setDeletingId(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => {
                  removeProfile(deletingId);
                  setDeletingId(null);
                }}
              >
                删除
              </button>
            </div>
          </div>
        )}

        {renaming && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={draftName}
              autoFocus
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  renameProfile(activeProfile.id, draftName);
                  setRenaming(false);
                }
                if (event.key === 'Escape') setRenaming(false);
              }}
            />
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                renameProfile(activeProfile.id, draftName);
                setRenaming(false);
              }}
            >
              保存
            </button>
          </div>
        )}
      </div>

      <div className="divider" />

      <div className="settings-group">
        <div className="group-head">
          <p className="section-title">接口</p>
        </div>

        <label className="field">
          <span className="field-label">请求格式</span>
          <select
            className="select"
            value={ai.protocol}
            onChange={(event) => {
              const protocol = event.target.value as Protocol;
              const next = getProvider(protocol);
              const isKnown = PROTOCOL_OPTIONS.some((option) => option.value === protocol);
              if (!isKnown) {
                updateAi({ protocol });
                return;
              }
              updateAi({
                protocol,
                baseUrl: next.defaultBaseUrl,
                model: next.defaultModel || ai.model,
              });
            }}
          >
            {PROTOCOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="field-hint">{protocolHint}</span>
        </label>

        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            className="input input--mono"
            value={ai.baseUrl}
            placeholder={provider.defaultBaseUrl}
            onChange={(event) => updateAi({ baseUrl: event.target.value })}
          />
          <span className="field-hint">
            例：https://api.openai.com/v1 · https://api.deepseek.com/v1 · 
            https://api.anthropic.com/v1 · https://generativelanguage.googleapis.com/v1beta · 
            https://openrouter.ai/api/v1 · 本地 Ollama：http://127.0.0.1:11434/v1
          </span>
        </label>

        <label className="field">
          <span className="field-label">API Key</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input input--mono"
              type={showKey ? 'text' : 'password'}
              value={ai.apiKey}
              placeholder="sk-..."
              onChange={(event) => updateAi({ apiKey: event.target.value })}
                spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => setShowKey(!showKey)}
              title={showKey ? '隐藏' : '显示'}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <span className="field-hint">
            密钥保存在本机配置文件中（Windows DPAPI 加密，仅当前用户可解密），并会随请求发送给你填写的接口服务商。
          </span>
        </label>

        <label className="field">
          <span className="field-label">模型</span>
          <input
            className="input input--mono"
            value={ai.model}
            placeholder={provider.defaultModel || 'claude-sonnet-4-6'}
            onChange={(event) => updateAi({ model: event.target.value })}
          />
          <span className="field-hint">
            填服务商文档里的模型 ID，例如 gpt-5、gpt-4o、deepseek-chat、claude-sonnet-4-6、gemini-2.5-pro
          </span>
        </label>

        <label className="field">
          <span className="field-label">额外请求头（JSON，可选）</span>
          <textarea
            className="textarea textarea--mono"
            value={ai.extraHeaders}
            placeholder={'{"HTTP-Referer":"https://example.com","X-Title":"ChessMind"}'}
            onChange={(event) => updateAi({ extraHeaders: event.target.value })}
            spellCheck={false}
          />
          <span className="field-hint">
            OpenRouter 的 HTTP-Referer/X-Title、Azure 的 api-key、自建网关的自定义鉴权头都可以放这里。
          </span>
        </label>

        <div style={{ display: 'flex' }}>
          <button
            type="button"
            className="btn btn--block"
            onClick={runTest}
            disabled={testState.kind === 'running'}
          >
            <PlugZap size={14} />
            {testState.kind === 'running' ? '测试中…' : '测试连接'}
          </button>
        </div>
        {testState.kind === 'ok' && (
          <div className="alert" data-kind="success">
            {testState.message}
          </div>
        )}
        {testState.kind === 'error' && (
          <div className="alert" data-kind="error">{testState.message}</div>
        )}
      </div>

      <div className="divider" />

      <div className="settings-group">
        <p className="section-title">生成</p>
        <div className="row">
          <label className="field">
            <span className="field-label">最大输出 tokens</span>
            <input
              className="input"
              type="number"
              min={256}
              max={200000}
              value={ai.maxTokens}
              onChange={(event) => updateAi({ maxTokens: Number(event.target.value) || 4096 })}
            />
          </label>
          <label className="field">
            <span className="field-label">超时（秒）</span>
            <input
              className="input"
              type="number"
              min={15}
              max={900}
              value={ai.timeoutSecs}
              onChange={(event) => updateAi({ timeoutSecs: Number(event.target.value) || 180 })}
            />
          </label>
          <label className="field">
            <span className="field-label">非法着法重试次数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={5}
              value={ai.retries}
              onChange={(event) => updateAi({ retries: Number(event.target.value) || 3 })}
            />
          </label>
        </div>

        <Switch
          title="流式响应"
          sub="边生成边显示；关闭后等待完整响应再解析"
          on={ai.stream}
          onChange={(value) => updateAi({ stream: value })}
        />
        <Switch
          title="请求深度思考"
          sub="支持时附带 reasoning / thinking 参数，可获得更高质量着法与思维链"
          on={ai.reasoning}
          onChange={(value) => updateAi({ reasoning: value })}
        />
        <div className="field">
          <span className="field-label">思考强度</span>
          <div className="effort-row">
            {THINKING_EFFORTS.map((effort) => (
              <button
                key={effort}
                type="button"
                className="effort-chip"
                data-active={!ai.effortCustom.trim() && ai.effort === effort}
                disabled={!ai.reasoning}
                title={EFFORT_HINTS[effort]}
                onClick={() => updateAi({ effort, effortCustom: '' })}
              >
                <span className="effort-name">{EFFORT_LABELS[effort]}</span>
                <span className="effort-code">{effort}</span>
              </button>
            ))}
          </div>
          <span className="field-label" style={{ marginTop: 10 }}>
            自定义强度（可选，直接作为文本发送）
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input input--mono"
              type="text"
              placeholder="如 minimal / none / 留空则用上面的档位"
              value={ai.effortCustom}
              disabled={!ai.reasoning}
              spellCheck={false}
              onChange={(event) => updateAi({ effortCustom: event.target.value })}
            />
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!ai.reasoning || !ai.effortCustom}
              onClick={() => updateAi({ effortCustom: '' })}
            >
              清除
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
              <button
                key={value}
                type="button"
                className="btn btn--sm"
                data-active={normalizeEffortText(ai.effortCustom) === value}
                disabled={!ai.reasoning}
                onClick={() => updateAi({ effortCustom: value })}
              >
                {value}
              </button>
            ))}
          </div>
          {modeOptions && (
            <>
              <span className="field-label" style={{ marginTop: 10 }}>
                思考参数格式
              </span>
              <div className="effort-row effort-row--3">
                {modeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="effort-chip"
                    data-active={activeMode === option.value}
                    disabled={!ai.reasoning}
                    title={option.hint}
                    onClick={() => updateAi({ thinkingMode: option.value })}
                  >
                    <span className="effort-name">{option.label}</span>
                    <span className="effort-code">{option.code}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="field-hint">
            {ai.reasoning
              ? `按 ${getProvider(ai.protocol).label} 映射：${describeEffort(
                  ai.protocol,
                  ai.model,
                  ai.effort,
                  ai.maxTokens,
                  activeMode,
                  ai.effortCustom,
                )}。${
                  ai.effortCustom.trim()
                    ? '自定义强度会作为文本直接发送；只接受固定取值或预算的模型会自动换算。'
                    : modeOptions
                      ? activeMode === 'auto'
                        ? '格式按模型名自动判断；猜错时可手动指定。'
                        : '已手动指定格式，档位不再按模型名调整。'
                      : ai.effort === 'xhigh' || ai.effort === 'max'
                        ? 'xhigh / max 仅有部分模型支持；若被拒绝会自动降为 high。'
                        : ''
                }`
              : '开启「请求深度思考」后才会生效。'}
          </span>
        </div>
        <Switch
          title="忽略证书错误"
          sub="仅用于自签名证书的本地网关"
          on={ai.insecureTls}
          onChange={(value) => updateAi({ insecureTls: value })}
        />
      </div>

      <div className="divider" />

      <div className="settings-group">
        <p className="section-title">上下文</p>
        <div className="field">
          <span className="field-label">多轮上下文</span>
          <div className="effort-row effort-row--2">
            {CONTEXT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="effort-chip"
                data-active={ai.context === mode}
                title={CONTEXT_HINTS[mode]}
                onClick={() => updateAi({ context: mode as ContextMode })}
              >
                <span className="effort-name">{CONTEXT_LABELS[mode]}</span>
                <span className="effort-code">{mode}</span>
              </button>
            ))}
          </div>
          <span className="field-hint">
            {ai.context === 'continuous'
              ? '保留之前每一步的局面与模型回复，模型能延续自己已定的计划。'
              : '每次只发送当前局面，模型每步都要从头重新推理'}
          </span>
        </div>
        <div className="field">
          <span className="field-label">上下文上限（tokens）</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input"
              type="number"
              min={0}
              max={2000000}
              step={1000}
              value={ai.contextBudget}
              disabled={ai.context !== 'continuous'}
              onChange={(event) =>
                updateAi({ contextBudget: Math.max(0, Number(event.target.value) || 0) })
              }
            />
            <button
              type="button"
              className="btn btn--ghost"
              disabled={ai.context !== 'continuous'}
              onClick={() => updateAi({ contextBudget: 64000 })}
            >
              恢复默认
            </button>
          </div>
          <span className="field-hint">
            输入 token 估算预算，包含系统提示词、历史回合、当前局面和纠错内容，0 表示默认 64000。
            超出时裁掉旧回合；当前局面本身超出时暂停并提示提高上限。实际用量见「AI 思考」页。
          </span>
        </div>
      </div>

      <div className="divider" />

      <div className="settings-group">
        <p className="section-title">教练</p>
        <p className="faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
          教练模式在「新对局」里开启：显示思维链、着法解释、点评着法、局势解读、申请指导和对局简评都在那里选，
          教练用哪套配置也在那里选。这里只保留一个通用语言。
        </p>
        <label className="field">
          <span className="field-label">教练语言</span>
          <select
            className="select"
            value={ui.commentaryLang}
            onChange={(event) => updateUi({ commentaryLang: event.target.value })}
          >
            {LANG_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="field-hint">教练点评、局势解读与 AI 的着法解释都用这种语言写。</span>
        </label>
      </div>

      <div className="divider" />

      <div className="settings-group">
        <p className="section-title">界面</p>
        <div className="row">
          <label className="field">
            <span className="field-label">棋盘配色</span>
            <select
              className="select"
              value={ui.boardTheme}
              onChange={(event) =>
                updateUi({ boardTheme: event.target.value as typeof ui.boardTheme })
              }
            >
              {BOARD_THEMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">主题</span>
            <select
              className="select"
              value={ui.theme}
              onChange={(event) => updateUi({ theme: event.target.value as 'dark' | 'light' })}
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
        </div>
        <Switch
          title="显示坐标"
          sub="在棋盘边缘显示 a–h / 1–8"
          on={ui.showCoordinates}
          onChange={(value) => updateUi({ showCoordinates: value })}
        />
      </div>

      <AboutSection />

    </div>
  );
}

function AboutSection() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    let alive = true;
    void bridge.appVersion().then((value) => {
      if (alive) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="settings-group">
      <p className="section-title">关于</p>
      <p className="faint" style={{ fontSize: 12, lineHeight: 1.7 }}>
        ChessMind {version || '…'} · 以 MIT 许可证发布
        <br />
        棋子素材：Colin M.L. Burnett（Cburnett，BSD-3-Clause）。完整第三方许可见安装目录与
        仓库中的 THIRD-PARTY-NOTICES.md。
      </p>
    </div>
  );
}

