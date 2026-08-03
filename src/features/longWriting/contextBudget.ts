import type { AgentMessage, AgentToolDefinition } from "../../agent/protocol";
import { estimateAgentContextTokens, estimateAgentTextTokens } from "../../agent/contextCompaction";
import { parseLongWritingDocument } from "./chapterParser";

export type LongWritingContextPhase = "chapter_summary" | "outline" | "chapter_draft" | "consistency";

export interface LongWritingBudgetResult<T extends Record<string, unknown>> {
  payload: T;
  estimatedTokens: number;
  /** Effective input budget after applying the requested cap and model-window reservation. */
  budgetTokens: number;
  requestedBudgetTokens: number;
  modelContextWindowTokens: number;
  outputReserveTokens: number;
  truncatedSources: number;
  omittedSources: number;
  sourceExcerptCount: number;
  compactedMarkdown: boolean;
}

export class LongWritingContextBudgetError extends Error {
  constructor(
    public readonly phase: LongWritingContextPhase,
    public readonly estimatedTokens: number,
    public readonly budgetTokens: number,
  ) {
    super(`长任务${phaseLabel(phase)}上下文预计 ${estimatedTokens} tokens，超过可用输入预算 ${budgetTokens} tokens；请减少当前章节或附加资料，或使用更大上下文窗口的模型。`);
    this.name = "LongWritingContextBudgetError";
  }
}

const PHASE_OUTPUT_RESERVES: Record<LongWritingContextPhase, number> = {
  chapter_summary: 3000,
  outline: 6000,
  chapter_draft: 5000,
  consistency: 5000,
};
const SAFETY_MARGIN_TOKENS = 1024;
const MIN_INPUT_BUDGET_TOKENS = 1024;

const phaseLabel = (phase: LongWritingContextPhase) => ({
  chapter_summary: "章节摘要",
  outline: "目录规划",
  chapter_draft: "章节生成",
  consistency: "一致性检查",
})[phase];

function normalizeRequestedBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(MIN_INPUT_BUDGET_TOKENS, Math.min(500000, Math.floor(value)))
    : 48000;
}

function normalizeContextWindow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(8192, Math.min(1000000, Math.floor(value)))
    : 32768;
}

export function resolveLongWritingContextBudget(phase: LongWritingContextPhase, params: {
  contextBudgetTokens?: number;
  modelContextWindowTokens?: number;
}): { requestedBudgetTokens: number; modelContextWindowTokens: number; outputReserveTokens: number; budgetTokens: number } {
  const requestedBudgetTokens = normalizeRequestedBudget(params.contextBudgetTokens);
  const modelContextWindowTokens = normalizeContextWindow(params.modelContextWindowTokens);
  const outputReserveTokens = PHASE_OUTPUT_RESERVES[phase];
  const windowInputBudget = Math.max(MIN_INPUT_BUDGET_TOKENS, modelContextWindowTokens - outputReserveTokens - SAFETY_MARGIN_TOKENS);
  return {
    requestedBudgetTokens,
    modelContextWindowTokens,
    outputReserveTokens,
    budgetTokens: Math.min(requestedBudgetTokens, windowInputBudget),
  };
}

export function longWritingPhaseOutputTokens(phase: LongWritingContextPhase, modelContextWindowTokens?: number): number {
  const window = normalizeContextWindow(modelContextWindowTokens);
  return Math.max(1024, Math.min(PHASE_OUTPUT_RESERVES[phase], window - MIN_INPUT_BUDGET_TOKENS - SAFETY_MARGIN_TOKENS));
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

function queryTerms(text: string): string[] {
  const normalized = text.toLocaleLowerCase();
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) terms.add(word);
  const cjk = (normalized.match(/[\u3400-\u9fff]/g) ?? []).join("");
  for (let index = 0; index < cjk.length - 1 && terms.size < 80; index += 1) terms.add(cjk.slice(index, index + 2));
  return [...terms].slice(0, 80);
}

function sourceChunks(source: string, maxChars = 6000): string[] {
  const text = source.trim();
  if (!text) return [];
  const title = text.split(/\r?\n/, 1)[0]?.trim() || "附加资料";
  const parts = text.split(/(?=^#{1,6}\s+)/m).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(`资料：${title}\n${current.trim()}`);
    current = "";
  };
  for (const part of (parts.length ? parts : [text])) {
    if (part.length > maxChars) {
      push();
      for (let start = 0; start < part.length; start += maxChars - 400) {
        chunks.push(`资料：${title}\n${part.slice(start, start + maxChars).trim()}`);
      }
    } else if (current.length && current.length + part.length > maxChars) {
      push();
      current = part;
    } else current += `${current ? "\n" : ""}${part}`;
  }
  push();
  return chunks;
}

/** Select compact, relevant source excerpts instead of repeating every full attachment for every chapter Worker. */
export function selectRelevantSourceExcerpts(sources: string[], query: string, maxExcerpts: number): string[] {
  const terms = queryTerms(query);
  const scored = sources.flatMap((source, sourceIndex) => sourceChunks(source).map((chunk, chunkIndex) => {
    const lower = chunk.toLocaleLowerCase();
    const heading = chunk.split(/\r?\n/, 3).join("\n").toLocaleLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0) + (heading.includes(term) ? 3 : 0), 0);
    return { chunk, sourceIndex, chunkIndex, score };
  }));
  if (!scored.length) return [];
  scored.sort((left, right) => right.score - left.score || left.sourceIndex - right.sourceIndex || left.chunkIndex - right.chunkIndex);
  const selected = scored.slice(0, Math.max(1, maxExcerpts));
  return selected.map(item => item.chunk);
}

function sourceQuery(payload: Record<string, unknown>): string {
  const values: string[] = [];
  for (const key of ["documentTitle", "instruction", "chapterGoal"]) {
    const value = payload[key];
    if (typeof value === "string") values.push(value);
  }
  const titlePath = payload.titlePath;
  if (Array.isArray(titlePath)) values.push(titlePath.filter((value): value is string => typeof value === "string").join(" "));
  const outlinePlan = payload.outlinePlan;
  if (outlinePlan && typeof outlinePlan === "object") {
    const plan = outlinePlan as { documentSummary?: unknown; fixedFacts?: unknown; terminology?: unknown };
    if (typeof plan.documentSummary === "string") values.push(plan.documentSummary);
    if (Array.isArray(plan.fixedFacts)) values.push(plan.fixedFacts.filter((value): value is string => typeof value === "string").join(" "));
    if (Array.isArray(plan.terminology)) values.push(plan.terminology.map(value => typeof value === "object" && value ? `${String((value as { term?: unknown }).term ?? "")} ${String((value as { definition?: unknown }).definition ?? "")}` : "").join(" "));
  }
  return values.join("\n");
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
  input: T & { contextBudgetTokens?: number; modelContextWindowTokens?: number; attachedSources?: string[]; markdown?: string };
  systemPrompt: string;
  userPrefix: string;
  tool: AgentToolDefinition;
}): LongWritingBudgetResult<T> {
  const resolved = resolveLongWritingContextBudget(params.phase, params.input);
  const { contextBudgetTokens: _budget, modelContextWindowTokens: _window, ...raw } = params.input;
  let payload = raw as Record<string, unknown>;
  let truncatedSources = 0;
  let omittedSources = 0;
  let compactedMarkdown = false;
  const rawSources = Array.isArray(raw.attachedSources) ? raw.attachedSources.filter((value): value is string => typeof value === "string") : null;
  const selectedSources = rawSources ? selectRelevantSourceExcerpts(rawSources, sourceQuery(payload), params.phase === "outline" ? 12 : 6) : [];

  if (rawSources) {
    const fitted = fitSources(payload, selectedSources, params.systemPrompt, params.userPrefix, params.tool, resolved.budgetTokens);
    payload = fitted.payload;
    truncatedSources = fitted.truncatedSources;
    omittedSources = fitted.omittedSources + Math.max(0, rawSources.length - selectedSources.length);
  }

  let estimatedTokens = requestTokens(params.systemPrompt, params.userPrefix, payload, params.tool);
  if (estimatedTokens > resolved.budgetTokens && typeof payload.markdown === "string" && (params.phase === "outline" || params.phase === "chapter_summary" || params.phase === "consistency")) {
    const withoutMarkdown = { ...payload, markdown: "" };
    const fixedTokens = requestTokens(params.systemPrompt, params.userPrefix, withoutMarkdown, params.tool);
    const markdownBudget = Math.max(512, resolved.budgetTokens - fixedTokens - 256);
    payload = { ...payload, markdown: compactMarkdownOverview(payload.markdown, markdownBudget) };
    compactedMarkdown = true;
    estimatedTokens = requestTokens(params.systemPrompt, params.userPrefix, payload, params.tool);
  }

  if (estimatedTokens > resolved.budgetTokens) throw new LongWritingContextBudgetError(params.phase, estimatedTokens, resolved.budgetTokens);
  return {
    payload: payload as T,
    estimatedTokens,
    budgetTokens: resolved.budgetTokens,
    requestedBudgetTokens: resolved.requestedBudgetTokens,
    modelContextWindowTokens: resolved.modelContextWindowTokens,
    outputReserveTokens: resolved.outputReserveTokens,
    truncatedSources,
    omittedSources,
    sourceExcerptCount: selectedSources.length,
    compactedMarkdown,
  };
}