export type BlockType = "text" | "table" | "code" | "mermaid" | "quote" | "decision" | "evidence";
export interface DocumentBlock { id: string; sectionId: string; type: BlockType; content: string; order: number; status: "draft" | "review" | "done"; sourceRefs: string[]; metadata?: Record<string, string>; }
export interface Section { id: string; title: string; order: number; blocks: DocumentBlock[]; }
export interface SourceRecord { id: string; kind: "local" | "web"; title: string; location: string; excerpt: string; fingerprint: string; accessedAt: string; heading?: string; }
export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; headers: Record<string, string>; enabled: boolean; }
export interface SearchConfig { provider: "searxng" | "brave"; endpoint: string; apiKey: string; engines?: string[]; }
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
export type KnowledgeIndexStatus = "pending_enrichment" | "ready" | "partial";
export interface KnowledgeDocument {
  id: string;
  sourceType: "markdown" | "web";
  title: string;
  location: string;
  sourceUrl?: string;
  fingerprint: string;
  status: KnowledgeIndexStatus;
  error?: string;
  sectionCount: number;
  chunkCount: number;
  updatedAt: string;
  structureStatus: "indexed" | "confirmed" | "review_recommended";
}
export interface KnowledgeSection {
  id: string;
  documentId: string;
  parentId?: string;
  title: string;
  headingPath: string;
  level: number;
  position: number;
  summary: string;
  chunkCount: number;
  headingSource: "markdown" | "toc" | "numbering" | "model" | "user";
  originalLine?: number;
  confidence: number;
}
export interface KnowledgeChunk {
  id: string;
  documentId: string;
  sectionId: string;
  documentTitle: string;
  headingPath: string;
  content: string;
  summary: string;
  keywords: string[];
  position: number;
  startChar: number;
  endChar: number;
  status: "pending" | "ready" | "failed";
}
export interface KnowledgeSearchResult { chunk: KnowledgeChunk; excerpt: string; score: number; }
export interface KnowledgeScanItem { path: string; title: string; state: "unindexed" | "changed" | "indexed"; documentId?: string; }
export interface KnowledgeProgress { documentId: string; stage: string; current: number; total: number; message: string; }
export interface HeadingCandidate {
  id: string;
  line: number;
  text: string;
  original: string;
  level: number;
  selected: boolean;
  confidence: number;
  source: "markdown" | "toc" | "numbering" | "model" | "candidate" | "user";
  reason: string;
}
export interface HeadingDetectionResult {
  documentId: string;
  title: string;
  path: string;
  candidates: HeadingCandidate[];
  tocStart?: number;
  tocEnd?: number;
  modelError?: string;
}
export interface HeadingReviewDecision { id: string; line: number; selected: boolean; level: number; source: string; confidence: number; }
export interface KnowledgeBackup { name: string; path: string; createdAt: string; }
