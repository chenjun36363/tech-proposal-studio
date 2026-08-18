import type {
  AgentToolCall,
  AgentToolDefinition,
  AgentToolFailure,
  AgentToolResult,
  ToolArgumentIssue,
  ToolArgumentValidation,
} from "./protocol";

export type AgentToolExecutor = (args: Record<string, unknown>, signal: AbortSignal) => Promise<AgentToolResult> | AgentToolResult;
export type AgentToolArgumentNormalizer = (args: Record<string, unknown>) => Record<string, unknown>;
export type AgentToolArgumentValidator = (args: Record<string, unknown>) => ToolArgumentValidation;

export interface AgentToolPreparation {
  args?: Record<string, unknown>;
  result?: AgentToolResult;
}

export interface AgentToolRegistration {
  definition: AgentToolDefinition;
  execute: AgentToolExecutor;
  /** Safe, deterministic compatibility adjustments performed before validation. */
  normalizeArgs?: AgentToolArgumentNormalizer;
  /** Tool-specific validation that needs current document/workspace state. */
  validateArgs?: AgentToolArgumentValidator;
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
};

const typeName = (value: unknown) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

/** Model-facing defaults keep argument meaning consistent even when a legacy registration omitted a property description. */
const parameterDescriptions: Record<string, string> = {
  heading_id: "必须使用 get_proposal_outline 返回的 heading_id，不要猜测或使用标题文本。",
  section_id: "必须使用读取章节或目录工具返回的稳定 section_id。",
  source_heading_id: "必须使用 get_proposal_outline 返回的源章节 heading_id。",
  target_heading_id: "必须使用 get_proposal_outline 返回的目标章节 heading_id；不能是源章节自身或其子章节。",
  memory_id: "必须使用 search_memory 返回的 memory_id。",
  source_id: "必须使用 search_knowledge 或 web_search 返回的资料 ID。",
  path: "必须使用上游工作区/资料工具返回的路径或标识；不要编造绝对路径。",
  url: "必须使用 web_search 返回的 URL；不要自行拼接或重复读取。",
  query: "简短、明确的检索关键词，不包含整段正文或密钥。",
  markdown: "待提交的 Markdown 正文；仅在对应编辑工具要求时提供。",
  content: "该操作所需的文本内容；不要附加工具说明或代码围栏。",
  replacement: "用于替换匹配文本的目标内容。",
  position: "插入位置的枚举值，严格按 schema 选择。",
  scope: "作用域枚举值，严格按 schema 选择。",
  mode: "执行模式枚举值，严格按 schema 选择。",
  action: "操作类型枚举值，严格按 schema 选择。",
  limit: "返回条数上限；使用 schema 指定的整数范围。",
  items: "结构化项目数组；每项必须符合 items 的字段约束。",
  args: "受控程序的参数数组；每项为一个独立字符串。",
  timeout_ms: "超时时间（毫秒）；仅在工具声明支持时设置。",
};

function describeSchema(schema: JsonSchema, key?: string): JsonSchema {
  const described: JsonSchema = { ...schema };
  if (!described.description && key) described.description = parameterDescriptions[key] ?? `参数 ${key}；严格遵循 schema 的类型与约束。`;
  if (described.properties) {
    described.properties = Object.fromEntries(Object.entries(described.properties)
      .map(([childKey, child]) => [childKey, describeSchema(child, childKey)]));
  }
  if (described.items) described.items = describeSchema(described.items);
  return described;
}

function issue(path: string, code: ToolArgumentIssue["code"], expected: string, actual?: string): ToolArgumentIssue {
  return { path, code, expected, ...(actual ? { actual } : {}) };
}

function validateValue(value: unknown, schema: JsonSchema, path: string, issues: ToolArgumentIssue[]): void {
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) {
    issues.push(issue(path, "INVALID_ENUM", `只能是 ${schema.enum.map(item => JSON.stringify(item)).join("、")}`, typeName(value)));
    return;
  }
  if (!schema.type) return;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(issue(path, "INVALID_TYPE", "对象", typeName(value)));
      return;
    }
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (record[key] === undefined || record[key] === null) issues.push(issue(path ? `${path}.${key}` : key, "REQUIRED", "必填字段"));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) issues.push(issue(path ? `${path}.${key}` : key, "UNKNOWN_FIELD", "已定义字段", "未知字段"));
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (record[key] !== undefined && record[key] !== null) validateValue(record[key], child, path ? `${path}.${key}` : key, issues);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push(issue(path, "INVALID_TYPE", "数组", typeName(value)));
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(issue(path, "TOO_SHORT", `至少 ${schema.minItems} 项`, "数组"));
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(issue(path, "TOO_LONG", `最多 ${schema.maxItems} 项`, "数组"));
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`, issues));
    return;
  }
  const valid = schema.type === "integer"
    ? typeof value === "number" && Number.isInteger(value)
    : typeof value === schema.type;
  if (!valid) {
    issues.push(issue(path, "INVALID_TYPE", schema.type === "integer" ? "整数" : schema.type, typeName(value)));
    return;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(issue(path, "TOO_SHORT", `至少 ${schema.minLength} 个字符`, "字符串"));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(issue(path, "TOO_LONG", `最多 ${schema.maxLength} 个字符`, "字符串"));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(issue(path, "OUT_OF_RANGE", `不小于 ${schema.minimum}`, "数字"));
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(issue(path, "OUT_OF_RANGE", `不大于 ${schema.maximum}`, "数字"));
  }
}

export function validateToolArguments(schema: Record<string, unknown>, args: Record<string, unknown>): ToolArgumentValidation {
  const issues: ToolArgumentIssue[] = [];
  validateValue(args, schema as JsonSchema, "", issues);
  return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
}

export function toolFailure(code: string, options: {
  retryable?: boolean;
  issues?: ToolArgumentIssue[];
  repair?: string;
} = {}): AgentToolFailure {
  return { code, retryable: options.retryable === true, issues: options.issues ?? [], repair: options.repair ?? "请根据字段约束修正后重试。" };
}

const snakeCaseOf = (key: string) => key.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`);

function coerceValue(schema: JsonSchema, value: unknown): unknown {
  if (value === null) return undefined;
  if (schema.type === "object") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? normalizeArgsBySchema(schema, value as Record<string, unknown>)
      : value;
  }
  if (schema.type === "array") {
    if (Array.isArray(value)) return schema.items ? value.map(item => coerceValue(schema.items!, item)) : value;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return coerceValue(schema, parsed);
      } catch { /* keep original value */ }
    }
    return value;
  }
  if ((schema.type === "integer" || schema.type === "number") && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
    return value;
  }
  if (schema.type === "boolean" && typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
    return value;
  }
  if (schema.type === "string" && typeof value === "number" && Number.isFinite(value)) return String(value);
  return value;
}

/**
 * Schema-driven tolerant normalization applied after a tool's own normalizeArgs.
 * Maps camelCase aliases to declared snake_case keys, coerces obvious primitive
 * mismatches (string numbers/booleans, JSON-string arrays, null placeholders),
 * and removes fields the schema does not declare when additionalProperties is
 * false. Undeclared keys are kept when the schema explicitly allows them.
 */
export function normalizeArgsBySchema(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const objectSchemaValue = schema as JsonSchema;
  if (objectSchemaValue.type !== "object" || !objectSchemaValue.properties || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const properties = objectSchemaValue.properties;
  const declared = new Set(Object.keys(properties));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) {
      result[key] = coerceValue(properties[key]!, value);
      continue;
    }
    const snake = snakeCaseOf(key);
    if (declared.has(snake) && !(snake in args)) {
      result[snake] = coerceValue(properties[snake]!, value);
      continue;
    }
    if (objectSchemaValue.additionalProperties !== false) result[key] = value;
  }
  return result;
}

/** Lets a domain executor return a stable failure without exposing exception text. */
export class AgentToolExecutionError extends Error {
  constructor(readonly failure: AgentToolFailure) {
    super(failure.code);
    this.name = "AgentToolExecutionError";
  }
}

export function toolExecutionError(code: string, options: Parameters<typeof toolFailure>[1] = {}) {
  return new AgentToolExecutionError(toolFailure(code, options));
}

/** Compact safe envelope passed to models. It intentionally excludes argument values and tool output. */
export function formatToolFailure(failure: AgentToolFailure): string {
  return `TOOL_ERROR ${JSON.stringify({
    code: failure.code,
    retryable: failure.retryable,
    fields: failure.issues.map(item => ({ path: item.path, code: item.code, expected: item.expected, actual: item.actual })),
    repair: failure.repair,
  })}`;
}

function withFailure(result: AgentToolResult): AgentToolResult {
  if (!result.isError) return result;
  const failure = result.failure ?? toolFailure("TOOL_EXECUTION_FAILED", { repair: "工具未能完成。请读取返回状态或改用可用工具继续。" });
  return { ...result, failure, content: formatToolFailure(failure) };
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolRegistration>();
  register(registration: AgentToolRegistration) {
    const name = registration.definition.function.name;
    if (this.tools.has(name)) throw new Error(`Agent 工具重复注册：${name}`);
    this.tools.set(name, registration);
    return this;
  }
  unregister(name: string) { this.tools.delete(name); return this; }
  has(name: string) { return this.tools.has(name); }
  definitions(): AgentToolDefinition[] { return [...this.tools.values()].map(item => item.definition); }
  /** Validates a call without invoking its executor. Safe to use for batch scheduling. */
  prepare(call: AgentToolCall): AgentToolPreparation {
    const registration = this.tools.get(call.name);
    if (!registration) {
      const failure = toolFailure("UNKNOWN_TOOL", { repair: "该工具当前不可用，请使用本轮提供的工具。" });
      return { result: { content: formatToolFailure(failure), isError: true, failure } };
    }
    try {
      const adapted = registration.normalizeArgs ? registration.normalizeArgs(call.arguments) : call.arguments;
      const args = normalizeArgsBySchema(registration.definition.function.parameters, adapted);
      const schemaValidation = validateToolArguments(registration.definition.function.parameters, args);
      const contextualValidation = schemaValidation.valid && registration.validateArgs
        ? registration.validateArgs(args)
        : { valid: true, issues: [] };
      const validation = schemaValidation.valid ? contextualValidation : schemaValidation;
      if (!validation.valid) {
        const failure = toolFailure("INVALID_ARGUMENTS", {
          retryable: true,
          issues: validation.issues,
          repair: "仅修正列出的字段后，以同一工具重试；不要重复无关参数。",
        });
        return { result: { content: formatToolFailure(failure), data: { failure }, isError: true, failure } };
      }
      return { args };
    } catch {
      const failure = toolFailure("INVALID_ARGUMENTS", {
        retryable: true,
        repair: "工具参数无法按安全规则规范化。仅修正字段格式后，以同一工具重试。",
      });
      return { result: { content: formatToolFailure(failure), data: { failure }, isError: true, failure } };
    }
  }
  async execute(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolResult> {
    if (signal.aborted) throw new DOMException("Agent 任务已取消", "AbortError");
    const prepared = this.prepare(call);
    if (prepared.result) return prepared.result;
    return this.executePrepared(call.name, prepared.args!, signal);
  }
  async executePrepared(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentToolResult> {
    if (signal.aborted) throw new DOMException("Agent 任务已取消", "AbortError");
    const registration = this.tools.get(name);
    if (!registration) {
      const failure = toolFailure("UNKNOWN_TOOL", { repair: "该工具当前不可用，请使用本轮提供的工具。" });
      return { content: formatToolFailure(failure), isError: true, failure };
    }
    try {
      return withFailure(await registration.execute(args, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      const failure = error instanceof AgentToolExecutionError
        ? error.failure
        : toolFailure("TOOL_EXECUTION_FAILED", { repair: "工具执行失败。请根据当前可用上下文调整后继续。" });
      return { content: formatToolFailure(failure), data: { failure }, isError: true, failure };
    }
  }
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  const describedProperties = Object.fromEntries(Object.entries(properties)
    .map(([key, schema]) => [key, describeSchema(schema as JsonSchema, key)]));
  return { type: "object", properties: describedProperties, required, additionalProperties: false };
}
