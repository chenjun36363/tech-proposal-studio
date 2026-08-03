import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { pickDirectory } from "../features/workspace/workspace";
import { isDesktop } from "../services/runtime";

export function WorkspaceSetupGate({ onSetup, notify }: {
  onSetup: (root: string) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const desktop = isDesktop();

  const browse = async () => {
    const path = await pickDirectory("选择工作目录");
    if (path) setRoot(path);
  };

  const enter = async () => {
    const trimmed = root.trim();
    if (!trimmed) {
      notify("请先选择或填写一个工作目录");
      return;
    }
    setBusy(true);
    try {
      await onSetup(trimmed);
    } catch (error: any) {
      notify(error?.message ?? "设置工作目录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-setup-gate">
      <div className="workspace-setup-card">
        <div className="workspace-setup-icon"><FolderOpen size={28} /></div>
        <h1>欢迎使用构案</h1>
        <p className="muted">构案需要在本地工作目录中保存方案正文、知识库与连接配置（含模型密钥）。请先设置一个工作目录后再进入。</p>
        <label className="wide path-field">工作目录
          <div className="path-row">
            <input value={root} onChange={e => setRoot(e.target.value)} placeholder="例如 D:\gouan-workspace" disabled={busy} />
            <button type="button" disabled={!desktop || busy} onClick={() => void browse()}>浏览</button>
          </div>
        </label>
        <p className="workspace-setup-hint">连接配置（模型 / 搜索密钥）将保存在该目录的 <code>.gouan/connections.json</code> 与应用数据中。未设置工作目录前，密钥不会被持久化，重启后会丢失。</p>
        <div className="modal-actions">
          <button type="button" className="primary" disabled={busy || !root.trim()} onClick={() => void enter()}>
            {busy ? "进入中…" : "进入构案"}
          </button>
        </div>
      </div>
    </div>
  );
}
