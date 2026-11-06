import { CONTEXT_MODES, THINKING_EFFORTS, THINKING_MODES } from './ai/types';
import type {
  AiConfig,
  AiProfile,
  ContextMode,
  Protocol,
  ThinkingEffort,
  ThinkingMode,
} from './ai/types';
import { DEFAULT_COACH } from './coach/types';
import type { CoachConfig } from './coach/types';
import type { Actor, Side } from './game/types';

export interface UiSettings {
  theme: 'dark' | 'light';
  boardTheme: 'midnight' | 'forest' | 'walnut' | 'slate';
  showCoordinates: boolean;
  /** Language the coach writes in (and the model's own move explanations). */
  commentaryLang: string;
}

export interface AppSettings {
  /** All saved endpoints. Always non-empty. */
  aiProfiles: AiProfile[];
  /** Which saved profile each side uses. */
  aiSelection: { w: string; b: string };
  /** Profile currently open in the settings editor. */
  activeProfile: string;
  ui: UiSettings;
  players: { w: Actor; b: Actor };
  orientation: Side;
  /** Coach mode choices of the last game; they are picked per game in the new-game dialog. */
  coach: CoachConfig;
}

export const DEFAULT_AI: AiConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  // A reasoning-capable model by default: `reasoning: true` is on below, and
  // gpt-4o rejects `reasoning_effort` with a 400 on every turn.
  model: 'gpt-5',
  extraHeaders: '',
  stream: true,
  reasoning: true,
  effort: 'high',
  effortCustom: '',
  thinkingMode: 'auto',
  context: 'continuous',
  contextBudget: 64_000,
  // gpt-5 bills reasoning tokens inside this cap; 4096 would be truncated.
  maxTokens: 16_384,
  timeoutSecs: 180,
  retries: 3,
  insecureTls: false,
};

/** Id of the profile created on first run. */
export const DEFAULT_PROFILE_ID = 'default';

export function makeProfile(name: string, config: AiConfig = DEFAULT_AI): AiProfile {
  return { id: newId(), name, config: { ...config } };
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `p${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export const DEFAULT_SETTINGS: AppSettings = {
  aiProfiles: [{ id: DEFAULT_PROFILE_ID, name: '默认配置', config: DEFAULT_AI }],
  aiSelection: { w: DEFAULT_PROFILE_ID, b: DEFAULT_PROFILE_ID },
  activeProfile: DEFAULT_PROFILE_ID,
  ui: {
    theme: 'dark',
    boardTheme: 'midnight',
    showCoordinates: true,
    commentaryLang: 'zh',
  },
  players: { w: 'ai', b: 'human' },
  orientation: 'w',
  coach: { ...DEFAULT_COACH },
};

export const LANG_OPTIONS = [
  { value: 'zh', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
];

export const BOARD_THEMES = [
  { value: 'midnight', label: '午夜蓝' },
  { value: 'forest', label: '森林绿' },
  { value: 'walnut', label: '胡桃木' },
  { value: 'slate', label: '石墨灰' },
];

const PROTOCOLS: Protocol[] = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeAiConfig(aiRaw: Record<string, unknown>): AiConfig {
  const protocol = PROTOCOLS.includes(aiRaw.protocol as Protocol)
    ? (aiRaw.protocol as Protocol)
    : DEFAULT_AI.protocol;
  return {
    protocol,
    baseUrl: str(aiRaw.baseUrl, DEFAULT_AI.baseUrl),
    apiKey: str(aiRaw.apiKey, ''),
    model: str(aiRaw.model, DEFAULT_AI.model),
    extraHeaders: str(aiRaw.extraHeaders, ''),
    stream: bool(aiRaw.stream, DEFAULT_AI.stream),
    reasoning: bool(aiRaw.reasoning, DEFAULT_AI.reasoning),
    effort: THINKING_EFFORTS.includes(aiRaw.effort as ThinkingEffort)
      ? (aiRaw.effort as ThinkingEffort)
      : DEFAULT_AI.effort,
    effortCustom: str(aiRaw.effortCustom, DEFAULT_AI.effortCustom),
    thinkingMode: THINKING_MODES.includes(aiRaw.thinkingMode as ThinkingMode)
      ? (aiRaw.thinkingMode as ThinkingMode)
      : DEFAULT_AI.thinkingMode,
    context: CONTEXT_MODES.includes(aiRaw.context as ContextMode)
      ? (aiRaw.context as ContextMode)
      : DEFAULT_AI.context,
    contextBudget: num(aiRaw.contextBudget, DEFAULT_AI.contextBudget, 0, 2_000_000),
    maxTokens: num(aiRaw.maxTokens, DEFAULT_AI.maxTokens, 256, 200000),
    timeoutSecs: num(aiRaw.timeoutSecs, DEFAULT_AI.timeoutSecs, 15, 900),
    retries: num(aiRaw.retries, DEFAULT_AI.retries, 1, 5),
    insecureTls: bool(aiRaw.insecureTls, false),
  };
}

function sanitizeProfiles(raw: unknown, legacyAi: Record<string, unknown> | null): AiProfile[] {
  const list = Array.isArray(raw) ? raw : [];
  const profiles: AiProfile[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = str(item.id, '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      name: str(item.name, '').trim() || '未命名配置',
      config: sanitizeAiConfig(isRecord(item.config) ? item.config : {}),
    });
  }
  if (profiles.length > 0) return profiles;
  // First run, or settings written before multiple profiles existed: keep the
  // single saved endpoint as the default profile instead of losing it.
  return [
    {
      id: DEFAULT_PROFILE_ID,
      name: '默认配置',
      config: legacyAi ? sanitizeAiConfig(legacyAi) : { ...DEFAULT_AI },
    },
  ];
}

function sanitizeCoach(raw: unknown, profiles: AiProfile[]): CoachConfig {
  if (!isRecord(raw)) return { ...DEFAULT_COACH };
  // A profile may have been deleted since; an unknown id falls back to "resolve it".
  const wanted = str(raw.profileId, '');
  const profileId = profiles.some((profile) => profile.id === wanted) ? wanted : '';
  return {
    enabled: bool(raw.enabled, DEFAULT_COACH.enabled),
    showReasoning: bool(raw.showReasoning, DEFAULT_COACH.showReasoning),
    ownMoves: bool(raw.ownMoves, DEFAULT_COACH.ownMoves),
    opponentMoves: bool(raw.opponentMoves, DEFAULT_COACH.opponentMoves),
    position: bool(raw.position, DEFAULT_COACH.position),
    hint: bool(raw.hint, DEFAULT_COACH.hint),
    summary: bool(raw.summary, DEFAULT_COACH.summary),
    skipBacklog: bool(raw.skipBacklog, DEFAULT_COACH.skipBacklog),
    profileId,
  };
}

export function sanitizeSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) {
    return sanitizeSettings({
      aiProfiles: DEFAULT_SETTINGS.aiProfiles,
      ui: DEFAULT_SETTINGS.ui,
      players: DEFAULT_SETTINGS.players,
      orientation: DEFAULT_SETTINGS.orientation,
    });
  }
  const uiRaw = isRecord(raw.ui) ? raw.ui : {};
  const playersRaw = isRecord(raw.players) ? raw.players : {};
  // Older builds stored a single `ai` object; fold it into a profile.
  const legacyAi = isRecord(raw.ai) && !Array.isArray(raw.aiProfiles) ? raw.ai : null;
  const aiProfiles = sanitizeProfiles(raw.aiProfiles, legacyAi);
  const byId = new Set(aiProfiles.map((profile) => profile.id));
  const fallbackId = aiProfiles[0].id;
  const selectionRaw = isRecord(raw.aiSelection) ? raw.aiSelection : {};
  const pick = (value: unknown): string => {
    const id = str(value, '');
    return byId.has(id) ? id : fallbackId;
  };
  return {
    aiProfiles,
    aiSelection: { w: pick(selectionRaw.w), b: pick(selectionRaw.b) },
    activeProfile: pick(raw.activeProfile),
    ui: {
      theme: uiRaw.theme === 'light' ? 'light' : 'dark',
      boardTheme: ['midnight', 'forest', 'walnut', 'slate'].includes(uiRaw.boardTheme as string)
        ? (uiRaw.boardTheme as UiSettings['boardTheme'])
        : 'midnight',
      showCoordinates: bool(uiRaw.showCoordinates, true),
      commentaryLang: LANG_OPTIONS.some((option) => option.value === uiRaw.commentaryLang)
        ? (uiRaw.commentaryLang as string)
        : 'zh',
    },
    players: {
      w: playersRaw.w === 'human' ? 'human' : 'ai',
      b: playersRaw.b === 'human' ? 'human' : 'ai',
    },
    orientation: raw.orientation === 'b' ? 'b' : 'w',
    coach: sanitizeCoach(raw.coach, aiProfiles),
  };
}

export function parseSettings(text: string | null): AppSettings {
  if (text === null) return sanitizeSettings(null);
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || Array.isArray(raw)) throw new Error('设置必须是 JSON 对象');
    return sanitizeSettings(raw);
  } catch {
    throw new Error('设置文件内容损坏，已暂停自动保存以保护原配置');
  }
}
