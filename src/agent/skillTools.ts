import type { SkillReference, SkillRuntimeStatus, SkillScope, SkillSummary } from "../features/skills/skills";
import {
  checkSkillUpdates,
  createSkill,
  getSkillRuntimeStatus,
  installSkill,
  packageSkill,
  readSkill,
  readSkillResource,
  runSkillCommand,
  searchSkillMarket,
  updateMarketSkill,
  validateSkill,
} from "../features/skills/skills";
import { AgentToolRegistry, objectSchema, toolExecutionError, toolFailure } from "./toolRegistry";

function splitLegacyCommand(value: string): string[] | null {
  if (!value.trim() || /[&|<>\r\n]/.test(value)) return null;
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? "" : char; continue; }
    if (/\s/.test(char) && !quote) { if (current) { parts.push(current); current = ""; } continue; }
    current += char;
  }
  if (quote) return null;
  if (current) parts.push(current);
  return parts;
}

function textArg(args: Record<string, unknown>, name: string): string {
  return typeof args[name] === "string" ? args[name].trim() : "";
}

function requiredTextArg(args: Record<string, unknown>, name: string): string {
  const value = textArg(args, name);
  if (!value) throw toolExecutionError("MISSING_REQUIRED_FIELD", {
    retryable: true,
    issues: [{ path: name, code: "REQUIRED", expected: "非空字符串" }],
    repair: "补充该必填字段后，以同一工具重试。",
  });
  return value;
}

function managementScope(args: Record<string, unknown>, workspaceRoot?: string): Exclude<SkillScope, "builtin"> {
  const requested = textArg(args, "scope") || (workspaceRoot ? "workspace" : "global");
  if (requested !== "global" && requested !== "workspace") throw toolExecutionError("INVALID_SKILL_SCOPE", { retryable: true, repair: "scope 只能使用 global 或 workspace。" });
  if (requested === "workspace" && !workspaceRoot) throw toolExecutionError("WORKSPACE_NOT_CONFIGURED", { repair: "请先配置工作区，或改用 global 作用域。" });
  return requested;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  return Array.isArray(args[name]) ? args[name].filter((item): item is string => typeof item === "string") : [];
}

function stringFilesArg(args: Record<string, unknown>): Record<string, string> {
  const value = args.files;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length !== Object.keys(value).length) throw toolExecutionError("INVALID_SKILL_FILES", { retryable: true, repair: "files 中每个文件内容都必须是字符串。" });
  return Object.fromEntries(entries);
}

function jsonResult(value: unknown) {
  return { content: JSON.stringify(value, null, 2), data: value, isError: false };
}

function failureResult(code: string, repair: string, retryable = false) {
  const failure = toolFailure(code, { repair, retryable });
  return { content: "", data: { failure }, isError: true, failure };
}

export function registerSkillTools(registry: AgentToolRegistry, params: {
  skills: SkillSummary[];
  workspaceRoot?: string;
  fullAccess?: boolean;
  networkAccess?: boolean;
}) {
  const byName = new Map(params.skills.map(skill => [skill.name, skill]));
  const requireMutationAccess = () => {
    if (!params.fullAccess) throw toolExecutionError("PERMISSION_DENIED", { repair: "此操作需要用户先开启当前会话的完全访问。" });
  };
  const requireNetworkAccess = () => {
    if (!params.networkAccess) throw toolExecutionError("PERMISSION_DENIED", { repair: "此操作需要用户先开启当前会话的联网搜索。" });
  };

  registry.register({ definition: { type: "function", function: {
    name: "skills_manager",
    description: "按需读取已启用 Skill，并在会话权限允许时创建、安装、校验、打包或从 ClawHub 管理 Agent Skills。",
    parameters: objectSchema({
      action: { type: "string", enum: ["list", "read", "read_resource", "runtime_status", "create", "install", "validate", "package", "market_search", "market_install", "check_updates", "update"] },
      name: { type: "string" },
      path: { type: "string" },
      scope: { type: "string", enum: ["global", "workspace"] },
      description: { type: "string" },
      allowed_tools: { type: "array", items: { type: "string" } },
      content: { type: "string" },
      files: { type: "object", additionalProperties: { type: "string" } },
      source: { type: "string" },
      overwrite: { type: "boolean" },
      destination: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
      slug: { type: "string" },
      owner_handle: { type: "string" },
      version: { type: "string" },
    }, ["action"]),
  } }, normalizeArgs: args => {
    const normalized = { ...args };
    if (normalized.allowed_tools === undefined && Array.isArray(normalized.allowedTools)) normalized.allowed_tools = normalized.allowedTools;
    if (normalized.owner_handle === undefined && typeof normalized.ownerHandle === "string") normalized.owner_handle = normalized.ownerHandle;
    delete normalized.allowedTools;
    delete normalized.ownerHandle;
    return normalized;
  }, execute: async args => {
    const action = String(args.action ?? "");
    if (action === "list") return jsonResult(params.skills.map(({ name, description, scope, baseDir, skillFile, allowedTools }) => ({ name, description, scope, baseDir, skillFile, allowedTools })));
    if (action === "runtime_status") { const status: SkillRuntimeStatus[] = await getSkillRuntimeStatus(); return jsonResult(status); }
    if (action === "create") {
      requireMutationAccess();
      const scope = managementScope(args, params.workspaceRoot);
      const result = await createSkill({
        scope,
        workspaceRoot: params.workspaceRoot,
        name: requiredTextArg(args, "name"),
        description: requiredTextArg(args, "description"),
        allowedTools: stringArrayArg(args, "allowed_tools"),
        content: textArg(args, "content") || undefined,
        files: stringFilesArg(args),
        overwrite: args.overwrite === true,
      });
      return jsonResult(result);
    }
    if (action === "install") {
      requireMutationAccess();
      const result = await installSkill({
        scope: managementScope(args, params.workspaceRoot),
        workspaceRoot: params.workspaceRoot,
        source: requiredTextArg(args, "source"),
        overwrite: args.overwrite === true,
      });
      return jsonResult(result);
    }
    if (action === "validate") {
      const result = await validateSkill({ name: requiredTextArg(args, "name"), scope: managementScope(args, params.workspaceRoot) }, params.workspaceRoot);
      return { ...jsonResult(result), isError: !result.ok };
    }
    if (action === "package") {
      requireMutationAccess();
      const output = await packageSkill({ name: requiredTextArg(args, "name"), scope: managementScope(args, params.workspaceRoot) }, requiredTextArg(args, "destination"), params.workspaceRoot);
      return jsonResult({ destination: output });
    }
    if (action === "market_search") {
      requireNetworkAccess();
      const result = await searchSkillMarket(textArg(args, "query"), typeof args.limit === "number" ? args.limit : 24);
      return jsonResult(result);
    }
    if (action === "market_install" || action === "update") {
      requireMutationAccess();
      requireNetworkAccess();
      const result = await updateMarketSkill({
        scope: managementScope(args, params.workspaceRoot),
        workspaceRoot: params.workspaceRoot,
        source: "",
        overwrite: action === "update" || args.overwrite === true,
        slug: requiredTextArg(args, "slug"),
        ownerHandle: textArg(args, "owner_handle") || undefined,
        version: textArg(args, "version") || undefined,
      });
      return jsonResult(result);
    }
    if (action === "check_updates") {
      requireNetworkAccess();
      return jsonResult(await checkSkillUpdates(params.workspaceRoot));
    }

    const requestedName = textArg(args, "name");
    const skill = requestedName ? byName.get(requestedName) : (params.skills.length === 1 ? params.skills[0] : undefined);
    if (!skill) {
      if (!requestedName) return failureResult("SKILL_NAME_REQUIRED", "先调用 skills_manager 的 list，或传入一个已启用的 Skill name。", true);
      return failureResult("SKILL_NOT_ENABLED", "请使用 skills_manager list 返回的已启用 Skill name。", true);
    }
    const reference: SkillReference = { name: skill.name, scope: skill.scope, baseDir: skill.baseDir, skillFile: skill.skillFile };
    if (action === "read") { const result = await readSkill(reference, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, truncated: result.truncated }, isError: false }; }
    if (action === "read_resource") {
      let path = textArg(args, "path");
      if (!path) return failureResult("MISSING_SKILL_RESOURCE_PATH", "补充由 skills_manager read 返回的资源 path 后重试。", true);
      const skillPrefix = `skill://${skill.scope}/${skill.baseDir}/`;
      if (path.startsWith(skillPrefix)) path = path.slice(skillPrefix.length);
      const result = await readSkillResource(reference, path, params.workspaceRoot);
      return { content: result.content, data: { skill: result.reference, path, truncated: result.truncated }, isError: false };
    }
    return failureResult("INVALID_SKILL_ACTION", "action 必须使用工具 schema 中列出的值。", true);
  }});

  if (params.workspaceRoot) registry.register({ definition: { type: "function", function: { name: "skill_run_command", description: "在当前工作区内运行项目配置已启用 Skill 所需的受控命令。使用 skill、program、args；Skill 与程序均必须来自已启用 Skill 的说明。", parameters: objectSchema({ skill: { type: "string" }, program: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeout_ms: { type: "number" } }, ["skill", "program"]) } }, normalizeArgs: args => {
    const normalized = { ...args };
    if (normalized.skill === undefined && typeof normalized.name === "string") normalized.skill = normalized.name;
    if (normalized.timeout_ms === undefined && typeof normalized.timeoutMs === "number") normalized.timeout_ms = normalized.timeoutMs;
    if (typeof normalized.command === "string") {
      const legacy = splitLegacyCommand(normalized.command);
      if (!legacy) normalized.program = "__invalid_legacy_command__";
      else {
        if (normalized.program === undefined) normalized.program = legacy[0];
        if (normalized.args === undefined) normalized.args = legacy.slice(1);
      }
    }
    delete normalized.name;
    delete normalized.command;
    delete normalized.timeoutMs;
    return normalized;
  }, execute: async args => {
    const skillName = String(args.skill ?? "");
    const skill = byName.get(skillName);
    if (!skill) return failureResult("SKILL_NOT_ENABLED", "请使用 skills_manager list 返回的已启用 Skill name。", true);
    if (!skill.allowedTools.includes("skill_run_command")) return failureResult("SKILL_COMMAND_NOT_ALLOWED", "该 Skill 未声明命令执行能力；请改用其已声明的工具。", false);
    const program = String(args.program ?? "");
    if (program === "__invalid_legacy_command__") return failureResult("UNSAFE_LEGACY_COMMAND", "旧格式 command 不能含 shell 运算符；改用 program 和 args。", true);
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    if (skill.name === "agent-browser" && !/(^|[\\/])agent-browser(?:\.cmd|\.exe|\.bat)?$/i.test(program)) {
      return failureResult("INVALID_SKILL_COMMAND", "Agent Browser Skill 只能直接调用 agent-browser。", true);
    }
    const result = await runSkillCommand({ program, args: commandArgs, cwd: typeof args.cwd === "string" ? args.cwd : params.workspaceRoot, workspaceRoot: params.workspaceRoot!, timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined });
    if (result.exitCode !== 0) return failureResult("SKILL_COMMAND_FAILED", "命令执行未成功；请核对 Skill 的命令约束后重试。", true);
    return { content: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${result.truncated ? "\n[输出已截断]" : ""}`, data: { skill: skill.name, program, args: commandArgs, ...result }, isError: false };
  }});
  return registry;
}
