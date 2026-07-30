import { Check, Power } from "lucide-react";
import { agentToolCatalog } from "../../agent/toolCatalog";
import type { Project } from "../../types";

const groups = [...new Set(agentToolCatalog.map(tool => tool.group))];

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

  return <div className="settings-section-content tool-settings">
    <div className="tool-settings-summary">
      <span><b>{enabledCount} / {agentToolCatalog.length}</b><small>个工具已启用</small></span>
      <div>
        <button type="button" onClick={() => setDisabled([])}><Check size={14} />全部启用</button>
        <button type="button" onClick={() => setDisabled(agentToolCatalog.map(tool => tool.name))}><Power size={14} />全部停用</button>
      </div>
    </div>
    <p className="muted">停用的工具不会注册给 AI，也无法在对话中执行。会话级权限仍可能临时限制已启用的工具。</p>
    {groups.map(group => <section className="tool-settings-group" key={group}>
      <header><b>{group}</b><span>{agentToolCatalog.filter(tool => tool.group === group && !disabled.has(tool.name)).length} 个启用</span></header>
      <div className="tool-settings-list">
        {agentToolCatalog.filter(tool => tool.group === group).map(tool => {
          const enabled = !disabled.has(tool.name);
          return <label key={tool.name} className={enabled ? "enabled" : ""}>
            <span><b>{tool.label}</b><small>{tool.description}</small><code>{tool.name}</code></span>
            <input type="checkbox" role="switch" checked={enabled} onChange={event => toggle(tool.name, event.target.checked)} />
          </label>;
        })}
      </div>
    </section>)}
  </div>;
}
