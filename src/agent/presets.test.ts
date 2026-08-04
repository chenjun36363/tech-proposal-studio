import { describe, expect, it } from "vitest";
import { agentTools, buildAgentCommand, buildAgentInstallCommand, defaultAgentPrompt, withAgentContext } from "./presets";
import { createProject } from "../core/data";
import type { DocumentBlock } from "../core/types";

describe("agent install commands", () => {
  it.each([
    ["claude", "@anthropic-ai/claude-code@latest"],
    ["codex", "@openai/codex@latest"],
    ["opencode", "opencode-ai@latest"],
  ])("builds a shell-free npm install for %s", (id, packageName) => {
    const tool = agentTools.find(item => item.id === id)!;
    const command = buildAgentInstallCommand(tool);
    expect(command.program).toBe("npm");
    expect(command.args).toEqual(["install", "--global", packageName, "--no-fund", "--no-audit"]);
    expect(command.allowShell).toBe(false);
  });

  it("runs an agent non-interactively in the selected workspace", () => {
    const codex = agentTools.find(item => item.id === "codex")!;
    const command = buildAgentCommand(codex, "检查并修复测试", "D:\\workspace");
    expect(command.program).toBe("codex");
    expect(command.args).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--json", "-"]);
    expect(command.stdin).toBe("检查并修复测试");
    expect(command.cwd).toBe("D:\\workspace");
    expect(command.allowShell).toBe(false);
  });

  it.each(["claude", "codex"])("passes multiline prompts to %s through stdin", id => {
    const tool = agentTools.find(item => item.id === id)!;
    const prompt = "任务：完善章节\n\n当前章节内容：\n正文";
    const command = buildAgentCommand(tool, prompt);
    expect(command.stdin).toBe(prompt);
    expect(command.args).not.toContain(prompt);
  });

  it("uses DeepSeek V4 Flash Free for OpenCode tasks", () => {
    const opencode = agentTools.find(item => item.id === "opencode")!;
    const command = buildAgentCommand(opencode, "执行任务");
    expect(command.args).toEqual(["run", "--format", "json", "--pure", "--model", "opencode/deepseek-v4-flash-free", "执行任务"]);
    expect(command.stdin).toBeUndefined();
  });

  it("appends selected context only when enabled", () => {
    expect(withAgentContext("执行任务", ["资料 A: 摘要", "资料 B: 摘要"], true)).toContain("资料 A: 摘要\n---\n资料 B: 摘要");
    expect(withAgentContext("执行任务", ["资料 A: 摘要"], false)).toBe("执行任务");
    expect(withAgentContext("执行任务", [], true)).toBe("执行任务");
  });

  it("uses the current Markdown heading to make the task explicit", () => {
    const project = createProject();
    const block: DocumentBlock = { id: "markdown", sectionId: "markdown", type: "text", content: "## 4.2 部署方案\n\n现有内容", order: 0, status: "draft", sourceRefs: [] };
    const prompt = defaultAgentPrompt(project, block);
    expect(prompt).toContain("任务：请结合上下文参考内容，帮我优化当前章节。");
    expect(prompt).toContain("章节：4.2 部署方案");
    expect(prompt).toContain("只返回可直接替换当前章节的完整 Markdown 内容");
  });
});
