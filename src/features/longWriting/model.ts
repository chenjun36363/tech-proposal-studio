import type { AgentMessage, AgentModelResponse, AgentToolDefinition } from "../../agent/protocol";
import type { OpenAICompatibleConfig, ResolvedModelConfig } from "../../core/types";
import { agentCompletion } from "../../services/model";
import type { ChapterDraftResult, ChapterSummarySubmission, ConsistencyIssue, OutlinePlan } from "./types";
import { prepareLongWritingPayload } from "./contextBudget";

export type LongWritingModelConfig = ResolvedModelConfig | OpenAICompatibleConfig;

export interface OutlinePlanningInput {
  mode: "fill" | "rewrite" | "targeted" | "create";
  instruction: string;
  documentTitle?: string;
  markdown: string;
  chapterSummaries?: Array<{
    chapterId: string;
    order: number;
    titlePath: string[];
    summary: string;
    facts?: string[];
    terminology?: ChapterSummarySubmission["terminology"];
    unresolvedQuestions?: string[];
    contentLength?: number;
  }>;
  requestedChapterIds?: string[];
  attachedSources?: string[];
  contextBudgetTokens?: number;
}

export interface ChapterSummaryInput {
  chapterId: string;
  titlePath: string[];
  markdown: string;
  documentTitle?: string;
  instruction: string;
  contextBudgetTokens?: number;
}

export interface ChapterDraftInput {
  chapterId: string;
  titlePath: string[];
  originalMarkdown: string;
  chapterGoal: string;
  outlinePlan: OutlinePlan;
  adjacentBriefs?: Array<{
    chapterId: string;
    relation: "previous" | "next";
    titlePath: string[];
    summary: string;
    transitionRequirement?: string;
  }>;
  committedAdjacentSummaries?: Array<{
    chapterId: string;
    relation: "previous" | "next";
    summary: string;
  }>;
  attachedSources?: string[];
  contextBudgetTokens?: number;
}

export interface ConsistencyCheckInput {
  outlinePlan: OutlinePlan;
  markdown: string;
  chapterSummaries?: Array<{
    chapterId: string;
    titlePath: string[];
    summary: string;
  }>;
  contextBudgetTokens?: number;
}

type JsonRecord = Record<string, unknown>;
type ToolName = "submit_outline_plan" | "submit_chapter_summary" | "submit_chapter_draft" | "submit_consistency_report";

const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const terminologySchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["term", "definition"],
    properties: {
      term: { type: "string" },
      definition: { type: "string" },
    },
  },
} as const;

const outlineTool: AgentToolDefinition = {
  type: "function",
  function: {
    name: "submit_outline_plan",
    description: "提交完整长文档规划。必须一次性填写全部 OutlinePlan 字段。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "documentSummary",
        "audience",
        "writingRules",
        "fixedFacts",
        "terminology",
        "frozenOutline",
        "transitionRequirements",
        "targetChapterIds",
      ],
      properties: {
        documentSummary: { type: "string" },
        audience: { type: "string" },
        writingRules: stringArraySchema,
        fixedFacts: stringArraySchema,
        terminology: terminologySchema,
        frozenOutline: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["chapterId", "order", "titlePath", "headingSkeleton", "goal", "action"],
            properties: {
              chapterId: { type: "string" },
              order: { type: "integer", minimum: 0 },
              titlePath: stringArraySchema,
              headingSkeleton: stringArraySchema,
              goal: { type: "string" },
              action: { type: "string", enum: ["fill", "rewrite", "modify", "keep"] },
            },
          },
        },
        transitionRequirements: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fromChapterId", "toChapterId", "requirement"],
            properties: {
              fromChapterId: { type: "string" },
              toChapterId: { type: "string" },
              requirement: { type: "string" },
            },
          },
        },
        targetChapterIds: stringArraySchema,
      },
    },
  },
};

const chapterSummaryTool: AgentToolDefinition = {
  type: "function",
  function: {
    name: "submit_chapter_summary",
    description: "提交单个章节的结构化摘要，供 Coordinator 规划长文档。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["chapterId", "titlePath", "summary", "facts", "terminology", "unresolvedQuestions"],
      properties: {
        chapterId: { type: "string" },
        titlePath: stringArraySchema,
        summary: { type: "string" },
        facts: stringArraySchema,
        terminology: terminologySchema,
        unresolvedQuestions: stringArraySchema,
      },
    },
  },
};

const chapterDraftTool: AgentToolDefinition = {
  type: "function",
  function: {
    name: "submit_chapter_draft",
    description: "提交一个章节的完整草稿与摘要。Worker 不拥有文件或普通 Agent 工具。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["chapterId", "markdown", "summary", "factsUsed", "terminologyUsed", "openQuestions"],
      properties: {
        chapterId: { type: "string" },
        markdown: { type: "string" },
        summary: { type: "string" },
        factsUsed: stringArraySchema,
        terminologyUsed: terminologySchema,
        openQuestions: stringArraySchema,
      },
    },
  },
};

const consistencyTool: AgentToolDefinition = {
  type: "function",
  function: {
    name: "submit_consistency_report",
    description: "提交一致性问题列表；只报告问题，不修改正文。无问题时提交空数组。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["issues"],
      properties: {
        issues: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "chapterIds", "evidence", "severity", "suggestion", "status"],
            properties: {
              id: { type: "string" },
              type: {
                type: "string",
                enum: ["terminology", "fact", "duplication", "missing_chapter", "transition", "markdown"],
              },
              chapterIds: stringArraySchema,
              evidence: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              suggestion: { type: "string" },
              status: { type: "string", enum: ["pending"] },
            },
          },
        },
      },
    },
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label}必须是 JSON 对象`);
  return value;
}

function requireString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}缺少有效字段 ${key}`);
  return value;
}

function requireStringArray(record: JsonRecord, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label}缺少有效字段 ${key}`);
  }
  return value;
}

function requireRecordArray(record: JsonRecord, key: string, label: string): JsonRecord[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) throw new Error(`${label}缺少有效字段 ${key}`);
  return value as JsonRecord[];
}

function validateTerminology(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  value.forEach((item, index) => {
    const entry = requireRecord(item, `${label}[${index}]`);
    requireString(entry, "term", `${label}[${index}]`);
    requireString(entry, "definition", `${label}[${index}]`);
  });
}

function parseOutlinePlan(argumentsValue: JsonRecord): OutlinePlan {
  requireString(argumentsValue, "documentSummary", "目录规划");
  requireString(argumentsValue, "audience", "目录规划");
  requireStringArray(argumentsValue, "writingRules", "目录规划");
  requireStringArray(argumentsValue, "fixedFacts", "目录规划");
  validateTerminology(argumentsValue.terminology, "目录规划.terminology");

  const outline = requireRecordArray(argumentsValue, "frozenOutline", "目录规划");
  outline.forEach((chapter, index) => {
    const label = `目录规划.frozenOutline[${index}]`;
    requireString(chapter, "chapterId", label);
    if (!Number.isInteger(chapter.order) || (chapter.order as number) < 0) throw new Error(`${label}缺少有效字段 order`);
    requireStringArray(chapter, "titlePath", label);
    requireStringArray(chapter, "headingSkeleton", label);
    requireString(chapter, "goal", label);
    if (!["fill", "rewrite", "modify", "keep"].includes(String(chapter.action))) {
      throw new Error(`${label}缺少有效字段 action`);
    }
  });

  const transitions = requireRecordArray(argumentsValue, "transitionRequirements", "目录规划");
  transitions.forEach((transition, index) => {
    const label = `目录规划.transitionRequirements[${index}]`;
    requireString(transition, "fromChapterId", label);
    requireString(transition, "toChapterId", label);
    requireString(transition, "requirement", label);
  });
  requireStringArray(argumentsValue, "targetChapterIds", "目录规划");
  return argumentsValue as unknown as OutlinePlan;
}

export function createLocalChapterSummary(input: Pick<ChapterSummaryInput, "chapterId" | "titlePath" | "markdown">): ChapterSummarySubmission {
  const facts = input.markdown
    .split(/\r?\n/)
    .map(line => line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
  const body = input.markdown
    .replace(/^\s*#{1,6}\s+.*$/gm, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[ *_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    chapterId: input.chapterId,
    titlePath: input.titlePath,
    summary: (body || input.titlePath.join(" / ")).slice(0, 1200),
    facts,
    terminology: [],
    unresolvedQuestions: [],
  };
}

function parseChapterSummary(argumentsValue: JsonRecord, expectedChapterId: string): ChapterSummarySubmission {
  const chapterId = requireString(argumentsValue, "chapterId", "章节摘要");
  if (chapterId !== expectedChapterId) throw new Error(`章节摘要 chapterId 不匹配：期望 ${expectedChapterId}，实际 ${chapterId}`);
  requireStringArray(argumentsValue, "titlePath", "章节摘要");
  requireString(argumentsValue, "summary", "章节摘要");
  requireStringArray(argumentsValue, "facts", "章节摘要");
  validateTerminology(argumentsValue.terminology, "章节摘要.terminology");
  requireStringArray(argumentsValue, "unresolvedQuestions", "章节摘要");
  return argumentsValue as unknown as ChapterSummarySubmission;
}

function parseChapterDraft(argumentsValue: JsonRecord, expectedChapterId: string): ChapterDraftResult {
  const chapterId = requireString(argumentsValue, "chapterId", "章节草稿");
  if (chapterId !== expectedChapterId) throw new Error(`章节草稿 chapterId 不匹配：期望 ${expectedChapterId}，实际 ${chapterId}`);
  requireString(argumentsValue, "markdown", "章节草稿");
  requireString(argumentsValue, "summary", "章节草稿");
  requireStringArray(argumentsValue, "factsUsed", "章节草稿");
  validateTerminology(argumentsValue.terminologyUsed, "章节草稿.terminologyUsed");
  requireStringArray(argumentsValue, "openQuestions", "章节草稿");
  return argumentsValue as unknown as ChapterDraftResult;
}

function parseConsistencyReport(argumentsValue: JsonRecord): ConsistencyIssue[] {
  const issues = requireRecordArray(argumentsValue, "issues", "一致性报告");
  issues.forEach((issue, index) => {
    const label = `一致性报告.issues[${index}]`;
    requireString(issue, "id", label);
    if (!["terminology", "fact", "duplication", "missing_chapter", "transition", "markdown"].includes(String(issue.type))) {
      throw new Error(`${label}缺少有效字段 type`);
    }
    requireStringArray(issue, "chapterIds", label);
    requireString(issue, "evidence", label);
    if (!["low", "medium", "high"].includes(String(issue.severity))) throw new Error(`${label}缺少有效字段 severity`);
    requireString(issue, "suggestion", label);
    if (issue.status !== "pending") throw new Error(`${label}缺少有效字段 status`);
  });
  return issues as unknown as ConsistencyIssue[];
}

function parseJsonObjectText(value: string, expectedName: ToolName): JsonRecord {
  const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${expectedName} 返回了无效 JSON：${detail}`);
  }
  return requireRecord(parsed, `${expectedName} 参数`);
}

function parseForcedToolArguments(response: unknown, expectedName: ToolName, allowContentJson = false): JsonRecord {
  const envelope = requireRecord(response, "模型返回");
  if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
    throw new Error("模型必须返回且只返回一个 choice");
  }
  const choice = requireRecord(envelope.choices[0], "模型 choice");
  const message = requireRecord(choice.message, "模型消息");
  if (!Array.isArray(message.tool_calls)) {
    if (allowContentJson && typeof message.content === "string" && message.content.trim()) {
      return parseJsonObjectText(message.content, expectedName);
    }
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    const finishReason = typeof choice.finish_reason === "string" ? `，finish_reason=${choice.finish_reason}` : "";
    throw new Error(`模型未返回 ${expectedName} 工具调用或严格 JSON 内容（contentLength=${contentLength}${finishReason}）`);
  }
  if (message.tool_calls.length !== 1) {
    throw new Error(`模型必须调用且只调用 ${expectedName}，不接受文本兜底`);
  }
  const call = requireRecord(message.tool_calls[0], "模型工具调用");
  if (call.type !== "function") throw new Error("模型返回了非 function 工具调用");
  const fn = requireRecord(call.function, "模型 function 工具调用");
  if (fn.name !== expectedName) throw new Error(`模型调用了错误工具：${String(fn.name ?? "")}`);
  if (typeof fn.arguments !== "string" || !fn.arguments.trim()) throw new Error(`${expectedName} 未返回 JSON 参数`);
  return parseJsonObjectText(fn.arguments, expectedName);
}

function prefersAutoToolChoice(config: LongWritingModelConfig): boolean {
  return "protocol" in config
    && config.protocol === "openai-responses"
    && /deepseek/i.test(config.model);
}

function isForcedToolChoiceCompatibilityError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|\D)400(?:\D|$)/.test(message)
    && /tool[_\s-]*choice|ToolChoiceFunction|field\s+function/i.test(message);
}

class StructuredToolOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredToolOutputError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isTransientModelRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = errorMessage(error);
  return /error sending request|failed to fetch|network|网络|connection (?:refused|reset|closed)|连接(?:失败|重置|关闭)|timed? ?out|timeout|超时|temporar|429|rate.?limit|限流|(?:^|\D)5\d{2}(?:\D|$)/i.test(message);
}

function waitForModelRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("模型请求已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("模型请求已取消", "AbortError"));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseStructuredToolResult<T>(
  response: AgentModelResponse,
  name: ToolName,
  parse: (argumentsValue: JsonRecord) => T,
  allowContentJson = false,
): T {
  try {
    return parse(parseForcedToolArguments(response, name, allowContentJson));
  } catch (error) {
    throw new StructuredToolOutputError(errorMessage(error));
  }
}

function createStructuredOutputCorrection(name: ToolName, validationError: string): AgentMessage {
  return {
    role: "user",
    content: [
      `上一次 ${name} 结构化输出未通过校验：${validationError}`,
      `请重新调用且只调用 ${name}。`,
      "function.arguments 必须是严格合法的 JSON 对象，并完整符合该工具的参数 schema。",
      "字符串中的换行、双引号和反斜杠必须正确转义；数组元素之间必须使用逗号，并正确闭合所有数组和对象。",
      "不要输出普通文本、解释或 Markdown 代码围栏，也不要调用其他工具。",
    ].join("\n"),
  };
}

async function callForcedTool<T>(
  tool: AgentToolDefinition,
  messages: AgentMessage[],
  config: LongWritingModelConfig,
  signal: AbortSignal | undefined,
  parse: (argumentsValue: JsonRecord) => T,
  maxTokens?: number,
  allowContentJson = false,
): Promise<T> {
  const name = tool.function.name as ToolName;
  let useAutoToolChoice = prefersAutoToolChoice(config);

  const completeOnce = async (requestMessages: AgentMessage[]): Promise<AgentModelResponse> => {
    const request = {
      model: config.model,
      messages: requestMessages,
      tools: [tool],
      tool_choice: useAutoToolChoice ? "auto" as const : { type: "function" as const, function: { name } },
      temperature: 0.2,
      stream: false,
      max_tokens: maxTokens,
    };
    try {
      return await agentCompletion(request, config, signal) as AgentModelResponse;
    } catch (error) {
      // Some OpenAI-compatible DeepSeek gateways expose tools but deserialize the
      // forced function object incorrectly. With exactly one tool, auto keeps the
      // worker isolated while avoiding the incompatible wire-level tool_choice.
      if (useAutoToolChoice || !isForcedToolChoiceCompatibilityError(error)) throw error;
      useAutoToolChoice = true;
      return await agentCompletion({ ...request, tool_choice: "auto" }, config, signal) as AgentModelResponse;
    }
  };

  const complete = async (requestMessages: AgentMessage[]): Promise<AgentModelResponse> => {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await completeOnce(requestMessages);
      } catch (error) {
        if (attempt >= maxAttempts || !isTransientModelRequestError(error)) throw error;
        await waitForModelRetry(700 * (2 ** (attempt - 1)), signal);
      }
    }
    throw new Error("模型请求重试次数已耗尽");
  };

  const firstResponse = await complete(messages);
  try {
    return parseStructuredToolResult(firstResponse, name, parse, allowContentJson);
  } catch (error) {
    if (!(error instanceof StructuredToolOutputError)) throw error;
    const firstError = error.message;
    const correctionMessages = [
      ...messages,
      createStructuredOutputCorrection(name, firstError),
    ];
    const retryResponse = await complete(correctionMessages);
    try {
      return parseStructuredToolResult(retryResponse, name, parse, allowContentJson);
    } catch (retryError) {
      if (!(retryError instanceof StructuredToolOutputError)) throw retryError;
      throw new Error(
        `${name} 连续两次结构化输出无效：首次：${firstError}；重试：${retryError.message}`,
      );
    }
  }
}

function jsonPayload(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function scopedChapterPlan(plan: OutlinePlan, chapterId: string): OutlinePlan {
  const target = plan.frozenOutline.find(item => item.chapterId === chapterId);
  if (!target) return plan;
  const nearbyIds = new Set(plan.frozenOutline
    .filter(item => Math.abs(item.order - target.order) <= 1)
    .map(item => item.chapterId));
  return {
    ...plan,
    frozenOutline: plan.frozenOutline.map(item => nearbyIds.has(item.chapterId)
      ? item
      : { ...item, headingSkeleton: item.headingSkeleton.slice(0, 1), goal: item.goal.slice(0, 400) }),
    transitionRequirements: plan.transitionRequirements.filter(item => nearbyIds.has(item.fromChapterId) || nearbyIds.has(item.toChapterId)),
  };
}

export async function createChapterSummary(
  input: ChapterSummaryInput,
  config: LongWritingModelConfig,
  signal?: AbortSignal,
): Promise<ChapterSummarySubmission> {
  const systemPrompt = [
    "你是隔离的章节摘要 Worker，只读取当前一个 H2 章节。",
    "只能调用 submit_chapter_summary；不得输出普通文本，不得调用文件、搜索或普通 Agent 工具。",
    "摘要应保留可供全文规划使用的固定事实、术语和待确认项，不提出目录变更。",
  ].join("\n");
  const prefix = "请总结当前章节：";
  const prepared = prepareLongWritingPayload({
    phase: "chapter_summary",
    input: { ...input },
    systemPrompt,
    userPrefix: prefix,
    tool: chapterSummaryTool,
  });
  return callForcedTool(chapterSummaryTool, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${prefix}\n${jsonPayload(prepared.payload)}` },
  ], config, signal, argumentsValue => parseChapterSummary(argumentsValue, input.chapterId), 3000, true);
}

function validateCreateOutlinePlan(plan: OutlinePlan, documentTitle?: string): OutlinePlan {
  if (!documentTitle?.trim()) throw new Error("从零创建需要方案标题");
  if (!plan.frozenOutline.length) throw new Error("从零创建目录至少需要一个 H2 章节");
  const ids = new Set<string>();
  plan.frozenOutline.forEach((chapter, index) => {
    if (!chapter.chapterId.trim() || ids.has(chapter.chapterId)) throw new Error(`从零创建目录第 ${index + 1} 章缺少唯一标识`);
    ids.add(chapter.chapterId);
    const title = chapter.titlePath.at(-1)?.trim();
    if (!title) throw new Error(`从零创建目录第 ${index + 1} 章缺少标题`);
  });
  return plan;
}

export async function createOutlinePlan(
  input: OutlinePlanningInput,
  config: LongWritingModelConfig,
  signal?: AbortSignal,
): Promise<OutlinePlan> {
  const creationRules = input.mode === "create" ? [
    "当前任务从零创建文档：documentTitle 是用户确定的 H1，绝不能改写或另行生成。",
    "必须规划至少一个按顺序排列的 H2 章节；每个 frozenOutline 项只代表一个新 H2，action 必须为 fill，targetChapterIds 必须包含全部章节。",
  ] : ["标题骨架中的 Markdown 标题行必须保持可验证；未纳入处理范围的章节 action 使用 keep。"];
  const systemPrompt = [
    "你是长篇软件技术方案的规划 Coordinator。",
    "只能调用 submit_outline_plan，不得输出普通文本，不得调用任何文件或 Agent 工具。",
    "规划必须覆盖文档摘要、受众、写作规则、固定事实、术语、完整标题骨架、章节目标、衔接要求和最终处理范围。",
    ...creationRules,
  ].join("\n");
  const prefix = "请根据以下输入生成目录规划：";
  const prepared = prepareLongWritingPayload({
    phase: "outline",
    input: { ...input },
    systemPrompt,
    userPrefix: prefix,
    tool: outlineTool,
  });
  const plan = await callForcedTool(outlineTool, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${prefix}\n${jsonPayload(prepared.payload)}` },
  ], config, signal, parseOutlinePlan, 6000, true);
  return input.mode === "create" ? validateCreateOutlinePlan(plan, input.documentTitle) : plan;
}

export async function createChapterDraft(
  input: ChapterDraftInput,
  config: LongWritingModelConfig,
  signal?: AbortSignal,
): Promise<ChapterDraftResult> {
  const systemPrompt = [
    "你是隔离的章节 Worker，只负责当前一个 H2 章节及其完整子树。",
    "只能调用 submit_chapter_draft；你没有文件权限，也没有普通 Agent、搜索或其他工具。",
    "markdown 必须包含当前章节完整内容，并严格保留输入中冻结的标题层级、标题文本和顺序。",
    "不得新增、删除、改名或移动标题；正文应遵守 Document Bible、固定事实和术语。",
  ].join("\n");
  const prefix = "请生成当前章节草稿：";
  const preparedInput = { ...input, outlinePlan: scopedChapterPlan(input.outlinePlan, input.chapterId) };
  const prepared = prepareLongWritingPayload({
    phase: "chapter_draft",
    input: preparedInput,
    systemPrompt,
    userPrefix: prefix,
    tool: chapterDraftTool,
  });
  return callForcedTool(chapterDraftTool, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${prefix}\n${jsonPayload(prepared.payload)}` },
  ], config, signal, argumentsValue => parseChapterDraft(argumentsValue, input.chapterId), undefined, true);
}

export async function createConsistencyReport(
  input: ConsistencyCheckInput,
  config: LongWritingModelConfig,
  signal?: AbortSignal,
): Promise<ConsistencyIssue[]> {
  const systemPrompt = [
    "你是长篇技术方案的一致性审查器。",
    "只能调用 submit_consistency_report，不得输出普通文本，不得修改正文或调用其他工具。",
    "仅报告术语冲突、事实冲突、重复内容、章节缺失、前后衔接和 Markdown 结构问题。",
    "所有问题初始 status 必须为 pending；没有问题时提交 issues: []。",
  ].join("\n");
  const prefix = "请检查以下冻结计划和全文：";
  const prepared = prepareLongWritingPayload({
    phase: "consistency",
    input: { ...input },
    systemPrompt,
    userPrefix: prefix,
    tool: consistencyTool,
  });
  return callForcedTool(consistencyTool, [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${prefix}\n${jsonPayload(prepared.payload)}` },
  ], config, signal, parseConsistencyReport, 5000, true);
}

export const longWritingToolContracts = {
  outline: outlineTool,
  chapterSummary: chapterSummaryTool,
  chapterDraft: chapterDraftTool,
  consistency: consistencyTool,
} as const;
