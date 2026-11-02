import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { THINKING_EFFORTS } from '../src/ai/types';
import {
  anthropicBudgetForText,
  anthropicThinkingBudget,
  anthropicThinkingPlan,
  geminiBudgetForText,
  geminiThinkingBudget,
  geminiThinkingPlan,
  normalizeEffortText,
  openAiEffort,
  parseClaudeModel,
  resolveEffortText,
} from '../src/ai/effort';
import { buildSystemPrompt } from '../src/ai/prompt';
import { openaiChat } from '../src/ai/providers/openaiChat';
import { openaiResponses } from '../src/ai/providers/openaiResponses';
import { anthropic } from '../src/ai/providers/anthropic';
import { gemini } from '../src/ai/providers/gemini';
import type { AiConfig, ThinkingEffort } from '../src/ai/types';

function cfg(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-5',
    extraHeaders: '',
    stream: true,
    reasoning: true,
    effort: 'high',
    effortCustom: '',
    thinkingMode: 'auto',
    context: 'continuous',
    contextBudget: 64_000,
    maxTokens: 4096,
    timeoutSecs: 120,
    retries: 3,
    insecureTls: false,
    ...overrides,
  };
}

describe('effort scale', () => {
  it('exposes exactly five levels in order', () => {
    expect(THINKING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('passes every level through to the OpenAI effort scale', () => {
    expect(openAiEffort('low')).toBe('low');
    expect(openAiEffort('medium')).toBe('medium');
    expect(openAiEffort('high')).toBe('high');
    expect(openAiEffort('xhigh')).toBe('xhigh');
    expect(openAiEffort('max')).toBe('max');
  });

  it('grows the Anthropic thinking budget monotonically', () => {
    const budgets = THINKING_EFFORTS.map((effort) => anthropicThinkingBudget(effort));
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThan(budgets[i - 1]);
    }
    expect(budgets[0]).toBeGreaterThanOrEqual(1024);
  });

  it('grows the Gemini thinking budget monotonically', () => {
    const budgets = THINKING_EFFORTS.map((effort) => geminiThinkingBudget(effort));
    for (let i = 1; i < budgets.length; i += 1) {
      expect(budgets[i]).toBeGreaterThan(budgets[i - 1]);
    }
  });

  it('picks Gemini budget vs level per model generation', () => {
    expect(geminiThinkingPlan('gemini-2.5-flash', 'high')).toEqual({ kind: 'budget', budget: 12288 });
    expect(geminiThinkingPlan('gemini-3-pro-preview', 'high')).toEqual({ kind: 'level', level: 'high' });
    // Gemini 3 Pro only knows low/high, so medium has to round up.
    expect(geminiThinkingPlan('gemini-3-pro-preview', 'medium')).toEqual({ kind: 'level', level: 'high' });
    expect(geminiThinkingPlan('gemini-3.1-pro-preview', 'medium')).toEqual({
      kind: 'level',
      level: 'medium',
    });
    expect(geminiThinkingPlan('gemini-3-flash-preview', 'max')).toEqual({ kind: 'level', level: 'high' });
    // A "models/" prefix (as used in the REST path) must not change the decision.
    expect(geminiThinkingPlan('models/gemini-2.5-pro', 'high')).toEqual({ kind: 'budget', budget: 12288 });
  });
});

describe('effort reaches each provider request', () => {
  it('openai chat sends reasoning_effort', () => {
    const body = JSON.parse(
      openaiChat.buildRequest(cfg({ effort: 'medium' }), 's', [{ role: 'user', content: 'x' }], true)
        .body,
    );
    expect(body.reasoning_effort).toBe('medium');
  });

  it('openai chat forwards xhigh and max unchanged', () => {
    for (const effort of ['xhigh', 'max'] as ThinkingEffort[]) {
      const body = JSON.parse(
        openaiChat.buildRequest(cfg({ effort }), 's', [{ role: 'user', content: 'x' }], true).body,
      );
      expect(body.reasoning_effort).toBe(effort);
    }
  });

  it('openai responses forwards max unchanged', () => {
    const body = JSON.parse(
      openaiResponses.buildRequest(
        cfg({ protocol: 'openai-responses', effort: 'max' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.reasoning).toMatchObject({ effort: 'max', summary: 'auto' });
  });

  it('openai chat omits reasoning_effort when deep thinking is off', () => {
    const body = JSON.parse(
      openaiChat.buildRequest(cfg({ reasoning: false }), 's', [{ role: 'user', content: 'x' }], true)
        .body,
    );
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('openai responses sends reasoning.effort', () => {
    const body = JSON.parse(
      openaiResponses.buildRequest(
        cfg({ protocol: 'openai-responses', effort: 'low' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.reasoning).toMatchObject({ effort: 'low', summary: 'auto' });
  });

  it('anthropic sends a thinking budget and a larger max_tokens', () => {
    const body = JSON.parse(
      anthropic.buildRequest(
        cfg({ protocol: 'anthropic', model: 'claude-sonnet-4-5', effort: 'max' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: anthropicThinkingBudget('max'),
    });
    expect(body.max_tokens).toBeGreaterThan(body.thinking.budget_tokens);
  });

  it('gemini sends thinkingConfig.includeThoughts and a budget on 2.5', () => {
    const body = JSON.parse(
      gemini.buildRequest(
        cfg({ protocol: 'gemini', model: 'gemini-2.5-pro', effort: 'xhigh' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(geminiThinkingBudget('xhigh'));
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined();
  });

  it('gemini 3+ switches to thinkingLevel instead of a budget', () => {
    const body = JSON.parse(
      gemini.buildRequest(
        cfg({ protocol: 'gemini', model: 'gemini-3-pro-preview', effort: 'max' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.generationConfig.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'high',
    });
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  });

  it('claude 4.6+ uses adaptive thinking plus output_config.effort', () => {
    const body = JSON.parse(
      anthropic.buildRequest(
        cfg({ protocol: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' }),
        's',
        [{ role: 'user', content: 'x' }],
        true,
      ).body,
    );
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it('clamps effort to what the Claude model accepts', () => {
    const plan = (model: string, effort: ThinkingEffort) =>
      anthropicThinkingPlan(model, effort, 4096);
    expect(plan('claude-opus-4-8', 'max')).toMatchObject({ effort: 'max' });
    expect(plan('claude-opus-4-7', 'xhigh')).toMatchObject({ effort: 'xhigh' });
    expect(plan('claude-opus-4-6', 'xhigh')).toMatchObject({ effort: 'high' });
    expect(plan('claude-sonnet-4-6', 'max')).toMatchObject({ effort: 'high' });
  });

  it('keeps budget thinking for Claude 4.5 and older', () => {
    for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1']) {
      const plan = anthropicThinkingPlan(model, 'high', 4096);
      expect(plan.mode).toBe('budget');
      if (plan.mode === 'budget') {
        expect(plan.thinking.type).toBe('enabled');
        expect(plan.maxTokens).toBeGreaterThan(plan.thinking.budget_tokens);
      }
    }
  });

  it('recognises legacy version-first Claude ids as pre-4.6', () => {
    for (const model of ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229']) {
      expect(parseClaudeModel(model).adaptive).toBe(false);
      expect(anthropicThinkingPlan(model, 'high', 4096).mode).toBe('budget');
    }
  });
});

describe('thinking effort stays out of the prompt', () => {
  const system = buildSystemPrompt('w', { commentary: false, lang: 'zh' });

  it('does not hardcode a thinking budget in the system prompt', () => {
    expect(system).not.toContain('Thinking budget');
    expect(system).not.toContain('highest thinking budget');
    expect(system).not.toContain('playing fast');
  });

  it('keeps the anti-coaching rule without an effort level', () => {
    expect(system).toContain('Never give the human advice');
  });

  it('keeps the JSON contract', () => {
    expect(system).toContain('move_uci');
    expect(system).toContain('exactly ONE JSON object');
  });
});

describe('prompt understands the position', () => {
  it('includes the FEN, board, legal list and piece count', () => {
    const chess = new Chess();
    const prompt = buildSystemPrompt('b', { commentary: true, lang: 'zh' });
    expect(prompt).toContain('You play Black');
    expect(prompt).toContain('LEGAL MOVES');
    expect(chess.fen()).toContain('rnbqkbnr');
  });
});

describe('custom effort text', () => {
  it('sends the custom text verbatim for string-based formats', () => {
    expect(resolveEffortText('high', 'minimal')).toBe('minimal');
    expect(resolveEffortText('high', 'none')).toBe('none');
    expect(resolveEffortText('high', '  XHIGH  ')).toBe('xhigh');
  });

  it('falls back to the preset when no custom text is set', () => {
    expect(resolveEffortText('xhigh', '')).toBe('xhigh');
    expect(resolveEffortText('max', '   ')).toBe('max');
  });

  it('passes an unknown vendor value through instead of rewriting it', () => {
    expect(resolveEffortText('high', 'turbo')).toBe('turbo');
  });

  it('normalises whitespace and case', () => {
    expect(normalizeEffortText('  High ')).toBe('high');
  });

  it('maps custom text onto Claude adaptive effort directly', () => {
    const plan = anthropicThinkingPlan('claude-opus-4-7', 'low', 4096, 'adaptive', 'max');
    expect(plan.mode).toBe('adaptive');
    if (plan.mode === 'adaptive') expect(plan.effort).toBe('max');
  });

  it('converts custom text to a budget where the model only takes numbers', () => {
    expect(anthropicBudgetForText('low', 'high')).toBe(8192);
    expect(anthropicBudgetForText('low', '')).toBe(2048);
    expect(geminiBudgetForText('low', 'max')).toBe(32768);
  });

  it('maps custom text onto Gemini thinking levels', () => {
    const plan = geminiThinkingPlan('gemini-3-pro', 'low', 'level', 'minimal');
    expect(plan).toEqual({ kind: 'level', level: 'minimal' });
    const high = geminiThinkingPlan('gemini-3-pro', 'low', 'level', 'xhigh');
    expect(high).toEqual({ kind: 'level', level: 'high' });
  });

  it('keeps the preset when custom text is blank', () => {
    const plan = anthropicThinkingPlan('claude-sonnet-4-5', 'high', 4096, 'budget', '');
    if (plan.mode === 'budget') expect(plan.thinking.budget_tokens).toBe(anthropicThinkingBudget('high'));
  });
});
