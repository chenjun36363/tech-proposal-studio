import type { Project, WordExportPreferences } from "./types";
import { defaultProposalMarkdown } from "../features/editor/markdownDoc";
import { defaultAgentSettings } from "../agent/settings";
import { createDefaultProvider, createDefaultSelection } from "../services/llm/defaults";
import { deriveModelSnapshot } from "../services/llm/resolve";

export const makeId = () => crypto.randomUUID();

export const DEFAULT_WORD_EXPORT_PREFERENCES: WordExportPreferences = {
  coverLogoDataUrl: "",
  companyNameZh: "江苏远大信息股份有限公司",
  companyNameEn: "JIANGSU YUANDA INFORMATION CO.,LTD.",
  companyAddress: "地址：江苏省市杨舍镇沙洲西路115号天霸商务楼A幢4F",
  companyPhone: "电话：0512-58694066",
  companyFax: "传真：0512-58549682",
  companyWebsite: "Http://www.sinoyd.com/",
  companyEmail: "E-mail:sinoyd@sinoyd.com",
  headerTitle: "",
  showFooterPageNumbers: true,
};

export function createProject(): Project {
  const name = "未命名技术方案";
  const provider = createDefaultProvider(makeId());
  const selectedModel = createDefaultSelection(provider);
  const model = deriveModelSnapshot([provider], selectedModel);
  return {
    id: makeId(), name, updatedAt: new Date().toISOString(), markdown: defaultProposalMarkdown(name), contextSourceRefs: [], sources: [],
    providers: [provider],
    selectedModel,
    model,
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
    agent: { ...defaultAgentSettings },
    wordExport: { ...DEFAULT_WORD_EXPORT_PREFERENCES },
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
    historyDir: `${base}${sep}knowledge`,
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
  const configuredHistoryDir = (raw as { historyDir?: string }).historyDir
    || raw.proposalsDir
    || raw.libraryDir
    || defaults.historyDir;
  const normalizeForComparison = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
  const legacyDefault = `${defaults.root}/history`;
  const historyDir = normalizeForComparison(configuredHistoryDir) === normalizeForComparison(legacyDefault)
    ? defaults.historyDir
    : configuredHistoryDir;
  return { root: defaults.root, historyDir };
}
