import { useState } from "react";
import { CheckCircle2, Download, Info, RefreshCw, Sparkles } from "lucide-react";
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

  const statusTone = status?.available ? "available" : status?.configured === false ? "unavailable" : "current";

  return <div className="settings-section-content app-update-settings">
    <div className="agent-title"><Download size={15} /><span>TechProposal Studio</span></div>
    <p className="muted app-update-intro">正式发布版本可从发布服务器检查并安装已签名更新。安装完成后应用会自动重启。</p>
    {status && <section className={`app-update-status ${statusTone}`} aria-live="polite">
      <div className="app-update-status-icon" aria-hidden="true">
        {status.available ? <Sparkles size={18} /> : status.configured === false ? <Info size={18} /> : <CheckCircle2 size={18} />}
      </div>
      <div className="app-update-status-content">
        <div className="app-update-status-heading">
          <strong>{status.available ? `发现新版本 ${status.version ?? ""}`.trim() : status.configured === false ? "在线更新暂不可用" : "当前已是最新版本"}</strong>
          <span>当前版本 {status.currentVersion}</span>
        </div>
        {status.message && <p>{status.message}</p>}
        {status.date && <time dateTime={status.date}>发布时间：{status.date}</time>}
        {status.body && <div className="app-update-release-notes">
          <b>更新说明</b>
          <p>{status.body}</p>
        </div>}
      </div>
    </section>}
    {error && <p className="model-list-error app-update-error">{error}</p>}
    <div className="modal-actions app-update-actions">
      <button type="button" disabled={checking || installing} onClick={() => void check()}><RefreshCw className={checking ? "spin" : undefined} size={15} />{checking ? "正在检查..." : "检查更新"}</button>
      {status?.available && <button type="button" className="primary" disabled={installing} onClick={() => void install()}><Download size={15} />{installing ? "正在安装..." : "下载并安装"}</button>}
    </div>
  </div>;
}
