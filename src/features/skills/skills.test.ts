import { describe, expect, it } from "vitest";
import { applySkillSlashSelection, buildSkillsSystemPrompt, extractExplicitSkillNames, resolveEnabledSkills, skillSlashQuery, type SkillSummary } from "./skills";

const skill: SkillSummary = { name: "docx", scope: "builtin", baseDir: "docx", skillFile: "SKILL.md", description: "DOCX", allowedTools: ["skills_manager"], readOnly: true, available: true };
describe("skills", () => {
  it("only resolves enabled references that are discovered", () => expect(resolveEnabledSkills([{ name: "docx", scope: "builtin", baseDir: "docx", skillFile: "SKILL.md" }, { name: "missing", scope: "global", baseDir: "missing", skillFile: "SKILL.md" }], [skill])).toEqual([skill]));
  it("builds a progressive disclosure prompt without skill body", () => { const prompt = buildSkillsSystemPrompt([skill]); expect(prompt).toContain("skills_manager(action=read, name=<skill名称>)"); expect(prompt).toContain("skill://builtin/docx/SKILL.md"); });
  it("always enables the two built-in management skills when available", () => { const creator = { ...skill, name: "skills-creator", baseDir: "skills-creator" }; const installer = { ...skill, name: "skills-installer", baseDir: "skills-installer" }; expect(resolveEnabledSkills([], [skill, creator, installer]).map(item => item.name)).toEqual(["skills-creator", "skills-installer"]); });
  it("extracts explicit slash mentions", () => expect(extractExplicitSkillNames("请用 /docx 和 /agent-browser 完成")).toEqual(["docx", "agent-browser"]));
  it("finds and replaces the active slash query", () => { const query = skillSlashQuery("请用 /bro"); expect(query).toEqual({ query: "bro", start: 3, end: 7 }); expect(applySkillSlashSelection("请用 /bro", query!, "agent-browser")).toEqual({ text: "请用 /agent-browser ", cursor: 18 }); });
});
