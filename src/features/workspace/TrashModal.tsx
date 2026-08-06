import { useCallback, useEffect, useState } from "react";
import { FileText, Trash2, Undo2, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import type { LibraryFile } from "../../core/types";
import {
  deleteTrashFile,
  emptyTrash,
  listTrashMarkdown,
  restoreFromTrash,
} from "./workspace";

export function TrashModal({
  root,
  notify,
  close,
  onChanged,
}: {
  root: string;
  notify: (message: string) => void;
  close: () => void;
  onChanged: () => void;
}) {
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!root) {
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setFiles(await listTrashMarkdown(root));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "读取回收站失败");
    } finally {
      setLoading(false);
    }
  }, [root, notify]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = async (file: LibraryFile) => {
    setBusy(true);
    try {
      await restoreFromTrash(root, file.path);
      notify(`已加入工作区：${file.title}`);
      onChanged();
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "恢复文档失败");
    } finally {
      setBusy(false);
    }
  };

  const removePermanently = async (file: LibraryFile) => {
    if (!window.confirm(`确定从回收站永久删除「${file.title}」？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      await deleteTrashFile(root, file.path);
      notify(`已永久删除：${file.title}`);
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "删除文档失败");
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!files.length) return;
    if (!window.confirm(`确定清空回收站（${files.length} 个文档会被永久删除）？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      await emptyTrash(root);
      notify("回收站已清空");
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "清空回收站失败");
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal wide trash-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><Trash2 size={19} /><span>回收站</span></div>
        <div className="modal-title-actions">
          <button
            type="button"
            className="trash-empty-btn"
            disabled={!files.length || busy}
            onClick={() => void clearAll()}
            title="删除回收站中的所有文档"
          >清空回收站</button>
          <IconButton title="关闭" onClick={close}><X size={18} /></IconButton>
        </div>
      </div>
      <div className="trash-modal-body">
        {loading ? <div className="loading-line">正在读取回收站…</div>
          : !files.length
            ? <p className="muted">回收站为空。工作区文档移入回收站后仍保留在工作区下，可在此恢复或永久删除。</p>
            : <div className="source-list">
                {files.map(file => (
                  <article key={file.path}>
                    <div><FileText size={15} /><span>{file.path.split(/[\\/]/).pop()}</span></div>
                    <button type="button" className="result-title" title={file.path}>{file.title}</button>
                    <p>{file.excerpt || "（无正文预览）"}</p>
                    <div className="source-item-actions">
                      <button type="button" disabled={busy} onClick={() => void restore(file)}><Undo2 size={12} />加入工作区</button>
                      <button type="button" className="danger" disabled={busy} onClick={() => void removePermanently(file)}><Trash2 size={12} />删除文档</button>
                    </div>
                  </article>
                ))}
              </div>}
      </div>
    </div>
  </div>;
}