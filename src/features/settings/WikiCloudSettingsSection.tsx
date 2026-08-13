import { useState, type Dispatch, type SetStateAction } from "react";
import { Cloud } from "lucide-react";
import type { Project } from "../../core/types";
import { ApiKeyField } from "../../components/ApiKeyField";
import { testWikiCloudConnection } from "../knowledge/wikiCloud";

export function WikiCloudSettingsSection({
  draft,
  setDraft,
  desktop,
}: {
  draft: Project;
  setDraft: Dispatch<SetStateAction<Project>>;
  desktop: boolean;
}) {
  const [testMessage, setTestMessage] = useState("");
  const [testing, setTesting] = useState(false);

  const update = (patch: Partial<Project["wikiCloud"]>) => {
    setTestMessage("");
    setDraft(current => ({
      ...current,
      wikiCloud: { ...current.wikiCloud, ...patch },
    }));
  };

  const testConnection = async () => {
    setTesting(true);
    setTestMessage("正在验证连接、API Key 与工作区权限...");
    try {
      const result = await testWikiCloudConnection(draft.wikiCloud);
      setTestMessage(`${result.message}${result.hitCount ? `，返回 ${result.hitCount} 条测试结果` : ""}。`);
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : "wiki-cloud 连接测试失败");
    } finally {
      setTesting(false);
    }
  };

  return <div className="settings-section-content">
    <div className="notice wiki-cloud-settings-notice">
      <Cloud size={18} />
      <div>
        <b>wiki-cloud 只读知识连接</b>
        <span>构案仅通过桌面端后端调用检索 API，不复制远程索引。API Key 加密保存在系统凭据库，不写入项目或浏览器存储。</span>
      </div>
    </div>
    <div className="form-grid">
      <label className="wide wiki-cloud-enable"><span><input type="checkbox" checked={draft.wikiCloud.enabled} disabled={!desktop} onChange={event => update({ enabled: event.target.checked })} /> 启用远程知识库</span></label>
      <label className="wide">服务地址<input value={draft.wikiCloud.baseUrl} disabled={!desktop} onChange={event => update({ baseUrl: event.target.value })} placeholder="http://127.0.0.1:5175" /></label>
      <label className="wide">Workspace ID<input value={draft.wikiCloud.workspaceId} disabled={!desktop} onChange={event => update({ workspaceId: event.target.value })} placeholder="wiki-cloud 工作区 UUID" /></label>
      <label className="wide">API Key<ApiKeyField value={draft.wikiCloud.apiKey} disabled={!desktop} placeholder="保存到 Windows 凭据管理器" onChange={apiKey => update({ apiKey })} /></label>
      <label className="wide">知识库 ID（可选）<textarea value={draft.wikiCloud.knowledgeBaseIds.join("\n")} disabled={!desktop} onChange={event => update({ knowledgeBaseIds: event.target.value.split(/[\n,，]/).map(value => value.trim()).filter(Boolean) })} placeholder="每行一个 Knowledge Base UUID；留空表示检索当前 API Key 可访问的全部知识库" /></label>
      <label>检索模式<select value={draft.wikiCloud.retrievalMode} disabled={!desktop} onChange={event => update({ retrievalMode: event.target.value as Project["wikiCloud"]["retrievalMode"] })}><option value="HYBRID">混合检索</option><option value="LEXICAL_ONLY">仅关键词</option></select></label>
      <label>返回条数<input type="number" min={1} max={50} value={draft.wikiCloud.limit} disabled={!desktop} onChange={event => update({ limit: Math.min(50, Math.max(1, Number(event.target.value) || 8)) })} /></label>
      <div className="wide wiki-cloud-test-row">
        <button type="button" disabled={!desktop || testing || !draft.wikiCloud.enabled || !draft.wikiCloud.baseUrl.trim() || !draft.wikiCloud.workspaceId.trim()} onClick={() => void testConnection()}>{testing ? "正在测试..." : "测试连接"}</button>
        <span className="muted">保存后可在右侧“资料 → wiki-cloud”中检索并加入上下文。</span>
      </div>
      {testMessage && <p className="wide muted wiki-cloud-test-message">{testMessage}</p>}
      {!desktop && <p className="wide muted">为避免浏览器接触远程知识库凭据，此功能仅在构案桌面端开放。</p>}
    </div>
  </div>;
}
