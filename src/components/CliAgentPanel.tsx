import { useMemo, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Play, TerminalSquare, X } from "lucide-react";
import { agentTools, buildAgentCommand, defaultAgentPrompt, withAgentContext, type AgentToolId } from "../agent/presets";
import { isDesktop } from "../services/runtime";
import { openWorkspacePowerShell, runCommandStream } from "../services/system";
import type { DocumentBlock, Project } from "../core/types";
import { ContextReferences } from "./ContextReferences";

export function CliAgentPanel({ project, block, context, contextLabels, toolId, onToolChange, updateBlock, notify }: {
  project: Project;
  block: DocumentBlock;
  context: string[];
  contextLabels: string[];
  toolId: AgentToolId;
  onToolChange: (toolId: AgentToolId) => void;
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  notify: (message: string) => void;
}) {
  const tool = useMemo(() => agentTools.find(item => item.id === toolId) ?? agentTools[1], [toolId]);
  const [task, setTask] = useState("请结合已引用资料，优化当前章节的完整性、术语一致性和可实施性。");
  const [output, setOutput] = useState("");
  const [errorOutput, setErrorOutput] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);

  const run = async () => {
    if (!task.trim()) return notify("请先填写任务目标");
    const prompt = withAgentContext(`${defaultAgentPrompt(project, block)}\n\n本次任务：${task.trim()}`, context, true);
    const command = buildAgentCommand(tool, prompt, project.workspace?.root || ".");
    setOutput(""); setErrorOutput(""); setDraft(null); setRunning(true);
    try {
      const chunks: string[] = [];
      const result = await runCommandStream(command, (channel, content) => {
        if (channel === "stdout") {
          chunks.push(content);
          setOutput(current => current + content);
        } else setErrorOutput(current => current + content);
      });
      const next = (result.stdout || chunks.join("")).trim();
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${tool.name} 退出码 ${result.exitCode}`);
      if (!next) throw new Error(`${tool.name} 未返回可用内容`);
      setDraft(next.replace(/^```(?:markdown)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim());
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "CLI Agent 执行失败");
    } finally { setRunning(false); }
  };

  const openCliShell = async () => {
    if (!project.workspace?.root) return notify("请先配置工作区");
    try {
      await openWorkspacePowerShell(project.workspace.root, tool.program);
      notify(`已在工作区 PowerShell 启动 ${tool.name}`);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "打开 PowerShell 失败");
    }
  };

  return <div className="cli-agent-panel">
    <div className="cli-engine-picker">
      <span className="cli-engine-label">执行引擎</span>
      <button type="button" className="cli-engine-trigger" aria-haspopup="listbox" aria-expanded={toolMenuOpen} onClick={() => setToolMenuOpen(current => !current)} disabled={running}>
        <span><TerminalSquare size={15} /><b>{tool.name}</b><small>{tool.description}</small></span>
        <ChevronDown size={15} />
      </button>
      {toolMenuOpen && <div className="cli-engine-menu" role="listbox" aria-label="选择 CLI Agent">
        {agentTools.map(item => <button type="button" role="option" aria-selected={item.id === toolId} className={item.id === toolId ? "active" : ""} key={item.id} onClick={() => { onToolChange(item.id); setToolMenuOpen(false); }}>
          <span><b>{item.name}</b><small>{item.description}</small></span>
          {item.id === toolId && <Check size={14} />}
        </button>)}
      </div>}
    </div>
    <ContextReferences labels={contextLabels} />
    {!isDesktop() && <div className="cli-agent-notice"><TerminalSquare size={15} /><span>CLI Agent 仅在桌面端可用</span></div>}
    <label className="agent-task-input">任务目标<textarea value={task} onChange={event => setTask(event.target.value)} disabled={running} /></label>
    <div className="agent-run-actions">
      <button type="button" className="cli-powershell-button" disabled={running || !isDesktop() || !project.workspace?.root} title={`在工作区 PowerShell 中启动 ${tool.name}`} onClick={() => void openCliShell()}><TerminalSquare size={14} />PowerShell</button>
      <button type="button" className="primary" disabled={running || !isDesktop()} onClick={() => void run()}>{running ? <><LoaderCircle className="spinning" size={14} />执行中</> : <><Play size={14} />开始执行</>}</button>
    </div>
    {(output || errorOutput) && <section className="cli-agent-output"><header><span>实时输出</span><b>{output.length.toLocaleString()} 字符</b></header><pre>{output || errorOutput}</pre></section>}
    {draft && <section className="agent-draft"><header><div><TerminalSquare size={15} /><span>CLI 修改待确认</span></div><button type="button" title="关闭" onClick={() => setDraft(null)}><X size={13} /></button></header><pre>{draft}</pre><div><button type="button" onClick={() => setDraft(null)}>拒绝</button><button type="button" className="primary" onClick={() => { updateBlock(current => ({ ...current, content: draft })); setDraft(null); notify("CLI Agent 修改已应用到当前章节"); }}><Check size={13} />接受修改</button></div></section>}
  </div>;
}
