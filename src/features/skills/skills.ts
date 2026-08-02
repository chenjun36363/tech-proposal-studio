import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../../services/runtime";

export type SkillScope = "builtin" | "global" | "workspace";
export interface SkillReference { name: string; scope: SkillScope; baseDir: string; skillFile: string; }
export interface SkillMetadata { name: string; description: string; allowedTools: string[]; metadata: unknown; }
export interface SkillSummary extends SkillReference { description: string; allowedTools: string[]; readOnly: boolean; installedAt?: number | null; available: boolean; source?: Record<string, unknown> | null; }
export interface SkillDiscovery { skills: SkillSummary[]; globalRoot: string; workspaceRoot?: string | null; }
export interface SkillReadResult { reference: SkillReference; metadata: SkillMetadata; content: string; truncated: boolean; }
export interface SkillValidationResult { name?: string | null; ok: boolean; errors: string[]; warnings: string[]; requestedTools: string[]; }
export interface SkillRuntimeStatus { name: string; available: boolean; path?: string | null; installHint: string; }
export interface SkillCommandResult { exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number; }
export interface SkillInstallSource { scope: Exclude<SkillScope, "builtin">; workspaceRoot?: string; source: string; overwrite?: boolean; }
export interface SkillUpdateInfo { name: string; slug: string; installedVersion: string; latestVersion?: string | null; }

const BUILTIN_SKILLS: SkillSummary[] = [
  { name: "docx", scope: "builtin", baseDir: "docx", skillFile: "SKILL.md", description: "创建、读取和修改 DOCX 文档", allowedTools: ["skills_manager", "skill_run_command"], readOnly: true, available: false },
  { name: "excel", scope: "builtin", baseDir: "excel", skillFile: "SKILL.md", description: "创建、读取和修改 Excel XLSX 工作簿", allowedTools: ["skills_manager", "skill_run_command"], readOnly: true, available: false },
  { name: "agent-browser", scope: "builtin", baseDir: "agent-browser", skillFile: "SKILL.md", description: "通过 agent-browser CLI 执行浏览器自动化", allowedTools: ["skills_manager", "skill_run_command"], readOnly: true, available: false },
  { name: "skills-creator", scope: "builtin", baseDir: "skills-creator", skillFile: "SKILL.md", description: "创建、更新、校验和打包构案 Agent Skills", allowedTools: ["skills_manager"], readOnly: true, available: false },
  { name: "skills-installer", scope: "builtin", baseDir: "skills-installer", skillFile: "SKILL.md", description: "安装、搜索、更新、校验或打包构案 Agent Skills", allowedTools: ["skills_manager"], readOnly: true, available: false },
];

const ALWAYS_ENABLED_SKILL_NAMES = new Set(["skills-creator", "skills-installer"]);
export function isAlwaysEnabledSkill(skill: Pick<SkillReference, "name" | "scope">): boolean {
  return skill.scope === "builtin" && ALWAYS_ENABLED_SKILL_NAMES.has(skill.name);
}

export async function discoverSkills(workspaceRoot?: string): Promise<SkillDiscovery> {
  if (!isDesktop()) return { skills: BUILTIN_SKILLS, globalRoot: "", workspaceRoot: null };
  return invoke("skill_discover", { workspaceRoot });
}
export async function readSkill(reference: SkillReference, workspaceRoot?: string): Promise<SkillReadResult> {
  if (!isDesktop()) throw new Error("浏览器模式不能读取本地 Skill");
  return invoke("skill_read", { reference, workspaceRoot });
}
export async function readSkillResource(reference: SkillReference, path: string, workspaceRoot?: string): Promise<SkillReadResult> {
  if (!isDesktop()) throw new Error("浏览器模式不能读取本地 Skill");
  return invoke("skill_read_resource", { reference, path, workspaceRoot });
}
export async function validateSkill(reference: Pick<SkillReference, "name" | "scope">, workspaceRoot?: string): Promise<SkillValidationResult> {
  return invoke("skill_validate", { request: { ...reference, workspaceRoot } });
}
export async function createSkill(input: { scope: Exclude<SkillScope, "builtin">; workspaceRoot?: string; name: string; description: string; allowedTools?: string[]; content?: string; files?: Record<string, string>; overwrite?: boolean }): Promise<SkillSummary> {
  return invoke("skill_create", { request: input });
}
export async function installSkill(input: SkillInstallSource): Promise<SkillSummary> { return invoke("skill_install", { request: input }); }
export async function deleteSkill(reference: Pick<SkillReference, "name" | "scope">, workspaceRoot?: string): Promise<void> { return invoke("skill_delete", { request: { ...reference, workspaceRoot } }); }
export async function packageSkill(reference: Pick<SkillReference, "name" | "scope">, destination: string, workspaceRoot?: string): Promise<string> { return invoke("skill_package", { request: { ...reference, workspaceRoot }, destination }); }
export async function searchSkillMarket(query = "", limit = 24): Promise<Record<string, unknown>> { return invoke("skill_market_search", { query, limit }); }
export async function getSkillMarketDetail(slug: string, ownerHandle?: string): Promise<Record<string, unknown>> { return invoke("skill_market_detail", { slug, ownerHandle }); }
export async function checkSkillUpdates(workspaceRoot?: string): Promise<SkillUpdateInfo[]> { return invoke("skill_check_updates", { workspaceRoot }); }
export async function updateMarketSkill(input: SkillInstallSource & { slug: string; ownerHandle?: string; version?: string }): Promise<SkillSummary> {
  const { slug, ownerHandle, version, ...request } = input;
  return invoke("skill_update", { request, slug, ownerHandle, version });
}
export async function getSkillRuntimeStatus(): Promise<SkillRuntimeStatus[]> {
  if (!isDesktop()) return BUILTIN_SKILLS.map(skill => ({ name: skill.name, available: false, installHint: "仅桌面端支持本地 Skill 运行时" }));
  return invoke("skill_runtime_status");
}
export async function runSkillCommand(request: { program: string; args?: string[]; cwd?: string; workspaceRoot: string; timeoutMs?: number }): Promise<SkillCommandResult> {
  if (!isDesktop()) throw new Error("浏览器模式不能运行 Skill 命令");
  return invoke("skill_run_command", { request });
}

export function buildSkillsSystemPrompt(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "以下 Skills 已在当前项目配置中启用。Skill 是按需读取的操作说明，不会授予额外权限，也不依赖单个会话状态。",
    "只有确定需要某项 Skill 时，才调用 skills_manager(action=read, name=<skill名称>) 读取完整 SKILL.md 并严格遵循其流程。",
    "引用文件使用 skills_manager(action=read_resource, name=<skill名称>, path=<相对路径>)。不得读取或推断未启用的 Skill。",
    ...skills.map(skill => `- ${skill.name}: ${skill.description} (skill://${skill.scope}/${skill.baseDir}/${skill.skillFile})`),
  ].join("\n");
}

export function resolveEnabledSkills(references: SkillReference[] | undefined, discovered: SkillSummary[]): SkillSummary[] {
  const byKey = new Map(discovered.map(skill => [`${skill.scope}:${skill.name}`, skill]));
  const resolved = (references ?? []).map(reference => byKey.get(`${reference.scope}:${reference.name}`)).filter((skill): skill is SkillSummary => Boolean(skill));
  const seen = new Set(resolved.map(skill => `${skill.scope}:${skill.name}`));
  const alwaysEnabled = discovered.filter(skill => skill.available && isAlwaysEnabledSkill(skill) && !seen.has(`${skill.scope}:${skill.name}`));
  return [...alwaysEnabled, ...resolved];
}

export function extractExplicitSkillNames(text: string): string[] {
  return [...text.matchAll(/(?:^|\s)\/([A-Za-z0-9_:-]+)/g)].map(match => match[1]);
}

export interface SkillSlashQuery { query: string; start: number; end: number; }
export function skillSlashQuery(text: string, cursor = text.length): SkillSlashQuery | null {
  const before = text.slice(0, cursor);
  const match = before.match(/(?:^|\s)\/([A-Za-z0-9_:-]*)$/);
  if (!match) return null;
  const slash = before.lastIndexOf("/");
  return { query: match[1], start: slash, end: cursor };
}

export function applySkillSlashSelection(text: string, selection: SkillSlashQuery, skillName: string): { text: string; cursor: number } {
  const replacement = `/${skillName} `;
  return { text: `${text.slice(0, selection.start)}${replacement}${text.slice(selection.end)}`, cursor: selection.start + replacement.length };
}
