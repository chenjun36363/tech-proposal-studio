import { useCallback, useEffect, useMemo, useState } from "react";
import { FileCheck2, FolderOpen, LoaderCircle, UploadCloud, X } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IconButton } from "./IconButton";
import { isDesktop } from "../services/runtime";

export function fileExtension(path: string): string {
  const fileName = path.trim().split(/[\\/]/).pop() ?? "";
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLocaleLowerCase() : "";
}

export function acceptsUploadPath(path: string, extensions: readonly string[]): boolean {
  if (!path.trim()) return false;
  if (!extensions.length) return true;
  const extension = fileExtension(path);
  return extensions.some(item => {
    const normalized = item.startsWith(".") ? item.toLocaleLowerCase() : `.${item.toLocaleLowerCase()}`;
    return normalized === extension;
  });
}

type FileUploadPanelProps = {
  title: string;
  description: string;
  extensions: readonly string[];
  extensionLabel: string;
  destination?: string;
  initialPath?: string;
  busy?: boolean;
  submitLabel?: string;
  choosePath: () => Promise<string | null>;
  upload: (path: string) => Promise<boolean | void>;
  close: () => void;
};

export function FileUploadPanel({
  title,
  description,
  extensions,
  extensionLabel,
  destination,
  initialPath = "",
  busy = false,
  submitLabel = "开始导入",
  choosePath,
  upload,
  close,
}: FileUploadPanelProps) {
  const [path, setPath] = useState(initialPath);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const desktop = isDesktop();
  const processing = busy || submitting;
  const valid = acceptsUploadPath(path, extensions);
  const fileName = useMemo(() => path.trim().split(/[\\/]/).pop() ?? "", [path]);

  const selectPath = useCallback((nextPath: string) => {
    const normalized = nextPath.trim().replace(/^(["'])(.*)\1$/, "$2");
    setPath(normalized);
    if (!normalized || acceptsUploadPath(normalized, extensions)) {
      setError("");
      return;
    }
    setError(fileExtension(normalized) ? `仅支持 ${extensionLabel} 文件` : "");
  }, [extensionLabel, extensions]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (disposed || processing) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDragging(true);
        return;
      }
      setDragging(false);
      if (event.payload.type !== "drop") return;
      const accepted = event.payload.paths.find(candidate => acceptsUploadPath(candidate, extensions));
      if (accepted) selectPath(accepted);
      else setError(`拖入的文件不受支持，仅支持 ${extensionLabel}`);
    }).then(fn => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, extensionLabel, extensions, processing, selectPath]);

  const browse = async () => {
    if (processing) return;
    try {
      const selected = await choosePath();
      if (selected) selectPath(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择文件失败");
    }
  };

  const submit = async () => {
    if (!valid || processing) return;
    setError("");
    setSubmitting(true);
    try {
      const succeeded = await upload(path.trim());
      if (succeeded === false) setError("导入未完成，请检查应用提示后重试");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop file-upload-backdrop" onMouseDown={() => !processing && close()}>
    <div className="modal file-upload-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><UploadCloud size={19} /><span>{title}</span></div>
        <IconButton title="关闭" disabled={processing} onClick={close}><X size={18} /></IconButton>
      </div>

      <p className="file-upload-description">{description}</p>
      <button
        type="button"
        className={`file-upload-dropzone${dragging ? " dragging" : ""}${valid ? " selected" : ""}`}
        disabled={processing || !desktop}
        onClick={() => void browse()}
      >
        <span className="file-upload-art" aria-hidden="true">{valid ? <FileCheck2 size={30} /> : <UploadCloud size={32} />}</span>
        <b>{dragging ? "松开即可选择此文件" : valid ? fileName : "将文件拖到这里"}</b>
        <span>{valid ? "可继续更换文件，或确认开始导入" : `支持 ${extensionLabel} · 也可点击选择路径`}</span>
      </button>

      <div className="file-upload-path-block">
        <label htmlFor="file-upload-path">文件路径</label>
        <div className="file-upload-path-row">
          <input
            id="file-upload-path"
            value={path}
            disabled={processing}
            onChange={event => selectPath(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={`粘贴 ${extensionLabel} 文件的完整路径`}
            spellCheck={false}
          />
          <button type="button" disabled={processing || !desktop} onClick={() => void browse()}><FolderOpen size={15} />选择路径</button>
        </div>
      </div>

      {destination && <div className="file-upload-destination"><span>导入位置</span><code title={destination}>{destination}</code></div>}
      {!desktop && <p className="file-upload-error">文件路径导入仅在桌面端可用。</p>}
      {error && <p className="file-upload-error" role="alert">{error}</p>}

      <div className="modal-actions">
        <button type="button" disabled={processing} onClick={close}>取消</button>
        <button type="button" className="primary file-upload-submit" disabled={!valid || processing || !desktop} onClick={() => void submit()}>
          {processing ? <><LoaderCircle className="spinning" size={15} />处理中…</> : <><UploadCloud size={15} />{submitLabel}</>}
        </button>
      </div>
    </div>
  </div>;
}
