import { useState } from "react";
import { FilePlus2, X } from "lucide-react";
import { makeId } from "../../core/data";
import type { SourceRecord } from "../../core/types";
import { IconButton } from "../../components/IconButton";

type SourceImportModalProps = {
  close: () => void;
  add: (source: SourceRecord, content?: string) => void | Promise<void>;
  historyDir: string;
};

export function SourceImportModal({ close, add, historyDir }: SourceImportModalProps) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal small" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><FilePlus2 size={19} /><span>导入 Markdown</span></div>
        <IconButton title="关闭" onClick={close}><X size={18} /></IconButton>
      </div>
      {historyDir && <p className="muted path-line">将写入：{historyDir}</p>}
      <div className="form-grid">
        <label className="wide">资料名称<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：支付平台历史方案" /></label>
        <label className="wide">Markdown 内容<textarea value={content} onChange={event => setContent(event.target.value)} placeholder={"# 标题\n\n粘贴或输入资料内容…"} /></label>
      </div>
      <div className="modal-actions">
        <button onClick={close}>取消</button>
        <button className="primary" onClick={() => void add({
          id: makeId(),
          kind: "local",
          title: name || "未命名资料",
          location: historyDir || "local",
          excerpt: content.slice(0, 280),
          fingerprint: makeId(),
          accessedAt: new Date().toISOString(),
        }, content)}>导入</button>
      </div>
    </div>
  </div>;
}
