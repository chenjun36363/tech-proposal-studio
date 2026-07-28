import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Bot, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { makeId } from "../../data";
import { improveBlockStream } from "../../services/model";
import type { AiDraft, DocumentBlock, Project, SelectedModel, SessionEvent } from "../../types";
import { resolveActiveModelConfig, tryResolveActiveModelConfig } from "../../services/llm/resolve";
import { ModelSelect } from "../../components/ModelSelect";

function SessionTrace({ events, running }: { events: SessionEvent[]; running: boolean }) {
  const output = events.filter(event => event.kind === "output").map(event => event.content ?? "").join("");
  const steps = events.filter(event => event.kind !== "output");
  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output]);
  if (!events.length) return null;
  return <section className={`session-trace ${running ? "running" : ""}`} aria-live="polite">
    <header><span><Bot size={14} />章节优化会话</span><em>{running ? <><RefreshCw className="spinning" size={12} />实时连接</> : "已结束"}</em></header>
    <div className="session-steps">{steps.map(event => <div className={`session-step ${event.kind}`} key={event.id}>
      <i>{event.kind === "done" ? <Check size={11} /> : event.kind === "error" ? <X size={11} /> : <span />}</i>
      <div><b>{event.label}</b>{event.content && <small>{event.content}</small>}</div>
    </div>)}</div>
    {(output || running) && <div className="session-output"><div><span>实时返回</span><b>{output.length.toLocaleString()} 字符</b></div><pre ref={outputRef}>{output || "等待首个响应片段…"}<span className="stream-caret" /></pre></div>}
  </section>;
}

const createEvent = (kind: SessionEvent["kind"], label: string, content?: string): SessionEvent => ({ id: makeId(), kind, label, content, at: Date.now() });
const appendOutput = (setter: Dispatch<SetStateAction<SessionEvent[]>>, content: string) => setter(current => {
  const last = current.at(-1);
  if (last?.kind === "output" && last.channel === "stdout") return [...current.slice(0, -1), { ...last, content: `${last.content ?? ""}${content}` }];
  return [...current, { ...createEvent("output", "模型输出", content), channel: "stdout" }];
});

export function AiRewritePanel({ project, block, context, updateBlock, notify, openSettings }: {
  project: Project;
  block: DocumentBlock;
  context: string[];
  updateBlock: (updater: (block: DocumentBlock) => DocumentBlock) => void;
  notify: (message: string) => void;
  openSettings: () => void;
}) {
  const [instruction, setInstruction] = useState("请结合上下文参考内容，帮我优化当前章节");
  const [useContext, setUseContext] = useState(true);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(project.selectedModel ?? null);
  const aiEnabled = project.model?.enabled !== false;

  const resolved = tryResolveActiveModelConfig(project.providers ?? [], selectedModel, { aiEnabled });
  const modelLabel = resolved ? `${resolved.providerName} / ${resolved.model}` : (project.model?.model || "未选择模型");

  const run = async () => {
    let config;
    try {
      config = resolveActiveModelConfig(project.providers ?? [], selectedModel, { aiEnabled });
    } catch (e: any) {
      notify(e?.message ?? "模型未配置");
      openSettings();
      return;
    }
    setLoading(true); setDraft(null);
    setEvents([createEvent("status", "建立当前会话", `${config.model} · ${useContext ? `${context.length} 条上下文` : "仅当前章节"}`), createEvent("tool", "发送章节与编辑要求")]);
    try {
      const result = await improveBlockStream(block, instruction, useContext ? context : [], config, chunk => appendOutput(setEvents, chunk));
      setDraft(result);
      setEvents(current => [...current, createEvent("done", "生成完成", `${result.after.length.toLocaleString()} 字符，等待确认`)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型会话中断";
      setEvents(current => [...current, createEvent("error", "会话中断", message)]);
      notify(message);
    } finally { setLoading(false); }
  };

  return <div className="inspector-content">
    <div className="context-line"><span><Bot size={17} />{modelLabel}</span><button onClick={openSettings}>配置</button></div>
    <label className="wide">模型
      <ModelSelect providers={project.providers ?? []} value={selectedModel} onChange={setSelectedModel} disabled={!aiEnabled} />
    </label>
    {!aiEnabled && <small className="model-list-error">联网模型已关闭，请先在设置中启用。</small>}
    <label>编辑要求<textarea value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
    <label className="context-box context-send-toggle"><span><input type="checkbox" checked={useContext} onChange={event => setUseContext(event.target.checked)} />发送上下文</span><b>{useContext ? `${context.length} 条引用 + 当前章节` : "仅当前章节"}</b></label>
    <button className="primary" onClick={() => void run()} disabled={loading}>{loading ? "正在生成…" : <><Sparkles size={16} />优化当前章节</>}</button>
    <SessionTrace events={events} running={loading} />
    {draft && <div className="diff"><div className="diff-title"><span>修改建议</span><button onClick={() => setDraft(null)}><X size={14} /></button></div><div className="removed">{draft.before || "（空内容）"}</div><div className="added">{draft.after}</div><div className="diff-actions"><button onClick={() => setDraft(null)}>拒绝</button><button onClick={() => { updateBlock(current => ({ ...current, content: draft.after })); setDraft(null); notify("修改已应用"); }}><Check size={14} />接受修改</button></div></div>}
  </div>;
}
