import type { SkillReference, SkillRuntimeStatus, SkillSummary } from "../skills";
import { getSkillRuntimeStatus, readSkill, readSkillResource, runSkillCommand } from "../skills";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

export function registerSkillTools(registry: AgentToolRegistry, params: {
  skills: SkillSummary[];
  workspaceRoot?: string;
}) {
  const byName = new Map(params.skills.map(skill => [skill.name, skill]));
  registry.register({ definition: { type: "function", function: { name: "skills_manager", description: "列出当前会话已启用的 Skill，按需读取 Skill 指令或引用资源，并检查运行环境。", parameters: objectSchema({ action: { type: "string", enum: ["list", "read", "read_resource", "runtime_status"] }, name: { type: "string" }, path: { type: "string" } }, ["action"]) } }, execute: async args => {
    const action = String(args.action ?? "");
    if (action === "list") return { content: JSON.stringify(params.skills.map(({ name, description, scope, baseDir, skillFile, allowedTools }) => ({ name, description, scope, baseDir, skillFile, allowedTools })), null, 2), isError: false };
    if (action === "runtime_status") { const status: SkillRuntimeStatus[] = await getSkillRuntimeStatus(); return { content: JSON.stringify(status, null, 2), data: status, isError: false }; }
    const requestedName = String(args.name ?? "").trim();
    const skill = requestedName ? byName.get(requestedName) : (params.skills.length === 1 ? params.skills[0] : undefined);
    if (!skill) {
      if (!requestedName) return { content: `缺少 name。当前会话已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
      return { content: `Skill「${requestedName}」未为当前会话启用。当前已启用：${params.skills.map(item => item.name).join("、") || "无"}`, isError: true };
    }
    const reference: SkillReference = { name: skill.name, scope: skill.scope, baseDir: skill.baseDir, skillFile: skill.skillFile };
    if (action === "read") { const result = await readSkill(reference, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, truncated: result.truncated }, isError: false }; }
    if (action === "read_resource") { let path = String(args.path ?? ""); if (!path) return { content: "read_resource 需要 path", isError: true }; const skillPrefix = `skill://${skill.scope}/${skill.baseDir}/`; if (path.startsWith(skillPrefix)) path = path.slice(skillPrefix.length); const result = await readSkillResource(reference, path, params.workspaceRoot); return { content: result.content, data: { skill: result.reference, path, truncated: result.truncated }, isError: false }; }
    return { content: `未知 action：${action}`, isError: true };
  }});
  if (params.workspaceRoot) registry.register({ definition: { type: "function", function: { name: "skill_run_command", description: "在当前工作区内运行已启用 Skill 所需的受控 Python、Node、npm、npx 或 agent-browser 命令。", parameters: objectSchema({ skill: { type: "string" }, program: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, ["skill", "program"]) } }, execute: async args => {
    const skill = byName.get(String(args.skill ?? ""));
    if (!skill) return { content: "该 Skill 未为当前会话启用。", isError: true };
    if (!skill.allowedTools.includes("skill_run_command")) return { content: "该 Skill 未声明命令执行能力。", isError: true };
    const program = String(args.program ?? ""); const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
    const result = await runSkillCommand({ program, args: commandArgs, cwd: typeof args.cwd === "string" ? args.cwd : params.workspaceRoot, workspaceRoot: params.workspaceRoot!, timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined });
    return { content: `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}${result.truncated ? "\n[输出已截断]" : ""}`, data: { skill: skill.name, program, args: commandArgs, ...result }, isError: result.exitCode !== 0 };
  }});
  return registry;
}
