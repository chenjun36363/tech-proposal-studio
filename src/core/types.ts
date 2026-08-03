export type BlockType = "text" | "table" | "code" | "mermaid" | "quote" | "decision" | "evidence";
export interface DocumentBlock { id: string; sectionId: string; type: BlockType; content: string; order: number; status: "draft" | "review" | "done"; sourceRefs: string[]; metadata?: Record<string, string>; }
export interface SourceRecord { id: string; kind: "local" | "web" | "manual"; title: string; location: string; excerpt: string; fingerprint: string; accessedAt: string; heading?: string; content?: string; }
/** Legacy flat model config; still derived from selected provider for call-site compatibility. */
export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; headers: Record<string, string>; enabled: boolean; }
export interface ModelOption { id: string; displayName: string; ownedBy?: string; }
/** Wire protocol for an LLM provider connection (not a vendor brand). */
export type LlmProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";
export interface SelectedModel {
  providerId: string;
  model: string;
}
export interface LlmProvider {
  id: string;
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  headers: Record<string, string>;
  enabled: boolean;
  /** Models shown in pickers for this provider. */
  activeModels: string[];
  /** Last fetched catalog (optional cache). */
  catalog?: ModelOption[];
}
/** Fully resolved connection used by model service / agent runner. */
export interface ResolvedModelConfig {
  providerId: string;
  providerName: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  headers: Record<string, string>;
  enabled: boolean;
}
export interface SearchConfig { provider: "searxng" | "brave"; endpoint: string; apiKey: string; engines?: string[]; }
/** MinerU cloud document → Markdown (Word/PDF). Stored under workspace `.gouan/connections.json`. */
export interface MinerUConfig {
  baseUrl: string;
  apiKey: string;
  modelVersion: string;
  language: string;
  isOcr: boolean;
  enableTable: boolean;
  enableFormula: boolean;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}
/** API / search connection config stored under workspace `.gouan/connections.json`. */
export interface ConnectionSettings {
  version: 2;
  providers: LlmProvider[];
  selectedModel: SelectedModel | null;
  /** Derived snapshot of the selected provider for legacy callers. */
  model: OpenAICompatibleConfig;
  search: SearchConfig;
  mineru: MinerUConfig;
}
export interface CommandPreset { id: string; name: string; program: string; args: string[]; cwd: string; timeoutMs: number; allowShell: boolean; stdin?: string; }
export interface CommandResult { exitCode: number; stdout: string; stderr: string; durationMs: number; }
export type SessionEventKind = "status" | "output" | "tool" | "error" | "done";
export interface SessionEvent { id: string; kind: SessionEventKind; label: string; content?: string; channel?: "stdout" | "stderr"; at: number; }
/** Word 导出的封面、页眉及页脚配置。Logo 以 data URL 保存在本地项目设置中。 */
export interface WordExportPreferences {
  coverLogoDataUrl: string;
  companyNameZh: string;
  companyNameEn: string;
  companyAddress: string;
  companyPhone: string;
  companyFax: string;
  companyWebsite: string;
  companyEmail: string;
  headerTitle: string;
  showFooterPageNumbers: boolean;
  /** 标题多级编号方案 id（对应 headingNumbering.ts 的 HEADING_NUMBERING_SCHEMES）；"none" 表示不加编号。 */
  headingNumbering: string;
  /** 从第几级标题开始编号（1..6，默认 1）。 */
  headingNumberingStart: number;
}
export interface WorkspacePaths {
  root: string;
  /** 知识库 Markdown 目录（引用材料，非当前编辑正文）。字段名保留以兼容旧配置。 */
  historyDir: string;
}
export interface Project {
  id: string;
  name: string;
  updatedAt: string;
  /** 当前方案正文（Markdown，来自工作目录下的 .md 文件） */
  markdown: string;
  /** 用户明确加入 AI 上下文的资料 ID；当前按项目共享。 */
  contextSourceRefs: string[];
  sources: SourceRecord[];
  /** Multi-provider LLM connections (workspace connections truth). */
  providers: LlmProvider[];
  /** Default provider+model selection. */
  selectedModel: SelectedModel | null;
  /** Derived from selectedModel for gradual migration of call sites. */
  model: OpenAICompatibleConfig;
  search: SearchConfig;
  /** MinerU 文档解析配置（与 connections 同步；apiKey 不写入 project localStorage） */
  mineru: MinerUConfig;
  /** Agent 会话、上下文和工具策略。 */
  agent: import("../agent/settings").AgentSettings;
  /** Word 导出的封面、页眉与页脚设置。 */
  wordExport: WordExportPreferences;
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
export type KnowledgeIndexStatus = "ready";
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
  charCount: number;
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
  chunkCount: number;
  charCount: number;
  headingSource: "markdown" | "toc" | "numbering" | "model" | "user";
  originalLine?: number;
  confidence: number;
  quality: KnowledgeChunkQuality;
}
export interface KnowledgeChunk {
  id: string;
  documentId: string;
  sectionId: string;
  documentTitle: string;
  headingPath: string;
  content: string;
  position: number;
  startChar: number;
  endChar: number;
  status: "ready";
  quality: KnowledgeChunkQuality;
}
export type KnowledgeChunkQuality = "good" | "normal" | "bad";
export type KnowledgeSearchField = "documentTitle" | "headingPath" | "content";
export interface KnowledgeSearchResult {
  chunk: KnowledgeChunk;
  excerpt: string;
  score: number;
  matchedSectionId: string;
  scopeSectionId: string;
  level: number;
  parentId?: string;
  canMoveUp: boolean;
}
export interface KnowledgeSectionScope {
  id: string;
  documentId: string;
  documentTitle: string;
  sectionId: string;
  parentId?: string;
  title: string;
  headingPath: string;
  level: number;
  content: string;
  sectionCount: number;
  quality: KnowledgeChunkQuality;
  canMoveUp: boolean;
}
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
