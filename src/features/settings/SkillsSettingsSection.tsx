import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, Download, Package, Plus, RefreshCw, Search, ShieldCheck, Trash2, XCircle } from "lucide-react";
import type { Project } from "../../types";
import { checkSkillUpdates, createSkill, deleteSkill, discoverSkills, getSkillRuntimeStatus, installSkill, packageSkill, searchSkillMarket, updateMarketSkill, validateSkill, type SkillRuntimeStatus, type SkillScope, type SkillSummary } from "../../skills";
import { isDesktop } from "../../services/runtime";

type Tab = "installed" | "market" | "install" | "create" | "runtime";
type MarketCard = { slug: string; displayName: string; summary: string; latestVersion?: string | null; ownerHandle?: string | null; downloads?: number; stars?: number; downloadUrl?: string };

function marketCards(value: Record<string, unknown>): MarketCard[] {
  const rows = Array.isArray(value.results) ? value.results : Array.isArray(value.items) ? value.items : [];
  return rows.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")).map(item => ({
    slug: String(item.slug ?? ""), displayName: String(item.displayName ?? item.slug ?? ""), summary: String(item.summary ?? ""),
    latestVersion: typeof item.latestVersion === "object" && item.latestVersion ? String((item.latestVersion as Record<string, unknown>).version ?? "") : typeof item.version === "string" ? item.version : null,
    ownerHandle: typeof item.ownerHandle === "string" ? item.ownerHandle : typeof item.owner === "object" && item.owner ? String((item.owner as Record<string, unknown>).handle ?? "") : null,
    downloads: Number((item.stats as Record<string, unknown> | undefined)?.downloads ?? item.downloads ?? 0), stars: Number((item.stats as Record<string, unknown> | undefined)?.stars ?? item.stars ?? 0),
  })).filter(item => item.slug);
}

export function SkillsSettingsSection({ project, setProject }: { project: Project; setProject: (project: Project) => void }) {
  const [tab, setTab] = useState<Tab>("installed"); const [skills, setSkills] = useState<SkillSummary[]>([]); const [runtime, setRuntime] = useState<SkillRuntimeStatus[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [query, setQuery] = useState(""); const [market, setMarket] = useState<MarketCard[]>([]); const [source, setSource] = useState(""); const [scope, setScope] = useState<Exclude<SkillScope, "builtin">>(project.workspace?.root ? "workspace" : "global");
  const [newName, setNewName] = useState(""); const [newDescription, setNewDescription] = useState("");
  const workspaceRoot = project.workspace?.root;
  const refresh = async () => { setBusy(true); setError(""); try { const [found, status] = await Promise.all([discoverSkills(workspaceRoot), getSkillRuntimeStatus()]); setSkills(found.skills); setRuntime(status); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  useEffect(() => { void refresh(); }, [workspaceRoot]);
  const counts = useMemo(() => ({ builtin: skills.filter(s => s.scope === "builtin").length, global: skills.filter(s => s.scope === "global").length, workspace: skills.filter(s => s.scope === "workspace").length }), [skills]);
  const act = async (task: () => Promise<unknown>, success: string) => { setBusy(true); setError(""); setMessage(""); try { await task(); setMessage(success); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const browseSource = () => { const selected = window.prompt("输入 Skill ZIP 包的绝对路径", source); if (selected) setSource(selected); };
  const searchMarket = async () => { setBusy(true); setError(""); try { setMarket(marketCards(await searchSkillMarket(query))); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const installMarket = (card: MarketCard) => act(() => updateMarketSkill({ scope, workspaceRoot, source: "", overwrite: true, slug: card.slug, ownerHandle: card.ownerHandle ?? undefined, version: card.latestVersion ?? undefined }), `已安装 ${card.displayName}`);
  const toggleSkill = (skill: SkillSummary, enabled: boolean) => {
    const current = project.agent.enabledSkills ?? [];
    const next = enabled
      ? [...current.filter(item => !(item.name === skill.name && item.scope === skill.scope)), { name: skill.name, scope: skill.scope, baseDir: skill.baseDir, skillFile: skill.skillFile }]
      : current.filter(item => !(item.name === skill.name && item.scope === skill.scope));
    setProject({ ...project, agent: { ...project.agent, enabledSkills: next } });
  };

  return <div className="settings-section-content skills-settings">
    <div className="skills-tabs">
      {([['installed','已安装'],['market','ClawHub'],['install','本地安装'],['create','创建'],['runtime','运行环境']] as Array<[Tab,string]>).map(([id,label]) => <button type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)} key={id}>{label}</button>)}
    </div>
    {!isDesktop() && <div className="notice">浏览器模式仅展示技能状态；安装、读取和执行需要 Tauri 桌面端。</div>}
    {error && <div className="skill-message error"><XCircle size={15} />{error}</div>}{message && <div className="skill-message success"><CheckCircle2 size={15} />{message}</div>}
    {tab === "installed" && <>
      <div className="skill-summary"><span>内置 {counts.builtin}</span><span>全局 {counts.global}</span><span>工作区 {counts.workspace}</span><button type="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={13} />刷新</button></div>
      <div className="skill-list">{skills.map(skill => { const enabled = project.agent.enabledSkills?.some(item => item.name === skill.name && item.scope === skill.scope) ?? false; return <article className={enabled ? "enabled" : ""} key={`${skill.scope}:${skill.name}`}>
        <div><span><b>{skill.name}</b><small>{skill.scope === "builtin" ? "内置" : skill.scope === "global" ? "全局" : "工作区"}</small></span><label className="skill-card-toggle"><input type="checkbox" role="switch" checked={enabled} disabled={!skill.available} onChange={event => toggleSkill(skill, event.target.checked)} /><span>{enabled ? "已启用" : "已停用"}</span></label></div><p>{skill.description}</p>
        <div className="skill-tools">{skill.allowedTools.map(tool => <code key={tool}>{tool}</code>)}</div>
        <footer><button type="button" onClick={() => void act(async () => { const result = await validateSkill(skill, workspaceRoot); if (!result.ok) throw new Error(result.errors.join("；")); }, `${skill.name} 校验通过`)}><ShieldCheck size={13} />校验</button>
          {!skill.readOnly && <><button type="button" onClick={() => { const destination = window.prompt("输入导出 ZIP 的绝对路径", `${skill.name}.zip`); if (destination) void act(() => packageSkill(skill, destination, workspaceRoot), "Skill 已打包"); }}><Package size={13} />打包</button><button type="button" className="danger" onClick={() => { if (confirm(`删除 Skill「${skill.name}」？`)) void act(() => deleteSkill(skill, workspaceRoot), "Skill 已删除"); }}><Trash2 size={13} />删除</button></>}
        </footer>
      </article>; })}</div>
    </>}
    {tab === "market" && <><div className="skill-market-search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 ClawHub Skills" onKeyDown={e => { if (e.key === "Enter") void searchMarket(); }} /><button type="button" onClick={() => void searchMarket()} disabled={busy}><Search size={14} />搜索</button></div><div className="skill-list market">{market.map(card => <article key={`${card.ownerHandle}:${card.slug}`}><div><b>{card.displayName}</b><small>{card.latestVersion || "latest"}</small></div><p>{card.summary}</p><span className="muted">{card.ownerHandle ? `@${card.ownerHandle} · ` : ""}{card.downloads ?? 0} 下载 · {card.stars ?? 0} 收藏</span><footer><button className="primary" type="button" onClick={() => void installMarket(card)} disabled={busy}><Download size={13} />安装到{scope === "workspace" ? "工作区" : "全局"}</button></footer></article>)}</div></>}
    {tab === "install" && <div className="skill-form"><label>安装作用域<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="global">全局</option>{workspaceRoot && <option value="workspace">当前工作区</option>}</select></label><label>Skill ZIP 包<div><input value={source} onChange={e => setSource(e.target.value)} placeholder="选择 .zip 文件" /><button type="button" onClick={browseSource}><Archive size={13} /></button></div></label><button type="button" className="primary" disabled={!source || busy} onClick={() => void act(() => installSkill({ scope, workspaceRoot, source }), "Skill 安装完成")}><Download size={14} />安装并校验</button></div>}
    {tab === "create" && <div className="skill-form"><label>作用域<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="global">全局</option>{workspaceRoot && <option value="workspace">当前工作区</option>}</select></label><label>名称<input value={newName} onChange={e => setNewName(e.target.value)} placeholder="my-skill" /></label><label>描述<textarea value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="说明何时使用这个 Skill" /></label><button className="primary" type="button" disabled={!newName.trim() || !newDescription.trim() || busy} onClick={() => void act(() => createSkill({ scope, workspaceRoot, name: newName, description: newDescription }), "Skill 已创建")}><Plus size={14} />创建 SKILL.md</button></div>}
    {tab === "runtime" && <div className="runtime-list">{runtime.map(item => <div key={item.name} className={item.available ? "available" : "missing"}>{item.available ? <CheckCircle2 size={16} /> : <XCircle size={16} />}<span><b>{item.name}</b><small>{item.available ? item.path : item.installHint}</small></span></div>)}<button type="button" onClick={() => void act(() => checkSkillUpdates(workspaceRoot), "已完成技能更新检查")} disabled={busy}><RefreshCw size={13} />检查技能更新</button></div>}
  </div>;
}
