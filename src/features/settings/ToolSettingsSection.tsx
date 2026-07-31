import { Check, Power } from "lucide-react";
import { agentToolCatalog, agentToolGroups, type AgentToolGroupId } from "../../agent/toolCatalog";
import type { Project } from "../../core/types";

const catalogNames = new Set(agentToolCatalog.map(tool => tool.name));

export function ToolSettingsSection({ draft, setDraft }: {
  draft: Project;
  setDraft: (project: Project) => void;
}) {
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
        <button type="button" onClick={() => setAllEnabled(true)}><Check size={14} />全部启用</button>
        <button type="button" onClick={() => setAllEnabled(false)}><Power size={14} />全部停用</button>
      </div>
    </div>
    <p className="muted">停用的工具不会注册给 AI，也无法在对话中执行。会话级权限仍可能临时限制已启用的工具。</p>
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
