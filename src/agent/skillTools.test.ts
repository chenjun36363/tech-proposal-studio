import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentToolRegistry } from "./toolRegistry";
import { registerSkillTools } from "./skillTools";

vi.mock("../skills", async importOriginal => {
  const original = await importOriginal<typeof import("../skills")>();
  return { ...original, readSkill: vi.fn().mockResolvedValue({ content: "skill body", truncated: false, reference: {} }), readSkillResource: vi.fn().mockResolvedValue({ content: "resource body", truncated: false, reference: {} }), getSkillRuntimeStatus: vi.fn().mockResolvedValue([{ name: "python", available: true }]), runSkillCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", truncated: false, durationMs: 1 }) };
});

const skill = { name: "docx", scope: "builtin" as const, baseDir: "docx", skillFile: "SKILL.md", description: "DOCX", allowedTools: ["skills_manager", "skill_run_command"], readOnly: true, available: true };
describe("skill agent tools", () => {
  beforeEach(() => vi.clearAllMocks());
  it("only lists skills enabled for the conversation", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "list" } }, new AbortController().signal); expect(result.content).toContain("docx"); });
  it("rejects reading a skill that is not enabled", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read", name: "excel" } }, new AbortController().signal); expect(result.isError).toBe(true); });
  it("uses the only enabled skill when the model omits name", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(result.content).toBe("skill body"); });
  it("asks for a name when multiple skills are enabled", async () => { const excel = { ...skill, name: "excel", baseDir: "excel" }; const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill, excel] }); const result = await registry.execute({ id: "1", name: "skills_manager", arguments: { action: "read" } }, new AbortController().signal); expect(result.isError).toBe(true); expect(result.content).toContain("docx、excel"); });
  it("runs commands directly for an enabled skill", async () => { const registry = registerSkillTools(new AgentToolRegistry(), { skills: [skill], workspaceRoot: "C:\\workspace" }); const result = await registry.execute({ id: "1", name: "skill_run_command", arguments: { skill: "docx", program: "python" } }, new AbortController().signal); expect(result.isError).toBe(false); expect(result.content).toContain("ok"); });
});
