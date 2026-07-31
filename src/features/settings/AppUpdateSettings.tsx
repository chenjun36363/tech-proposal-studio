import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { checkForAppUpdate, installAppUpdate, type AppUpdateStatus } from "../../services/updater";

export function AppUpdateSettings() {
  const [status, setStatus] = useState<AppUpdateStatus>();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  const check = async () => {
    setChecking(true);
    setError("");
    try { setStatus(await checkForAppUpdate()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  };

  const install = async () => {
    setInstalling(true);
    setError("");
    try { await installAppUpdate(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setInstalling(false);
    }
  };

  return <div className="settings-section-content">
    <div className="agent-title"><Download size={15} /><span>TechProposal Studio</span></div>
    <p className="muted">正式发布版本可从发布服务器检查并安装已签名更新。安装完成后应用会自动重启。</p>
    {status && <div className="notice"><div>
      <b>当前版本 {status.currentVersion}</b>
      <span>{status.available ? `发现新版本 ${status.version}` : status.message}</span>
      {status.body && <span>{status.body}</span>}
    </div></div>}
    {error && <p className="model-list-error">{error}</p>}
    <div className="modal-actions">
      <button type="button" disabled={checking || installing} onClick={() => void check()}><RefreshCw size={15} />{checking ? "正在检查..." : "检查更新"}</button>
      {status?.available && <button type="button" className="primary" disabled={installing} onClick={() => void install()}><Download size={15} />{installing ? "正在安装..." : "下载并安装"}</button>}
    </div>
  </div>;
}
