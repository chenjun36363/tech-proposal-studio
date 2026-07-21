import { describe, expect, it } from "vitest";
import { agentTools, buildAgentCommand, buildAgentInstallCommand, withAgentContext } from "./agents";

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
    expect(command.args).toEqual(["exec", "--skip-git-repo-check", "检查并修复测试"]);
    expect(command.cwd).toBe("D:\\workspace");
    expect(command.allowShell).toBe(false);
  });

  it("appends selected context only when enabled", () => {
    expect(withAgentContext("执行任务", ["资料 A: 摘要", "资料 B: 摘要"], true)).toContain("资料 A: 摘要\n---\n资料 B: 摘要");
    expect(withAgentContext("执行任务", ["资料 A: 摘要"], false)).toBe("执行任务");
    expect(withAgentContext("执行任务", [], true)).toBe("执行任务");
  });
});
