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
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

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
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function managementScope(args: Record<string, unknown>, workspaceRoot?: string): Exclude<SkillScope, "builtin"> {
  const requested = textArg(args, "scope") || (workspaceRoot ? "workspace" : "global");
  if (requested !== "global" && requested !== "workspace") throw new Error("scope 只能是 global 或 workspace");
  if (requested === "workspace" && !workspaceRoot) throw new Error("workspace 作用域需要先配置工作区");
  return requested;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  return Array.isArray(args[name]) ? args[name].filter((item): item is string => typeof item === "string") : [];
}

function stringFilesArg(args: Record<string, unknown>): Record<string, string> {
  const value = args.files;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length !== Object.keys(value).length) throw new Error("files 的值必须全部是字符串");
  return Object.fromEntries(entries);
}

function jsonResult(value: unknown) {
  return { content: JSON.stringify(value, null, 2), data: value, isError: false };
}

export function registerSkillTools(registry: AgentToolRegistry, params: {
  skills: SkillSummary[];
  workspaceRoot?: string;
  fullAccess?: boolean;
  networkAccess?: boolean;
}) {
  const byName = new Map(params.skills.map(skill => [skill.name, skill]));
  const requireMutationAccess = () => {
    if (!params.fullAccess) throw new Error("Skill 创建、安装、更新和打包需要先开启当前会话的完全访问");
  };
  const requireNetworkAccess = () => {
    if (!params.networkAccess) throw new Error("ClawHub 操作需要先开启当前会话的联网搜索");
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
      allowedTools: { type: "array", items: { type: "string" } },
      content: { type: "string" },
      files: { type: "object", additionalProperties: { type: "string" } },
      source: { type: "string" },
      overwrite: { type: "boolean" },
      destination: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
      slug: { type: "string" },
      ownerHandle: { type: "string" },
      version: { type: "string" },
    }, ["action"]),
  } }, execute: async args => {
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
        allowedTools: stringArrayArg(args, "allowedTools"),
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
        ownerHandle: textArg(args, "ownerHandle") || undefined,
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
      if (!requestedName) return { content: `缺少 name。项目配置已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
      return { content: `Skill「${requestedName}」未在项目配置中启用。项目配置已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
    }
    const reference: SkillReference = { name: skill.name, scope: skill.scope, baseDir: skill.baseDir, skillFile: skill.skillFile };
    if (action === "read") { const result = await readSkill(reference, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, truncated: result.truncated }, isError: false }; }
    if (action === "read_resource") {
      let path = textArg(args, "path");
      if (!path) return { content: "read_resource 需要 path", isError: true };
      const skillPrefix = `skill://${skill.scope}/${skill.baseDir}/`;
      if (path.startsWith(skillPrefix)) path = path.slice(skillPrefix.length);
      const result = await readSkillResource(reference, path, params.workspaceRoot);
      return { content: result.content, data: { skill: result.reference, path, truncated: result.truncated }, isError: false };
    }
    return { content: `未知 action：${action}`, isError: true };
  }});

  if (params.workspaceRoot) registry.register({ definition: { type: "function", function: { name: "skill_run_command", description: "在当前工作区内运行项目配置已启用 Skill 所需的受控命令。优先传 skill、program、args；兼容旧格式 name、command。", parameters: objectSchema({ skill: { type: "string" }, program: { type: "string" }, args: { type: "array", items: { type: "string" } }, name: { type: "string" }, command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }) } }, execute: async args => {
    const skillName = String(args.skill ?? args.name ?? "");
    const skill = byName.get(skillName);
    if (!skill) return { content: `Skill「${skillName || "未指定"}」未在项目配置中启用。`, isError: true };
    if (!skill.allowedTools.includes("skill_run_command")) return { content: "该 Skill 未声明命令执行能力。", isError: true };
    const legacy = typeof args.command === "string" ? splitLegacyCommand(args.command) : null;
    if (typeof args.command === "string" && !legacy) return { content: "旧格式 command 无法安全解析，请改用 program 和 args。", isError: true };
    const program = String(args.program ?? legacy?.[0] ?? "");
    const commandArgs = Array.isArray(args.args) ? args.args.map(String) : legacy?.slice(1) ?? [];
    if (skill.name === "agent-browser" && !/(^|[\\/])agent-browser(?:\.cmd|\.exe|\.bat)?$/i.test(program)) {
      return { content: "Agent Browser Skill 只能直接调用 agent-browser；不要改用 node、npm、npx、cmd 或脚本探测安装路径。", isError: true };
    }
    const result = await runSkillCommand({ program, args: commandArgs, cwd: typeof args.cwd === "string" ? args.cwd : params.workspaceRoot, workspaceRoot: params.workspaceRoot!, timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined });
    return { content: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${result.truncated ? "\n[输出已截断]" : ""}`, data: { skill: skill.name, program, args: commandArgs, ...result }, isError: result.exitCode !== 0 };
  }});
  return registry;
}
