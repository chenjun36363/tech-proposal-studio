import type { AgentMessage, AgentToolDefinition } from "../../agent/protocol";
import { estimateAgentContextTokens, estimateAgentTextTokens } from "../../agent/contextCompaction";
import { parseLongWritingDocument } from "./chapterParser";

export type LongWritingContextPhase = "chapter_summary" | "outline" | "chapter_draft" | "consistency";

export interface LongWritingBudgetResult<T extends Record<string, unknown>> {
  payload: T;
  estimatedTokens: number;
  budgetTokens: number;
  truncatedSources: number;
  omittedSources: number;
  compactedMarkdown: boolean;
}

export class LongWritingContextBudgetError extends Error {
  constructor(
    public readonly phase: LongWritingContextPhase,
    public readonly estimatedTokens: number,
    public readonly budgetTokens: number,
  ) {
    super(`长任务${phaseLabel(phase)}上下文预计 ${estimatedTokens} tokens，超过预算 ${budgetTokens} tokens；请减少当前章节、冻结计划或附加资料，或提高 Agent 上下文压缩阈值。`);
    this.name = "LongWritingContextBudgetError";
  }
}

const phaseLabel = (phase: LongWritingContextPhase) => ({
  chapter_summary: "章节摘要",
  outline: "目录规划",
  chapter_draft: "章节生成",
  consistency: "一致性检查",
})[phase];

function normalizeBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(8000, Math.min(200000, Math.floor(value)))
    : 48000;
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateAgentTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateAgentTextTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
}

function truncateTailToTokens(text: string, maxTokens: number): string {
  if (estimateAgentTextTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateAgentTextTokens(text.slice(middle)) <= maxTokens) high = middle;
    else low = middle + 1;
  }
  return text.slice(low).trimStart();
}

function truncateMiddleToTokens(text: string, maxTokens: number): string {
  if (estimateAgentTextTokens(text) <= maxTokens) return text;
  const marker = "\n…（资料已按长任务上下文预算截断）…\n";
  const markerTokens = estimateAgentTextTokens(marker);
  if (maxTokens <= markerTokens + 2) return truncateToTokens(text, maxTokens);
  const sideBudget = Math.max(1, Math.floor((maxTokens - markerTokens) / 2));
  const head = truncateToTokens(text, sideBudget);
  const tail = truncateTailToTokens(text, sideBudget);
  return `${head}${marker}${tail}`;
}

function requestTokens(systemPrompt: string, userPrefix: string, payload: Record<string, unknown>, tool: AgentToolDefinition): number {
  const messages: AgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${userPrefix}\n${JSON.stringify(payload, null, 2)}` },
  ];
  return estimateAgentContextTokens(messages, [tool]);
}

function compactMarkdownOverview(markdown: string, maxTokens: number): string {
  if (estimateAgentTextTokens(markdown) <= maxTokens) return markdown;
  const parsed = parseLongWritingDocument(markdown);
  if (!parsed.chapters.length) return truncateMiddleToTokens(markdown, maxTokens);

  const prefix = markdown.slice(0, parsed.chapters[0].start);
  const prefixBudget = Math.min(Math.floor(maxTokens * 0.15), 1200);
  const chapterBudget = Math.max(160, Math.floor((maxTokens - prefixBudget) / parsed.chapters.length));
  const sections = parsed.chapters.map(chapter => {
    const skeleton = chapter.headings.map(heading => `${"#".repeat(heading.level)} ${heading.title}`).join("\n");
    const skeletonTokens = estimateAgentTextTokens(skeleton);
    const bodyBudget = Math.max(48, chapterBudget - skeletonTokens - 24);
    return `${skeleton}\n\n${truncateToTokens(chapter.bodyMarkdown.trim(), bodyBudget)}\n\n> 本章正文已按一致性检查预算提取。`;
  });
  return `${truncateToTokens(prefix, prefixBudget)}\n${sections.join("\n\n")}`.trim();
}

function fitSources(
  basePayload: Record<string, unknown>,
  sources: string[],
  systemPrompt: string,
  userPrefix: string,
  tool: AgentToolDefinition,
  budgetTokens: number,
): { payload: Record<string, unknown>; truncatedSources: number; omittedSources: number } {
  const payload = { ...basePayload, attachedSources: [] as string[] };
  const baseTokens = requestTokens(systemPrompt, userPrefix, payload, tool);
  let remaining = Math.max(0, budgetTokens - baseTokens - 256);
  let truncatedSources = 0;
  let omittedSources = 0;
  const fitted: Array<{ value: string; truncated: boolean }> = [];

  for (let index = 0; index < sources.length; index += 1) {
    if (remaining < 96) {
      omittedSources += sources.length - index;
      break;
    }
    const sourcesLeft = sources.length - index;
    const fairShare = Math.max(96, Math.min(6000, Math.floor(remaining / sourcesLeft)));
    const source = sources[index];
    const value = truncateMiddleToTokens(source, fairShare);
    const truncated = value !== source;
    if (truncated) truncatedSources += 1;
    fitted.push({ value, truncated });
    remaining -= estimateAgentTextTokens(value) + 12;
  }

  let candidate = { ...basePayload, attachedSources: fitted.map(item => item.value) };
  let estimated = requestTokens(systemPrompt, userPrefix, candidate, tool);
  while (estimated > budgetTokens && fitted.length) {
    const last = fitted[fitted.length - 1];
    const lastTokens = estimateAgentTextTokens(last.value);
    const reducedBudget = lastTokens - (estimated - budgetTokens) - 24;
    if (reducedBudget >= 96) {
      const reduced = truncateMiddleToTokens(last.value, reducedBudget);
      if (reduced === last.value) break;
      if (!last.truncated) {
        last.truncated = true;
        truncatedSources += 1;
      }
      last.value = reduced;
    } else {
      const removed = fitted.pop();
      if (removed?.truncated) truncatedSources -= 1;
      omittedSources += 1;
    }
    candidate = { ...basePayload, attachedSources: fitted.map(item => item.value) };
    estimated = requestTokens(systemPrompt, userPrefix, candidate, tool);
  }
  return { payload: candidate, truncatedSources, omittedSources };
}

export function prepareLongWritingPayload<T extends Record<string, unknown>>(params: {
  phase: LongWritingContextPhase;
  input: T & { contextBudgetTokens?: number; attachedSources?: string[]; markdown?: string };
  systemPrompt: string;
  userPrefix: string;
  tool: AgentToolDefinition;
}): LongWritingBudgetResult<T> {
  const budgetTokens = normalizeBudget(params.input.contextBudgetTokens);
  const { contextBudgetTokens: _budget, ...raw } = params.input;
  let payload = raw as Record<string, unknown>;
  let truncatedSources = 0;
  let omittedSources = 0;
  let compactedMarkdown = false;
  const sources = Array.isArray(raw.attachedSources) ? raw.attachedSources.filter((value): value is string => typeof value === "string") : null;

  if (sources) {
    const fitted = fitSources(payload, sources, params.systemPrompt, params.userPrefix, params.tool, budgetTokens);
    payload = fitted.payload;
    truncatedSources = fitted.truncatedSources;
    omittedSources = fitted.omittedSources;
  }

  let estimatedTokens = requestTokens(params.systemPrompt, params.userPrefix, payload, params.tool);
  if (estimatedTokens > budgetTokens && typeof payload.markdown === "string" && (params.phase === "outline" || params.phase === "chapter_summary" || params.phase === "consistency")) {
    const withoutMarkdown = { ...payload, markdown: "" };
    const fixedTokens = requestTokens(params.systemPrompt, params.userPrefix, withoutMarkdown, params.tool);
    const markdownBudget = Math.max(512, budgetTokens - fixedTokens - 256);
    payload = { ...payload, markdown: compactMarkdownOverview(payload.markdown, markdownBudget) };
    compactedMarkdown = true;
    estimatedTokens = requestTokens(params.systemPrompt, params.userPrefix, payload, params.tool);
  }

  if (estimatedTokens > budgetTokens) {
    throw new LongWritingContextBudgetError(params.phase, estimatedTokens, budgetTokens);
  }
  return {
    payload: payload as T,
    estimatedTokens,
    budgetTokens,
    truncatedSources,
    omittedSources,
    compactedMarkdown,
  };
}
