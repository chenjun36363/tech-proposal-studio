import { useMemo, useRef, useState } from "react";
import { Bot, Check, Circle, FileSearch, ListChecks, LoaderCircle, Play, Search, Square, Wrench, X } from "lucide-react";
import { createProposalToolRegistry, proposalAgentSystemPrompt } from "../agent/proposalTools";
import type { AgentDraft, AgentEvent } from "../agent/protocol";
import { runProposalAgent } from "../agent/runner";
import type { DocumentBlock, Project } from "../types";

type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string };

const TOOL_LABELS: Record<string, string> = {
  read_current_section: "读取当前章节",
  get_proposal_outline: "读取方案目录",
  web_search: "联网搜索",
  read_web_page: "阅读网页",
  write_todo: "更新执行计划",
  propose_section_update: "提交章节修改",
};

function summarizeArguments(name: string, args: Record<string, unknown>) {
  if (name === "propose_section_update") return String(args.instruction ?? "");
  if (name === "write_todo" && Array.isArray(args.todos)) return `${args.todos.length} 项`;
  return "";
}

function AgentTimeline({ events, running }: { events: AgentEvent[]; running: boolean }) {
  const visible = events.filter(event => event.type !== "tool_call" && event.type !== "run_started");
  if (!visible.length) return <div className="agent-empty"><Bot size={22} /><b>等待任务</b><span>Agent 的读取、检索和修改步骤会显示在这里</span></div>;
  return <div className="agent-timeline" aria-live="polite">
    {visible.map(event => {
      if (event.type === "round_started") return <div className="agent-round" key={event.id}><span>ROUND {String(event.round).padStart(2, "0")}</span></div>;
      if (event.type === "tool_started") return null;
      if (event.type === "tool_result") return <article className={`agent-tool-card ${event.result.isError ? "error" : "done"}`} key={event.id}>
        <i>{event.result.isError ? <X size={12} /> : <Check size={12} />}</i>
        <div><b>{TOOL_LABELS[event.call.name] ?? event.call.name}</b><span>{summarizeArguments(event.call.name, event.call.arguments) || event.result.content.slice(0, 90)}</span></div>
        <Wrench size={13} />
      </article>;
      if (event.type === "text") return <div className="agent-note" key={event.id}><Bot size={14} /><p>{event.content}</p></div>;
      if (event.type === "run_completed") return <div className="agent-finish" key={event.id}><Check size={13} /><span>任务完成</span></div>;
      if (event.type === "run_failed") return <div className="agent-finish error" key={event.id}><X size={13} /><span>{event.error}</span></div>;
      if (event.type === "run_cancelled") return <div className="agent-finish cancelled" key={event.id}><Square size={11} /><span>任务已停止</span></div>;
      return null;
    })}
    {running && <div className="agent-working"><LoaderCircle className="spinning" size={13} /><span>Agent 正在决定下一步</span></div>}
  </div>;
}

export function AgentTaskPanel({ project, block, sourceContents, updateBlock, notify }: {
  project: Project;
  block: DocumentBlock;
  sourceContents: Record<string, string>;
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  notify: (message: string) => void;
}) {
  const [task, setTask] = useState("分析当前章节，结合项目资料补全关键设计，并提交一版可审阅的修改稿。");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const completedTodos = useMemo(() => todos.filter(item => item.status === "completed").length, [todos]);

  const run = async () => {
    if (!task.trim()) return notify("请先填写任务目标");
    if (!project.model.enabled) return notify("请先启用模型连接");
    const controller = new AbortController();
    abortRef.current = controller;
    setEvents([]); setDraft(null); setTodos([]); setRunning(true);
    const registry = createProposalToolRegistry({ project, block, sourceContents, onDraft: setDraft, onTodos: setTodos });
    registry.unregister("web_search").unregister("read_web_page");
    try {
      await runProposalAgent({ task: task.trim(), systemPrompt: proposalAgentSystemPrompt, config: project.model, registry, signal: controller.signal, onEvent: event => setEvents(current => [...current, event]), firstRoundToolName: "write_todo" });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) notify(error instanceof Error ? error.message : "Agent 执行失败");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  return <div className="inspector-content proposal-agent-panel">
    <div className="agent-panel-head">
      <div><span className="agent-status-dot" data-running={running} /><div><b>方案 Agent</b><small>{project.model.model || "未选择模型"}</small></div></div>
      <span>{project.sources.length} 份资料</span>
    </div>
    <label className="agent-task-input">任务目标<textarea value={task} onChange={event => setTask(event.target.value)} disabled={running} spellCheck={false} /></label>
    <div className="agent-run-actions">
      <button type="button" onClick={() => setTask("检查当前章节的完整性、术语一致性和可实施性，并提交改进稿。")} disabled={running}>质量检查</button>
      {running
        ? <button type="button" className="agent-stop" onClick={() => abortRef.current?.abort()}><Square size={13} />停止</button>
        : <button type="button" className="primary" onClick={() => void run()}><Play size={14} />开始执行</button>}
    </div>
    {todos.length > 0 && <section className="agent-todos">
      <header><span><ListChecks size={14} />执行计划</span><b>{completedTodos}/{todos.length}</b></header>
      {todos.map((todo, index) => <div key={`${index}-${todo.content}`} className={todo.status}>
        {todo.status === "completed" ? <Check size={12} /> : todo.status === "in_progress" ? <LoaderCircle className="spinning" size={12} /> : <Circle size={11} />}
        <span>{todo.status === "in_progress" ? todo.activeForm : todo.content}</span>
      </div>)}
    </section>}
    <AgentTimeline events={events} running={running} />
    {draft && <section className="agent-draft">
      <header><div><FileSearch size={15} /><span>章节修改待确认</span></div><small>{draft.instruction}</small></header>
      <div className="agent-diff-stats"><span className="removed">原文 {draft.before.length.toLocaleString()} 字</span><span className="added">修改后 {draft.after.length.toLocaleString()} 字</span></div>
      <details><summary><Search size={12} />查看完整修改稿</summary><pre>{draft.after}</pre></details>
      <div><button type="button" onClick={() => setDraft(null)}>拒绝</button><button type="button" className="primary" onClick={() => { updateBlock(current => ({ ...current, content: draft.after })); setDraft(null); notify("Agent 修改已应用到当前章节"); }}><Check size={13} />接受修改</button></div>
    </section>}
  </div>;
}
