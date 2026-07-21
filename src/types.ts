export type BlockType = "text" | "table" | "code" | "mermaid" | "quote" | "decision" | "evidence";
export interface DocumentBlock { id: string; sectionId: string; type: BlockType; content: string; order: number; status: "draft" | "review" | "done"; sourceRefs: string[]; metadata?: Record<string, string>; }
export interface Section { id: string; title: string; order: number; blocks: DocumentBlock[]; }
export interface SourceRecord { id: string; kind: "local" | "web"; title: string; location: string; excerpt: string; fingerprint: string; accessedAt: string; heading?: string; }
export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; headers: Record<string, string>; enabled: boolean; }
export interface SearchConfig { provider: "searxng" | "brave"; endpoint: string; apiKey: string; }
/** API / search connection config stored under workspace `.gouan/connections.json`. */
export interface ConnectionSettings {
  model: OpenAICompatibleConfig;
  search: SearchConfig;
}
export interface CommandPreset { id: string; name: string; program: string; args: string[]; cwd: string; timeoutMs: number; allowShell: boolean; stdin?: string; }
export interface CommandResult { exitCode: number; stdout: string; stderr: string; durationMs: number; }
export interface WorkspacePaths {
  root: string;
  /** 历史资料 Markdown 目录（引用材料，非当前编辑正文） */
  historyDir: string;
}
export interface Project {
  id: string;
  name: string;
  updatedAt: string;
  /** 当前方案正文（Markdown，来自工作目录下的 .md 文件） */
  markdown: string;
  sections: Section[];
  sources: SourceRecord[];
  model: OpenAICompatibleConfig;
  search: SearchConfig;
  commands: CommandPreset[];
  workspace?: WorkspacePaths;
  /** 当前打开的工作区 Markdown 绝对路径 */
  filePath?: string;
}
export interface WorkspaceMarkdownFile {
  title: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  size: number;
}
export interface AiDraft { blockId: string; before: string; after: string; instruction: string; }
export interface SearchResult { title: string; url: string; excerpt: string; }
export interface ProposalFile {
  name: string;
  path: string;
  updatedAt: string;
  size: number;
}
export interface LibraryFile {
  title: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  size: number;
}
