import type { ReasoningEffort } from "../../core/types";

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭（使用模型默认）",
  low: "低",
  medium: "中",
  high: "高",
};

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return isReasoningEffort(value) ? value : "off";
}

export function openaiReasoningEffort(effort: ReasoningEffort | undefined): Exclude<ReasoningEffort, "off"> | undefined {
  return effort && effort !== "off" ? effort : undefined;
}

/** Anthropic thinking budget（参考 LiveAgent `ANTHROPIC_THINKING_BUDGETS`）。 */
export const ANTHROPIC_THINKING_BUDGETS: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

/** Gemini 2.5 系 thinkingBudget（参考 LiveAgent `mapGeminiThinkingBudget`）。 */
export const GEMINI_THINKING_BUDGETS: Record<Exclude<ReasoningEffort, "off">, number> = {
  low: 2_048,
  medium: 8_192,
  high: 32_768,
};

/**
 * Anthropic 启用 thinking 时 `max_tokens` 必须大于 thinking `budget_tokens`，
 * 因此在请求层把输出预算抬高以容纳思考预算。
 */
export function anthropicThinkingConfig(effort: ReasoningEffort | undefined, maxTokens: number): { budgetTokens: number; maxTokens: number } | null {
  if (!effort || effort === "off") return null;
  const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effort];
  return { budgetTokens, maxTokens: maxTokens + budgetTokens };
}