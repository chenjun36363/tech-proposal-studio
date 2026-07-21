export type BlockType = "text" | "table" | "code" | "mermaid" | "quote" | "decision" | "evidence";
export interface DocumentBlock { id: string; sectionId: string; type: BlockType; content: string; order: number; status: "draft" | "review" | "done"; sourceRefs: string[]; metadata?: Record<string, string>; }
export interface Section { id: string; title: string; order: number; blocks: DocumentBlock[]; }
export interface SourceRecord { id: string; kind: "local" | "web"; title: string; location: string; excerpt: string; fingerprint: string; accessedAt: string; heading?: string; }
export interface OpenAICompatibleConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number; headers: Record<string, string>; enabled: boolean; }
export interface SearchConfig { provider: "searxng" | "brave"; endpoint: string; apiKey: string; }
export interface CommandPreset { id: string; name: string; program: string; args: string[]; cwd: string; timeoutMs: number; allowShell: boolean; }
export interface Project { id: string; name: string; updatedAt: string; sections: Section[]; sources: SourceRecord[]; model: OpenAICompatibleConfig; search: SearchConfig; commands: CommandPreset[]; }
export interface AiDraft { blockId: string; before: string; after: string; instruction: string; }
export interface SearchResult { title: string; url: string; excerpt: string; }
