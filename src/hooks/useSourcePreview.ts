import { useState } from "react";
import { isDesktop } from "../services/runtime";
import type { SourceRecord } from "../core/types";
import { readTextFile } from "../features/workspace/workspace";

export function useSourcePreview() {
  const [source, setSource] = useState<SourceRecord | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const close = () => setSource(null);

  const show = (next: SourceRecord, content: string) => {
    setSource(next);
    setMarkdown(content);
    setError("");
    setLoading(false);
  };

  const open = async (next: SourceRecord) => {
    setSource(next);
    setMarkdown("");
    setError("");
    if (next.kind === "manual") {
      setMarkdown(next.content ?? next.excerpt);
      return;
    }
    if (next.kind === "web") {
      setMarkdown(`# ${next.title}\n\n${next.excerpt || ""}\n\n[打开网页](${next.location})`);
      return;
    }
    if (next.kind === "cloud") {
      const citation = next.citation;
      const metadata = citation
        ? [
            `- 知识库：${citation.knowledgeBaseName || citation.knowledgeBaseId || "未标注"}`,
            `- Document ID：${citation.documentId}`,
            `- Chunk ID：${citation.chunkId}`,
            citation.locator ? `- 位置：${citation.locator}` : "",
            citation.sourceUri ? `- 原始来源：${citation.sourceUri}` : "",
          ].filter(Boolean).join("\n")
        : `- 原始来源：${next.location}`;
      setMarkdown(`# ${next.title}\n\n${metadata}\n\n---\n\n${next.content ?? next.excerpt}`);
      return;
    }
    if (next.location.startsWith("knowledge:")) {
      setMarkdown(`# ${next.title}\n\n${next.content ?? next.excerpt}`);
      return;
    }
    if (!isDesktop()) {
      setError("本地资料预览仅在桌面端可用");
      return;
    }
    if (!next.location) {
      setError("缺少资料文件路径");
      return;
    }
    setLoading(true);
    try {
      setMarkdown(await readTextFile(next.location));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取资料失败");
    } finally {
      setLoading(false);
    }
  };

  return { source, markdown, loading, error, open, show, close };
}
