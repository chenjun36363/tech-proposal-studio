import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSkill, searchSkillMarket, updateMarketSkill } from "../features/skills/skills";
import { AgentToolRegistry } from "./toolRegistry";
import { registerSkillTools } from "./skillTools";

vi.mock("../features/skills/skills", async importOriginal => {
  const original = await importOriginal<typeof import("../features/skills/skills")>();
  return {
    ...original,
    readSkill: vi.fn().mockResolvedValue({ content: "skill body", truncated: false, reference: {} }),
    readSkillResource: vi.fn().mockResolvedValue({ content: "resource body", truncated: false, reference: {} }),
    getSkillRuntimeStatus: vi.fn().mockResolvedValue([{ name: "python", available: true }]),
    runSkillCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", truncated: false, durationMs: 1 }),
    createSkill: vi.fn().mockResolvedValue({ name: "new-skill", scope: "workspace" }),
    installSkill: vi.fn().mockResolvedValue({ name: "installed", scope: "workspace" }),
    validateSkill: vi.fn().mockResolvedValue({ name: "new-skill", ok: true, errors: [], warnings: [], requestedTools: [] }),
    packageSkill: vi.fn().mockResolvedValue("C:\\workspace\\new-skill.zip"),
    searchSkillMarket: vi.fn().mockResolvedValue({ results: [] }),
    updateMarketSkill: vi.fn().mockResolvedValue({ name: "market-skill", scope: "workspace" }),
    checkSkillUpdates: vi.fn().mockResolvedValue([]),
  };
});

const skill = { name: "docx", scope: "builtin" as const, baseDir: "docx", skillFile: "SKILL.md", description: "DOCX", allowedTools: ["skills_manager", "skill_run_command"], readOnly: true, available: true };
describe("skill agent tools", () => {
  beforeEach(() => vi.clearAllMocks());
  it("only lists skills enabled for the conversation", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "list" } }, new AbortController().signal); expect(result.content).toContain("docx"); });
  it("rejects reading a skill that is not enabled", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read", name: "excel" } }, new AbortController().signal); expect(result.isError).toBe(true); });
  it("uses the only enabled skill when the model omits name", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(result.content).toBe("skill body"); });
  it("asks for a name when multiple skills are enabled", async () => { const excel = { ...skill, name: "excel", baseDir: "excel" }; const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill, excel] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read" } }, new AbortController().signal); expect(result.isError).toBe(true); expect(result.content).toContain("docx、excel"); });
  it("requires full access before creating a skill", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "create", name: "new-skill", description: "New skill" } }, new AbortController().signal); expect(result.isError).toBe(true); expect(result.content).toContain("完全访问"); expect(createSkill).not.toHaveBeenCalled(); });
  it("creates a complete workspace skill when full access is enabled", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace", fullAccess: true }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "create", scope: "workspace", name: "new-skill", description: "New skill", content: "---\nname: new-skill\ndescription: New skill\n---", files: { "references/checklist.md": "# Checklist" } } }, new AbortController().signal); expect(result.isError).toBe(false); expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({ scope: "workspace", workspaceRoot: "C:\\workspace", name: "new-skill", files: { "references/checklist.md": "# Checklist" } })); });
  it("requires network access for ClawHub search", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "market_search", query: "doc" } }, new AbortController().signal); expect(result.isError).toBe(true); expect(searchSkillMarket).not.toHaveBeenCalled(); });
  it("does not overwrite an existing skill during market install unless requested", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace", fullAccess: true, networkAccess: true }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "market_install", scope: "workspace", slug: "market-skill" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(updateMarketSkill).toHaveBeenCalledWith(expect.objectContaining({ slug: "market-skill", overwrite: false })); });
  it("runs commands directly for an enabled skill", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skill_run_command", arguments: { skill: "docx", program: "python" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(result.content).toContain("ok"); });
  it("prevents agent-browser from probing through node or npm", async () => { const browser = { ...skill, name: "agent-browser", baseDir: "agent-browser" }; const registry = registerSkillTools(new AgentToolRegistry(), { skills: [browser], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skill_run_command", arguments: { skill: "agent-browser", program: "node", args: ["--version"] } }, new AbortController().signal); expect(result.isError).toBe(true); expect(result.content).toContain("只能直接调用 agent-browser"); });
  it("accepts the legacy name and command shape", async () => { const browser = { ...skill, name: "agent-browser", baseDir: "agent-browser" }; const registry = registerSkillTools(new AgentToolRegistry(), { skills: [browser], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skill_run_command", arguments: { name: "agent-browser", command: "agent-browser open \"https://example.com/?q=a+b\"" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(result.data).toMatchObject({ program: "agent-browser", args: ["open", "https://example.com/?q=a+b"] }); });
  it("rejects shell operators in the legacy command shape", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skill_run_command", arguments: { name: "docx", command: "python one.py & whoami" } }, new AbortController().signal); expect(result.isError).toBe(true); expect(result.content).toContain("无法安全解析"); });
});
