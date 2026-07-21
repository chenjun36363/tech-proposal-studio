import type { CommandPreset, DocumentBlock, Project } from "./types";
import { makeId } from "./data";

export type AgentToolId = "claude" | "codex" | "opencode";

export interface AgentTool {
  id: AgentToolId;
  name: string;
  program: string;
  installPackage: string;
  description: string;
  timeoutMs: number;
  buildArgs: (prompt: string) => string[];
}

export const agentTools: AgentTool[] = [
  {
    id: "claude",
    name: "Claude Code",
    program: "claude",
    installPackage: "@anthropic-ai/claude-code",
    description: "非交互 -p 输出，适合润色当前块",
    timeoutMs: 300_000,
    buildArgs: (prompt) => ["-p", prompt, "--output-format", "text"],
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex",
    installPackage: "@openai/codex",
    description: "codex exec 非交互执行",
    timeoutMs: 300_000,
    buildArgs: (prompt) => ["exec", "--skip-git-repo-check", prompt],
  },
  {
    id: "opencode",
    name: "OpenCode",
    program: "opencode",
    installPackage: "opencode-ai",
    description: "opencode run 非交互执行",
    timeoutMs: 300_000,
    buildArgs: (prompt) => ["run", prompt],
  },
];

export function defaultAgentPrompt(project: Project, block: DocumentBlock): string {
  const section = project.sections.find((s) => s.id === block.sectionId);
  const title = section?.title ?? "当前章节";
  const body = block.content.trim() || "（当前内容块为空，请直接起草）";
  return [
    "你是软件技术方案写作助手。请基于下列章节内容，输出可直接粘贴进方案的正文。",
    "要求：只返回最终正文，不要解释过程，不要使用 Markdown 代码围栏。",
    `项目：${project.name}`,
    `章节：${title}`,
    `块类型：${block.type}`,
    "",
    "当前内容：",
    body,
    "",
    "请润色并补充必要的实施约束、边界与风险点，保持专业、具体、可落地。",
  ].join("\n");
}

export function buildAgentCommand(tool: AgentTool, prompt: string, cwd = "."): CommandPreset {
  return {
    id: makeId(),
    name: tool.name,
    program: tool.program,
    args: tool.buildArgs(prompt),
    cwd,
    timeoutMs: tool.timeoutMs,
    allowShell: false,
  };
}

export function withAgentContext(prompt: string, context: string[], enabled: boolean): string {
  const task = prompt.trim();
  if (!enabled || !context.length) return task;
  return `${task}\n\n参考上下文：\n${context.join("\n---\n")}`;
}

export function buildAgentInstallCommand(tool: AgentTool): CommandPreset {
  return {
    id: makeId(),
    name: `安装 ${tool.name}`,
    program: "npm",
    args: ["install", "--global", `${tool.installPackage}@latest`, "--no-fund", "--no-audit"],
    cwd: ".",
    timeoutMs: 300_000,
    allowShell: false,
  };
}

export const systemCommandPresets = (): CommandPreset[] => [
  { id: makeId(), name: "检查 Node 版本", program: "node", args: ["--version"], cwd: ".", timeoutMs: 15_000, allowShell: false },
  { id: makeId(), name: "检查 Claude CLI", program: "claude", args: ["--version"], cwd: ".", timeoutMs: 20_000, allowShell: false },
  { id: makeId(), name: "检查 Codex CLI", program: "codex", args: ["--version"], cwd: ".", timeoutMs: 20_000, allowShell: false },
  { id: makeId(), name: "检查 OpenCode CLI", program: "opencode", args: ["--version"], cwd: ".", timeoutMs: 20_000, allowShell: false },
];
