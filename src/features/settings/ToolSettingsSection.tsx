import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Check, Command, Power, RefreshCw, Trash2 } from "lucide-react";
import { agentToolCatalog, agentToolGroups, type AgentToolGroupId } from "../../agent/toolCatalog";
import type { Project } from "../../core/types";
import { clearToolQualityMetrics, listToolQualityMetrics, type ToolQualityMetricRow } from "../../agent/toolQualityMetrics";

const catalogNames = new Set(agentToolCatalog.map(tool => tool.name));

export function ToolSettingsSection({ draft, setDraft, openEnvironmentCheck }: {
  draft: Project;
  setDraft: (project: Project) => void;
  openEnvironmentCheck?: () => void;
}) {
  const [qualityRows, setQualityRows] = useState<ToolQualityMetricRow[]>([]);
  const [qualityLoading, setQualityLoading] = useState(true);
  const reloadQuality = useCallback(async () => {
    setQualityLoading(true);
    try { setQualityRows(await listToolQualityMetrics()); }
    finally { setQualityLoading(false); }
  }, []);
  useEffect(() => { void reloadQuality(); }, [reloadQuality]);
  const quality = useMemo(() => {
    const count = (kind: ToolQualityMetricRow["resultKind"]) => qualityRows
      .filter(row => row.resultKind === kind).reduce((sum, row) => sum + row.count, 0);
    const calls = qualityRows.reduce((sum, row) => sum + row.count, 0);
    const attempts = count("execution_success") + count("execution_failure");
    return {
      calls,
      success: count("execution_success"),
      validation: count("validation_failure"),
      repaired: qualityRows.filter(row => row.repaired).reduce((sum, row) => sum + row.count, 0),
      circuitBreakers: count("circuit_breaker"),
      executionRate: attempts ? Math.round(count("execution_success") / attempts * 100) : 0,
    };
  }, [qualityRows]);
  const topFailures = useMemo(() => qualityRows
    .filter(row => row.errorCode)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6), [qualityRows]);
  const clearQuality = async () => {
    if (!window.confirm("清空本机匿名工具质量数据？此操作不可恢复。")) return;
    await clearToolQualityMetrics();
    setQualityRows([]);
  };
  const disabled = new Set(draft.agent.disabledTools);
  const enabledCount = agentToolCatalog.length - agentToolCatalog.filter(tool => disabled.has(tool.name)).length;
  const setDisabled = (names: string[]) => setDraft({ ...draft, agent: { ...draft.agent, disabledTools: names } });
  const toggle = (name: string, enabled: boolean) => {
    const next = new Set(disabled);
    if (enabled) next.delete(name); else next.add(name);
    setDisabled([...next]);
  };
  const setGroupEnabled = (group: AgentToolGroupId, enabled: boolean) => {
    const next = new Set(disabled);
    for (const tool of agentToolCatalog) {
      if (tool.group !== group) continue;
      if (enabled) next.delete(tool.name); else next.add(tool.name);
    }
    setDisabled([...next]);
  };
  const setAllEnabled = (enabled: boolean) => {
    const unknownDisabled = [...disabled].filter(name => !catalogNames.has(name));
    setDisabled(enabled ? unknownDisabled : [...unknownDisabled, ...agentToolCatalog.map(tool => tool.name)]);
  };

  return <div className="settings-section-content tool-settings">
    <div className="tool-settings-summary">
      <span><b>{enabledCount} / {agentToolCatalog.length}</b><small>个工具已启用</small></span>
      <div>
        {openEnvironmentCheck && <button type="button" onClick={openEnvironmentCheck}><Command size={14} />环境检查</button>}
        <button type="button" onClick={() => setAllEnabled(true)}><Check size={14} />全部启用</button>
        <button type="button" onClick={() => setAllEnabled(false)}><Power size={14} />全部停用</button>
      </div>
    </div>
    <p className="muted">停用的工具不会注册给 AI，也无法在对话中执行。会话级权限仍可能临时限制已启用的工具。</p>
    <section className="tool-quality-settings" aria-label="本地工具质量数据">
      <header>
        <span><BarChart3 size={15} /><b>本地工具质量</b></span>
        <div>
          <button type="button" onClick={() => void reloadQuality()} disabled={qualityLoading}><RefreshCw size={13} />刷新</button>
          <button type="button" onClick={() => void clearQuality()} disabled={!qualityRows.length}><Trash2 size={13} />清空</button>
        </div>
      </header>
      <p>仅保存按日期、模型/协议、工具、结果类别和耗时桶聚合的匿名计数；不会保存提示词、正文、参数值、工具结果、路径或 API Key。</p>
      <div className="tool-quality-stats">
        <span><b>{quality.calls}</b><small>调用事件</small></span>
        <span><b>{quality.executionRate}%</b><small>执行成功率</small></span>
        <span><b>{quality.validation}</b><small>参数失败</small></span>
        <span><b>{quality.repaired}</b><small>修复成功</small></span>
        <span><b>{quality.circuitBreakers}</b><small>重复失败熔断</small></span>
      </div>
      {topFailures.length > 0 && <div className="tool-quality-failures">
        {topFailures.map((row, index) => <span key={`${row.day}-${row.toolName}-${row.resultKind}-${row.errorCode}-${index}`}>
          <code>{row.toolName}</code><b>{row.errorCode}</b><small>{row.count} 次</small>
        </span>)}
      </div>}
    </section>
    {agentToolGroups.map(group => {
      const tools = agentToolCatalog.filter(tool => tool.group === group.id);
      const groupEnabledCount = tools.filter(tool => !disabled.has(tool.name)).length;
      const allEnabled = groupEnabledCount === tools.length;
      const partiallyEnabled = groupEnabledCount > 0 && !allEnabled;
      return <section className="tool-settings-group" key={group.id}>
      <header>
        <label className="tool-group-toggle">
          <input
            type="checkbox"
            checked={allEnabled}
            ref={input => { if (input) input.indeterminate = partiallyEnabled; }}
            onChange={event => setGroupEnabled(group.id, event.target.checked)}
            aria-label={`${group.label}全部权限`}
          />
          <span><b>{group.label}</b><small>{group.description}</small></span>
        </label>
        <span>{groupEnabledCount} / {tools.length} 个启用</span>
      </header>
      <div className="tool-settings-list">
        {tools.map(tool => {
          const enabled = !disabled.has(tool.name);
          return <label key={tool.name} className={enabled ? "enabled" : ""}>
            <span><b>{tool.label}</b><small>{tool.description}</small><code>{tool.name}</code></span>
            <input type="checkbox" role="switch" checked={enabled} onChange={event => toggle(tool.name, event.target.checked)} />
          </label>;
        })}
      </div>
    </section>})}
  </div>;
}
