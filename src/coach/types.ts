/**
 * Coach mode: a second, independent request that talks *about* the game instead
 * of playing it.
 *
 * It is deliberately separate from the playing request: coaching text must never
 * end up in the model's own conversation (that would leak the plan it committed
 * to and break the prompt-cache prefix), and the coach runs after the move is on
 * the board, so its advice can never change the move that was just played.
 */
export interface CoachConfig {
  /** Master switch; every other field only matters while this is true. */
  enabled: boolean;
  /** Show the player model's reasoning in the AI panel. */
  showReasoning: boolean;
  /** Ask the player model to explain its own move (rides along with the move request). */
  ownMoves: boolean;
  /** Critique the move that was just played, and say what to look at next. */
  opponentMoves: boolean;
  /** Read of the position as it stands. */
  position: boolean;
  /** Offer a "request guidance" button on the human's turn. */
  hint: boolean;
  /** Whole-game review after a natural end (checkmate / draw). */
  summary: boolean;
  /** Skip older queued reviews when more than eight are waiting. */
  skipBacklog: boolean;
  /**
   * Saved profile used for coach requests. Empty means "resolve it": follow the
   * AI of this game when there is one, otherwise the profile being edited.
   */
  profileId: string;
}

/** Everything off; also the result of `activeCoach` when the master switch is off. */
export const COACH_DISABLED: CoachConfig = {
  enabled: false,
  showReasoning: false,
  ownMoves: false,
  opponentMoves: false,
  position: false,
  hint: false,
  summary: false,
  skipBacklog: false,
  profileId: '',
};

/**
 * Defaults for a fresh install. The master switch starts off so nothing is sent
 * anywhere until the user asks for a coach; the six options start on so turning
 * coach mode on is one click. Backlog skipping is enabled by default.
 */
export const DEFAULT_COACH: CoachConfig = {
  enabled: false,
  showReasoning: true,
  ownMoves: true,
  opponentMoves: true,
  position: true,
  hint: true,
  summary: true,
  skipBacklog: true,
  profileId: '',
};

export type CoachOptionKey = keyof Omit<CoachConfig, 'enabled' | 'profileId'>;

export interface CoachOption {
  key: CoachOptionKey;
  label: string;
  sub: string;
}

/** Order matters: it is the order shown in the new-game dialog. */
export const COACH_OPTIONS: CoachOption[] = [
  {
    key: 'showReasoning',
    label: '显示思维链',
    sub: '在「AI 思考」页显示模型的推理过程（只影响显示，不改变是否请求思考）',
  },
  {
    key: 'ownMoves',
    label: '着法解释',
    sub: '让 AI 解释自己的每一手',
  },
  {
    key: 'opponentMoves',
    label: '点评着法',
    sub: '让 AI 评价你的每一手并给出建议（AI 对 AI 时不适用）',
  },
  {
    key: 'position',
    label: '局势解读',
    sub: '每走完一步给一段局势判断',
  },
  {
    key: 'hint',
    label: '申请指导',
    sub: '你的回合时可以请求 AI 指导',
  },
  {
    key: 'summary',
    label: '对局简评',
    sub: '对局正常结束后给整局复盘与改进建议',
  },
  {
    key: 'skipBacklog',
    label: '跳过积压点评',
    sub: '开启时最多保留 8 条待处理点评，终局跳过未完成点评；关闭后按顺序补全，终局先生成简评再继续点评',
  },
];

/** The options that actually take effect: all of them are inert without the master switch. */
export function activeCoach(coach: CoachConfig): CoachConfig {
  return coach.enabled ? coach : COACH_DISABLED;
}

export function isCoachOn(coach: CoachConfig, key: CoachOptionKey): boolean {
  return activeCoach(coach)[key];
}
