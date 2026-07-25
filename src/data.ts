import type { BlockType, Project, Section } from "./types";
import { defaultProposalMarkdown } from "./markdownDoc";
export const blockLabels: Record<BlockType, string> = { text: "正文", table: "表格", code: "代码", mermaid: "架构图", quote: "引用", decision: "决策", evidence: "命令证据" };
const titles = ["背景与目标", "范围与约束", "总体架构", "详细设计", "接口与数据", "安全设计", "部署与迁移", "风险与应对", "测试与验收"];
export const makeId = () => crypto.randomUUID();
export const makeSection = (title: string, order: number): Section => ({ id: makeId(), title, order, blocks: [{ id: makeId(), sectionId: "", type: "text", content: "", order: 0, status: "draft", sourceRefs: [] }] });
export function createProject(): Project {
  const name = "未命名技术方案";
  const sections = titles.map(makeSection).map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, sectionId: s.id })) }));
  return {
    id: makeId(), name, updatedAt: new Date().toISOString(), markdown: defaultProposalMarkdown(name), sections, sources: [],
    model: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini", timeoutMs: 60000, headers: {}, enabled: true },
    search: { provider: "searxng", endpoint: "", apiKey: "", engines: ["baidu", "360search", "bing"] },
    mineru: {
      baseUrl: "https://mineru.net",
      apiKey: "",
      modelVersion: "vlm",
      language: "ch",
      isOcr: false,
      enableTable: true,
      enableFormula: true,
      timeoutSeconds: 300,
      pollIntervalSeconds: 3,
    },
    workspace: { root: "", historyDir: "" },
    commands: [
      { id: makeId(), name: "检查 Node 版本", program: "node", args: ["--version"], cwd: ".", timeoutMs: 15000, allowShell: false },
      { id: makeId(), name: "检查 Claude CLI", program: "claude", args: ["--version"], cwd: ".", timeoutMs: 20000, allowShell: false },
      { id: makeId(), name: "检查 Codex CLI", program: "codex", args: ["--version"], cwd: ".", timeoutMs: 20000, allowShell: false },
      { id: makeId(), name: "检查 OpenCode CLI", program: "opencode", args: ["--version"], cwd: ".", timeoutMs: 20000, allowShell: false },
      { id: makeId(), name: "检查 CodeBuddy CLI", program: "codebuddy", args: ["--version"], cwd: ".", timeoutMs: 20000, allowShell: false },
    ]
  };
}

export function defaultWorkspaceFromRoot(root: string): import("./types").WorkspacePaths {
  const base = root.replace(/[\\/]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return {
    root: base,
    historyDir: `${base}${sep}history`,
  };
}

/** 兼容旧配置里的 proposalsDir / libraryDir，统一成 historyDir。 */
export function normalizeWorkspacePaths(raw: Partial<import("./types").WorkspacePaths> & {
  proposalsDir?: string;
  libraryDir?: string;
  root?: string;
} | null | undefined): import("./types").WorkspacePaths | null {
  if (!raw?.root) return null;
  const defaults = defaultWorkspaceFromRoot(raw.root);
  const historyDir = (raw as { historyDir?: string }).historyDir
    || raw.proposalsDir
    || raw.libraryDir
    || defaults.historyDir;
  return { root: defaults.root, historyDir };
}
