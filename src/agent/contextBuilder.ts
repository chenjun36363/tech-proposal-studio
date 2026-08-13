import type { SourceRecord } from "../core/types";
import type { AgentMessage } from "./protocol";
import type { AgentConversation } from "./conversationStore";
import type { ProjectMemory } from "./memoryService";

export interface ResolvedAgentContext {
  source: SourceRecord;
  content: string;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sourceAttributes(source: SourceRecord, title: string): string {
  const attributes: Array<[string, string | number | undefined]> = [
    ["id", source.id],
    ["title", title],
  ];
  if (source.citation?.provider === "wiki-cloud") {
    attributes.push(
      ["provider", source.citation.provider],
      ["workspace_id", source.citation.workspaceId],
      ["knowledge_base_id", source.citation.knowledgeBaseId],
      ["document_id", source.citation.documentId],
      ["chunk_id", source.citation.chunkId],
      ["version_no", source.citation.versionNo],
      ["locator", source.citation.locator],
      ["source_uri", source.citation.sourceUri],
    );
  }
  return attributes
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "")
    .map(([name, value]) => `${name}="${escapeXmlAttribute(String(value))}"`)
    .join(" ");
}

export function buildProposalAgentMessages(params: {
  systemPrompt: string;
  conversation: AgentConversation;
  pinnedContext: ResolvedAgentContext[];
  pinnedContextChars?: number;
  memoryEnabled?: boolean;
  memories?: ProjectMemory[];
  memoryIndexLimit?: number;
}): AgentMessage[] {
  const memoryOverview = params.memoryEnabled === false ? "" : (params.memories ?? []).filter(item => item.status === "active").slice(0, params.memoryIndexLimit ?? 20).map(item => `- ${item.title} [${item.id} | ${item.memoryType}]`).join("\n");
  let remaining = params.pinnedContextChars ?? 198000;
  const pinned = params.pinnedContext.map(item => {
    const title = item.source.heading ? `${item.source.title} / ${item.source.heading}` : item.source.title;
    const content = item.content.slice(0, Math.max(0, remaining));
    remaining -= content.length;
    return content ? `<source ${sourceAttributes(item.source, title)}>\n${content}\n</source>` : "";
  }).filter(Boolean).join("\n\n");
  const additions = [
    params.conversation.summary ? `## 较早会话摘要\n${params.conversation.summary}` : "",
    memoryOverview ? `## 项目长期记忆目录\n以下只提供记忆目录。需要具体内容时必须调用 read_memory；不得根据标题补全事实。\n${memoryOverview}` : "",
    pinned ? `## 用户明确加入的资料\n以下资料是本轮必须参考的上下文；引用事实时保留来源标题。\n${pinned}` : "",
  ].filter(Boolean).join("\n\n");
  const system = additions ? `${params.systemPrompt}\n\n${additions}` : params.systemPrompt;
  return [{ role: "system", content: system }, ...params.conversation.messages];
}
