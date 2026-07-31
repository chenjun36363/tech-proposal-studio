import type { SkillReference, SkillRuntimeStatus, SkillSummary } from "../features/skills/skills";
import { getSkillRuntimeStatus, readSkill, readSkillResource, runSkillCommand } from "../features/skills/skills";
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

export function registerSkillTools(registry: AgentToolRegistry, params: {
  skills: SkillSummary[];
  workspaceRoot?: string;
}) {
  const byName = new Map(params.skills.map(skill => [skill.name, skill]));
  registry.register({ definition: { type: "function", function: { name: "skills_manager", description: "列出项目配置中已启用的 Skill，按需读取 Skill 指令或引用资源，并检查运行环境。", parameters: objectSchema({ action: { type: "string", enum: ["list", "read", "read_resource", "runtime_status"] }, name: { type: "string" }, path: { type: "string" } }, ["action"]) } }, execute: async args => {
    const action = String(args.action ?? "");
    if (action === "list") return { content: JSON.stringify(params.skills.map(({ name, description, scope, baseDir, skillFile, allowedTools }) => ({ name, description, scope, baseDir, skillFile, allowedTools })), null, 2), isError: false };
    if (action === "runtime_status") { const status: SkillRuntimeStatus[] = await getSkillRuntimeStatus(); return { content: JSON.stringify(status, null, 2), data: status, isError: false }; }
    const requestedName = String(args.name ?? "").trim();
    const skill = requestedName ? byName.get(requestedName) : (params.skills.length === 1 ? params.skills[0] : undefined);
    if (!skill) {
      if (!requestedName) return { content: `缺少 name。项目配置已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
      return { content: `Skill「${requestedName}」未在项目配置中启用。项目配置已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
    }
    const reference: SkillReference = { name: skill.name, scope: skill.scope, baseDir: skill.baseDir, skillFile: skill.skillFile };
    if (action === "read") { const result = await readSkill(reference, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, truncated: result.truncated }, isError: false }; }
    if (action === "read_resource") { let path = String(args.path ?? ""); if (!path) return { content: "read_resource 需要 path", isError: true }; const skillPrefix = `skill://${skill.scope}/${skill.baseDir}/`; if (path.startsWith(skillPrefix)) path = path.slice(skillPrefix.length); const result = await readSkillResource(reference, path, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, path, truncated: result.truncated }, isError: false }; }
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
