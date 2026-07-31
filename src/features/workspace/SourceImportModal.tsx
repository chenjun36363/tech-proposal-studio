import { makeId } from "../../core/data";
import type { SourceRecord } from "../../core/types";
import { FileUploadPanel } from "../../components/FileUploadPanel";
import { pickMarkdownFile, readTextFile } from "./workspace";

const SOURCE_MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

type SourceImportModalProps = {
  close: () => void;
  add: (source: SourceRecord, content?: string) => void | Promise<void>;
  historyDir: string;
};

export function SourceImportModal({ close, add, historyDir }: SourceImportModalProps) {
  return <FileUploadPanel
    title="导入 Markdown 资料"
    description="将资料 Markdown 拖到面板，或选择完整文件路径。内容会复制到知识库目录并加入项目资料。"
    extensions={SOURCE_MARKDOWN_EXTENSIONS}
    extensionLabel="Markdown（.md / .markdown）"
    destination={historyDir}
    submitLabel="导入资料"
    choosePath={() => pickMarkdownFile("选择要导入的 Markdown 资料", historyDir)}
    upload={async path => {
      const content = await readTextFile(path);
      const fileName = path.split(/[\\/]/).pop() || "未命名资料.md";
      const title = fileName.replace(/\.(md|markdown)$/i, "") || "未命名资料";
      await add({
        id: makeId(),
        kind: "local",
        title,
        location: path,
        excerpt: content.slice(0, 280),
        fingerprint: makeId(),
        accessedAt: new Date().toISOString(),
      }, content);
      return true;
    }}
    close={close}
  />;
}
