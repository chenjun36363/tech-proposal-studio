import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArchiveRestore, ArrowDownToLine, ArrowUpFromLine, Check, CloudDownload, GitBranch, GitCommitHorizontal, History, ListTree, LoaderCircle, Minus, Plus, RefreshCw, Settings2, Sparkles, Trash2 } from "lucide-react";
import { commitGitChanges, createGitBranch, discardGitFile, fetchGitRepository, getGitBranches, getGitCommitDiff, getGitDiff, getGitLog, getGitStagedSummary, getGitStatus, initGitRepository, popGitStash, pullGitRepository, pushGitRepository, setGitRemote, stageAllGitFiles, stageGitFile, stashGitChanges, switchGitBranch, unstageAllGitFiles, unstageGitFile, type GitBranchInfo, type GitCommitSummary, type GitFileStatus, type GitRepositoryStatus } from "../../services/git";
import type { Project } from "../../types";
import { generateCommitMessage } from "./commitMessage";
import { AGENT_GIT_CHANGED } from "../../agent/gitTools";

export type GitDiffSelection = { kind: "working"; path: string; staged: boolean } | { kind: "commit"; commit: string; title: string };

const emptyStatus: GitRepositoryStatus = { isRepository: false, branch: "", upstream: null, ahead: 0, behind: 0, stashCount: 0, remoteUrl: null, files: [] };

function statusLabel(code: string) {
  return ({ M: "M", A: "A", D: "D", R: "R", C: "C", U: "U", "?": "U" } as Record<string, string>)[code] ?? code;
}

export function getGitStatusCounts(files: GitFileStatus[]) {
  return files.reduce((counts, file) => {
    const untracked = file.indexStatus === "?" || file.worktreeStatus === "?";
    if (untracked) counts.untracked += 1;
    else {
      if (file.indexStatus !== ".") counts.staged += 1;
      if (file.worktreeStatus !== ".") counts.unstaged += 1;
    }
    return counts;
  }, { staged: 0, unstaged: 0, untracked: 0 });
}

function ChangeList({ title, files, staged, selected, onSelect, onToggle, onBulkAction, bulkActionLabel, onDiscard, pendingDiscard }: {
  title: string; files: GitFileStatus[]; staged: boolean; selected: GitDiffSelection | null;
  onSelect: (selection: GitDiffSelection) => void; onToggle: (file: GitFileStatus) => void;
  onBulkAction: () => void; bulkActionLabel: string; onDiscard?: (file: GitFileStatus) => void; pendingDiscard?: string | null;
}) {
  if (!files.length) return null;
  return <section className="git-change-group">
    <div className="git-change-heading">
      <span>{title}</span>
      <button className="git-bulk-action" type="button" onClick={onBulkAction}>{bulkActionLabel}</button>
      <b>{files.length}</b>
    </div>
    {files.map(file => {
      const code = staged ? file.indexStatus : file.worktreeStatus;
      const active = selected?.kind === "working" && selected.path === file.path && selected.staged === staged;
      return <div className={`git-change-row ${staged ? "staged" : "unstaged"} ${active ? "selected" : ""}`} key={`${staged}-${file.path}`}>
        <button className="git-file-button" type="button" title={file.path} onClick={() => onSelect({ kind: "working", path: file.path, staged })}>
          <span>{file.path.split("/").pop()}</span><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "工作区根目录"}</small>
        </button>
        <span className={`git-status-code status-${statusLabel(code).toLowerCase()}`}>{statusLabel(code)}</span>
        <button className="git-stage-button" type="button" title={staged ? "取消暂存" : "暂存更改"} onClick={() => onToggle(file)}>
          {staged ? <Minus size={14} /> : <Plus size={14} />}
        </button>
        {!staged && onDiscard && <button className={`git-stage-button discard ${pendingDiscard === file.path ? "confirm" : ""}`} type="button" title={pendingDiscard === file.path ? "再次点击确认丢弃" : "丢弃此文件的修改"} onClick={() => onDiscard(file)}><Trash2 size={13} /></button>}
      </div>;
    })}
  </section>;
}

export function GitSidebar({ root, project, selected, onSelect, notify }: { root: string; project: Project; selected: GitDiffSelection | null; onSelect: (selection: GitDiffSelection | null) => void; notify: (message: string) => void }) {
  const [status, setStatus] = useState<GitRepositoryStatus>(emptyStatus);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [operation, setOperation] = useState<"fetch" | "pull" | "push" | "remote" | "branch" | "stash" | null>(null);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [view, setView] = useState<"changes" | "history">("changes");
  const [history, setHistory] = useState<GitCommitSummary[]>([]);
  const [pendingDiscard, setPendingDiscard] = useState<string | null>(null);
  const [generatingMessage, setGeneratingMessage] = useState(false);

  const refresh = useCallback(async () => {
    if (!root) return;
    setLoading(true); setError("");
    try { setStatus(await getGitStatus(root)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [root]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const refreshAgentChange = (event: Event) => {
      const changedRoot = (event as CustomEvent<{ root?: string }>).detail?.root;
      if (!changedRoot || changedRoot === root) void refresh();
    };
    const timer = window.setInterval(refreshVisible, 5000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener(AGENT_GIT_CHANGED, refreshAgentChange);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshVisible); window.removeEventListener(AGENT_GIT_CHANGED, refreshAgentChange); };
  }, [refresh]);
  useEffect(() => {
    if (view !== "history" || !status.isRepository) return;
    void getGitLog(root).then(setHistory).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [root, status.branch, status.isRepository, view]);
  const counts = useMemo(() => getGitStatusCounts(status.files), [status.files]);
  const staged = useMemo(() => status.files.filter(file => file.indexStatus !== "." && file.indexStatus !== "?"), [status.files]);
  const changed = useMemo(() => status.files.filter(file => file.worktreeStatus !== "."), [status.files]);

  const toggle = async (file: GitFileStatus, isStaged: boolean) => {
    try {
      if (isStaged) await unstageGitFile(root, file.path); else await stageGitFile(root, file.path);
      onSelect(null); await refresh();
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
  };
  const commit = async () => {
    try { await commitGitChanges(root, message); setMessage(""); onSelect(null); await refresh(); notify("Git 提交已创建"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
  };
  const generateMessage = async () => {
    setGeneratingMessage(true);
    try {
      const summary = await getGitStagedSummary(root);
      setMessage(await generateCommitMessage(project, summary));
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setGeneratingMessage(false); }
  };
  const runRemoteOperation = async (kind: "pull" | "push") => {
    setOperation(kind);
    try {
      if (kind === "pull") await pullGitRepository(root); else await pushGitRepository(root);
      await refresh(); notify(kind === "pull" ? "已从远程仓库拉取" : "已推送到远程仓库");
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const fetchRemote = async () => {
    setOperation("fetch");
    try { await fetchGitRepository(root); await refresh(); notify("已获取远程更新"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const openBranches = async () => {
    setBranchOpen(true); setOperation("branch");
    try { setBranches(await getGitBranches(root)); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const switchBranch = async (branch: GitBranchInfo) => {
    if (branch.current) { setBranchOpen(false); return; }
    setOperation("branch");
    try { await switchGitBranch(root, branch); setBranchOpen(false); onSelect(null); await refresh(); notify(`已切换到 ${branch.name}`); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const createBranch = async () => {
    setOperation("branch");
    try { await createGitBranch(root, newBranch); setNewBranch(""); setBranchOpen(false); onSelect(null); await refresh(); notify("分支已创建并切换"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const runStash = async (pop: boolean) => {
    setOperation("stash");
    try { if (pop) await popGitStash(root); else await stashGitChanges(root); onSelect(null); await refresh(); notify(pop ? "已恢复最近的 stash" : "更改已保存到 stash"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const saveRemote = async () => {
    setOperation("remote");
    try { await setGitRemote(root, remoteUrl); setRemoteOpen(false); await refresh(); notify("origin 远程仓库已保存"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
    finally { setOperation(null); }
  };
  const bulkStage = async (unstage: boolean) => {
    try { if (unstage) await unstageAllGitFiles(root); else await stageAllGitFiles(root); onSelect(null); await refresh(); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
  };
  const discard = async (file: GitFileStatus) => {
    if (pendingDiscard !== file.path) { setPendingDiscard(file.path); window.setTimeout(() => setPendingDiscard(current => current === file.path ? null : current), 3000); return; }
    try { await discardGitFile(root, file.path, file.worktreeStatus === "?"); setPendingDiscard(null); onSelect(null); await refresh(); notify("已丢弃文件修改"); }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
  };

  if (!root) return <div className="git-empty">请先在设置中选择工作目录。</div>;
  if (!status.isRepository && !loading) return <div className="git-empty">
    <GitBranch size={24} /><b>尚未启用 Git</b><span>在当前工作目录创建本地仓库。</span>
    <button className="primary" type="button" onClick={async () => { try { await initGitRepository(root); await refresh(); notify("Git 仓库已初始化"); } catch (reason) { notify(String(reason)); } }}>初始化仓库</button>
    {error && <small className="git-error">{error}</small>}
  </div>;

  return <div className="git-sidebar">
    <div className="git-repo-summary">
      <button className="git-branch-trigger" type="button" title="切换或新建分支" disabled={operation !== null} onClick={() => void openBranches()}><GitBranch size={14} /><strong>{status.branch || "HEAD"}</strong></button>
      <button type="button" disabled={!status.remoteUrl || operation !== null} title="拉取（仅快进）" onClick={() => void runRemoteOperation("pull")}><ArrowDownToLine size={14} /></button>
      <button type="button" disabled={!status.remoteUrl || operation !== null} title="推送" onClick={() => void runRemoteOperation("push")}><ArrowUpFromLine size={14} /></button>
      <button type="button" disabled={!status.remoteUrl || operation !== null} title="获取远程更新" onClick={() => void fetchRemote()}>{operation === "fetch" ? <LoaderCircle className="spinning" size={14} /> : <CloudDownload size={14} />}</button>
      <button type="button" disabled={operation !== null || (!status.files.length && status.stashCount === 0)} title={status.files.length ? "保存全部更改到 stash" : `恢复最近的 stash（共 ${status.stashCount} 个）`} onClick={() => void runStash(!status.files.length)}><ArchiveRestore size={14} />{status.stashCount > 0 && <i>{status.stashCount}</i>}</button>
      <button type="button" title="设置远程仓库" onClick={() => { setRemoteUrl(status.remoteUrl ?? ""); setRemoteOpen(true); }}><Settings2 size={14} /></button>
      <button type="button" title="刷新 Git 状态" onClick={() => void refresh()}>{loading ? <LoaderCircle className="spinning" size={14} /> : <RefreshCw size={14} />}</button>
    </div>
    <section className="git-status-summary" aria-label="Git 状态摘要">
      <div className="git-status-base"><span>基线</span><CloudDownload size={12} /><code title={status.upstream ?? "未设置上游分支"}>{status.upstream ?? "未设置上游"}</code></div>
      <div className="git-status-metrics">
        {[
          { label: "领先", value: status.ahead, tone: "ahead" },
          { label: "落后", value: status.behind, tone: "behind" },
          { label: "已暂存", value: counts.staged, tone: "staged" },
          { label: "未暂存", value: counts.unstaged, tone: "unstaged" },
          { label: "未跟踪", value: counts.untracked, tone: "untracked" },
        ].map(item => <div className={`git-status-metric ${item.value > 0 ? item.tone : "empty"}`} key={item.label}><b>{item.value}</b><span>{item.label}</span></div>)}
      </div>
    </section>
    <div className="git-view-tabs"><button className={view === "changes" ? "active" : ""} onClick={() => setView("changes")}><ListTree size={13} />更改</button><button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={13} />历史</button></div>
    {view === "changes" ? <><div className="git-commit-box">
      <textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="提交说明" rows={2} />
      <div className="git-commit-actions">
        <button className="git-generate-message" type="button" disabled={!staged.length || generatingMessage} title="使用 AI 生成提交说明" aria-label="使用 AI 生成提交说明" onClick={() => void generateMessage()}>{generatingMessage ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />}</button>
        <button type="button" disabled={!message.trim() || !staged.length || generatingMessage} title="提交暂存的更改" onClick={() => void commit()}><GitCommitHorizontal size={14} />提交</button>
      </div>
    </div>
    <div className="git-changes-scroll">
      {!status.files.length && <div className="git-clean"><Check size={18} /><span>工作区没有更改</span></div>}
      <ChangeList title="暂存的更改" files={staged} staged selected={selected} onSelect={onSelect} onToggle={file => void toggle(file, true)} onBulkAction={() => void bulkStage(true)} bulkActionLabel="全部取消暂存" />
      <ChangeList title="更改" files={changed} staged={false} selected={selected} onSelect={onSelect} onToggle={file => void toggle(file, false)} onBulkAction={() => void bulkStage(false)} bulkActionLabel="全部暂存" onDiscard={file => void discard(file)} pendingDiscard={pendingDiscard} />
    </div></> : <div className="git-history-list">
      {!history.length && <div className="git-clean"><History size={18} /><span>暂无提交历史</span></div>}
      {history.map(item => <button type="button" className={selected?.kind === "commit" && selected.commit === item.hash ? "selected" : ""} key={item.hash} onClick={() => onSelect({ kind: "commit", commit: item.hash, title: item.subject })}>
        <span><b>{item.subject}</b>{item.refs.slice(0, 2).map(ref => <em key={ref}>{ref}</em>)}</span><small><code>{item.shortHash}</code>{item.author} · {new Date(item.authoredAt).toLocaleDateString("zh-CN")}</small>
      </button>)}
    </div>}
    {error && <div className="git-error">{error}</div>}
    {remoteOpen && createPortal(<div className="git-remote-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setRemoteOpen(false); }}>
      <section className="git-remote-dialog" role="dialog" aria-modal="true" aria-labelledby="git-remote-title">
        <header><GitBranch size={17} /><div><b id="git-remote-title">远程仓库</b><span>配置当前工作区的 origin</span></div></header>
        <label><span>仓库地址</span><input autoFocus value={remoteUrl} onChange={event => setRemoteUrl(event.target.value)} placeholder="https://host/owner/repository.git" /></label>
        <p>认证由系统 Git 凭据管理器处理，请勿在地址中填写密码。</p>
        <footer><button type="button" onClick={() => setRemoteOpen(false)}>取消</button><button className="primary" type="button" disabled={!remoteUrl.trim() || operation !== null} onClick={() => void saveRemote()}>{operation === "remote" ? "保存中…" : "保存 origin"}</button></footer>
      </section>
    </div>, document.body)}
    {branchOpen && createPortal(<div className="git-remote-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && operation !== "branch") setBranchOpen(false); }}>
      <section className="git-remote-dialog git-branch-dialog" role="dialog" aria-modal="true" aria-labelledby="git-branch-title">
        <header><GitBranch size={17} /><div><b id="git-branch-title">分支</b><span>切换本地或远程分支</span></div></header>
        <div className="git-branch-list">
          {branches.map(branch => <button type="button" className={branch.current ? "current" : ""} disabled={operation === "branch"} key={`${branch.kind}:${branch.name}`} onClick={() => void switchBranch(branch)}><span>{branch.name}</span><small>{branch.kind === "remote" ? "远程" : branch.current ? "当前" : "本地"}</small>{branch.current && <Check size={13} />}</button>)}
          {!branches.length && <span className="git-branch-empty">没有可用分支</span>}
        </div>
        <form className="git-branch-create" onSubmit={event => { event.preventDefault(); if (newBranch.trim()) void createBranch(); }}><input value={newBranch} onChange={event => setNewBranch(event.target.value)} placeholder="新分支名称" /><button className="primary" type="submit" disabled={!newBranch.trim() || operation === "branch"}><Plus size={13} />新建</button></form>
        <footer><button type="button" disabled={operation === "branch"} onClick={() => setBranchOpen(false)}>关闭</button></footer>
      </section>
    </div>, document.body)}
  </div>;
}

export interface DiffLine { kind: "meta" | "hunk" | "add" | "delete" | "context"; text: string; oldLine: number | null; newLine: number | null }

export function parseUnifiedDiff(patch: string): DiffLine[] {
  let oldLine = 0; let newLine = 0;
  return patch.split("\n").map(text => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); return { kind: "hunk", text, oldLine: null, newLine: null }; }
    if (text.startsWith("+") && !text.startsWith("+++")) return { kind: "add", text, oldLine: null, newLine: newLine++ };
    if (text.startsWith("-") && !text.startsWith("---")) return { kind: "delete", text, oldLine: oldLine++, newLine: null };
    if (text.startsWith(" ")) return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
    return { kind: "meta", text, oldLine: null, newLine: null };
  });
}

export function GitDiffView({ root, selection }: { root: string; selection: GitDiffSelection }) {
  const [patch, setPatch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true; setLoading(true); setError("");
    const request = selection.kind === "commit" ? getGitCommitDiff(root, selection.commit) : getGitDiff(root, selection.path, selection.staged);
    void request.then(result => { if (current) setPatch(result.patch); }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [root, selection]);
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (loading) return <div className="git-diff-state"><LoaderCircle className="spinning" size={20} />正在读取 diff…</div>;
  if (error) return <div className="git-diff-state error">{error}</div>;
  if (!patch.trim()) return <div className="git-diff-state">没有可显示的文本差异。</div>;
  return <div className="git-diff-surface">
    <div className="git-diff-view" role="table" aria-label={`${selection.kind === "commit" ? selection.commit : selection.path} Git diff`}>
    {lines.map((line, index) => <div className={`git-diff-line ${line.kind}`} role="row" key={index}>
      <span className="old-number">{line.oldLine ?? ""}</span><span className="new-number">{line.newLine ?? ""}</span><code>{line.text || " "}</code>
    </div>)}
    </div>
  </div>;
}
