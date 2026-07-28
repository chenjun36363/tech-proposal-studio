import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, BookOpen, Check, ChevronRight, Circle, Copy, ExternalLink, FilePenLine, ListChecks, LoaderCircle, Search, UserRound, X } from "lucide-react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import markedKatex from "marked-katex-extension";
import { markedHighlight } from "marked-highlight";
import type { AgentEvent, AgentMessage, AgentToolCall } from "../agent/protocol";

const agentMarked = new Marked({ gfm: true, breaks: true });
Object.entries({ bash, css, html: xml, javascript, js: javascript, json, markdown, md: markdown, rust, sql, typescript, ts: typescript }).forEach(([name, language]) => hljs.registerLanguage(name, language));
agentMarked.use({ renderer: { html: ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") } });
agentMarked.use(markedKatex({ throwOnError: false, nonStandard: true }));
agentMarked.use(markedHighlight({
  langPrefix: "hljs language-",
  highlight(code, language) {
    if (language === "mermaid" || language === "mmd") return code;
    return language && hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
  },
}));

function enhanceCodeBlocks(html: string) {
  return html.replace(/<pre><code(?: class="([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (_match, className = "", code = "") => {
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "text";
    const long = code.split("\n").length > 12;
    return `<div class="agent-code-block${long ? " collapsible" : ""}"><header><span>${language}</span><div><button type="button" data-agent-code-action="copy">复制</button>${long ? '<button type="button" data-agent-code-action="toggle">展开</button>' : ""}</div></header><pre><code class="${className}">${code}</code></pre></div>`;
  });
}

const TOOL_LABELS: Record<string, string> = {
  read_current_section: "读取当前章节",
  get_proposal_outline: "读取方案目录",
  web_search: "联网搜索",
  read_web_page: "阅读网页",
  search_knowledge: "检索知识库",
  read_knowledge: "阅读知识章节",
  search_memory: "检索项目记忆",
  read_memory: "读取项目记忆",
  remember_project_fact: "保存项目记忆",
  write_todo: "更新执行计划",
  propose_section_update: "提交章节修改",
};

function toolLabel(name: string) {
  return TOOL_LABELS[name] ?? name;
}

function resultPreview(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 100) || "工具未返回文本内容";
}

function AgentMarkdown({ content }: { content: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const rendered = enhanceCodeBlocks(agentMarked.parse(content) as string);
    return typeof window === "undefined" ? rendered : DOMPurify.sanitize(rendered, { ADD_ATTR: ["data-agent-code-action"] });
  }, [content]);

  useEffect(() => {
    let cancelled = false;
    const blocks = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".language-mermaid,.language-mmd") ?? []);
    if (!blocks.length) return;
    void import("mermaid").then(({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: document.documentElement.classList.contains("dark") ? "dark" : "default" });
      blocks.forEach((code, index) => {
        const container = code.closest<HTMLElement>(".agent-code-block");
        if (!container) return;
        void mermaid.render(`agent-mermaid-${Date.now()}-${index}`, code.textContent ?? "").then(({ svg }) => {
          if (!cancelled) { container.classList.add("mermaid-rendered"); container.innerHTML = `<div class="agent-mermaid-diagram">${svg}</div>`; }
        }).catch(() => undefined);
      });
    });
    return () => { cancelled = true; };
  }, [html]);

  return <div className="agent-message-markdown">
    <div
      ref={rootRef}
      className="md-preview"
      onClick={event => {
        const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-agent-code-action]");
        if (action) {
          const block = action.closest<HTMLElement>(".agent-code-block");
          if (action.dataset.agentCodeAction === "copy") {
            void navigator.clipboard.writeText(block?.querySelector("code")?.textContent ?? "");
            action.textContent = "已复制";
            window.setTimeout(() => { action.textContent = "复制"; }, 1200);
          } else if (block) {
            const expanded = block.classList.toggle("expanded");
            action.textContent = expanded ? "收起" : "展开";
          }
          return;
        }
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        if (window.confirm(`即将打开外部链接：\n${anchor.href}\n\n确认继续？`)) window.open(anchor.href, "_blank", "noopener,noreferrer");
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  </div>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function jsonValue(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function searchRows(data: unknown) {
  const container = record(data);
  return Array.isArray(data) ? data : container && Array.isArray(container.results) ? container.results : [];
}

const SEARCH_TOOLS = new Set(["web_search", "search_knowledge", "search_memory"]);
const MARKDOWN_RESULT_TOOLS = new Set(["read_current_section", "get_proposal_outline", "read_web_page", "read_knowledge", "read_memory"]);

function SearchResultDetail({ data }: { data: unknown }) {
  const rows = searchRows(data);
  if (!rows.length) return null;
  return <section className="agent-search-results">
    <header><span><Search size={12} />检索结果</span><b>{rows.length} 条</b></header>
    <div>{rows.map((value, index) => {
      const item = record(value) ?? {};
      const title = stringValue(item.title || item.document || item.heading) || `结果 ${index + 1}`;
      const subtitle = [stringValue(item.document), stringValue(item.heading)].filter(part => part && part !== title).join(" / ");
      const excerpt = stringValue(item.excerpt || item.content);
      const url = stringValue(item.url);
      return <article key={`${index}-${title}`}>
        <div><BookOpen size={11} /><span><b>{title}</b>{subtitle && <small>{subtitle}</small>}</span>{url && <ExternalLink size={10} />}</div>
        {excerpt && <p>{excerpt}</p>}
        {url && <a href={url} target="_blank" rel="noreferrer" title={url}>{url}</a>}
      </article>;
    })}</div>
  </section>;
}

function MemoryDetail({ data, fallback }: { data: unknown; fallback: string }) {
  const item = record(data);
  if (!item) return null;
  const title = stringValue(item.title);
  const content = stringValue(item.content);
  if (!title && !content) return null;
  return <section className="agent-memory-result">
    <header><span>{stringValue(item.memoryType || item.memory_type) || "memory"}</span><b>待审核</b></header>
    <strong>{title || "项目记忆"}</strong>
    <p>{content || fallback}</p>
  </section>;
}

function ChangeDetail({ data, call }: { data: unknown; call: AgentToolCall }) {
  const stats = record(data);
  const before = typeof stats?.beforeChars === "number" ? stats.beforeChars : null;
  const after = typeof stats?.afterChars === "number" ? stats.afterChars : null;
  const instruction = stringValue(stats?.instruction || call.arguments.instruction) || "优化当前章节";
  return <section className="agent-change-result">
    <div><FilePenLine size={13} /><span><b>修改稿已提交审核</b><small>{instruction}</small></span></div>
    {(before !== null || after !== null) && <p><span>原文 {before?.toLocaleString() ?? "-"} 字</span><span>修改后 {after?.toLocaleString() ?? "-"} 字</span></p>}
  </section>;
}

type PlanItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

function planItems(call: AgentToolCall): PlanItem[] {
  if (call.name !== "write_todo" || !Array.isArray(call.arguments.todos)) return [];
  const items = call.arguments.todos.filter((item): item is PlanItem => {
    if (!item || typeof item !== "object") return false;
    const todo = item as { content?: unknown; status?: unknown };
    return typeof todo.content === "string" && ["pending", "in_progress", "completed"].includes(String(todo.status));
  });
  return items;
}

function PlanDetail({ items }: { items: PlanItem[] }) {
  return <section className="agent-plan-detail">
    {items.map((item, index) => <div className={item.status} key={`${index}-${item.content}`}>
      <i>{item.status === "completed" ? <Check size={11} /> : item.status === "in_progress" ? <LoaderCircle className="spinning" size={11} /> : <Circle size={10} />}</i>
      <span>{item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}</span>
    </div>)}
  </section>;
}

function ToolStep({ call, content, data, pending = false, isError = false }: {
  call: AgentToolCall;
  content?: string;
  data?: unknown;
  pending?: boolean;
  isError?: boolean;
}) {
  const args = Object.keys(call.arguments).length ? JSON.stringify(call.arguments, null, 2) : "";
  const todos = planItems(call);
  const isTodo = call.name === "write_todo";
  const completedTodos = todos.filter(item => item.status === "completed").length;
  const [open, setOpen] = useState(false);
  const resultData = data ?? (content ? jsonValue(content) : undefined);
  const searchResult = SEARCH_TOOLS.has(call.name) && searchRows(resultData).length ? <SearchResultDetail data={resultData} /> : null;
  const memoryData = record(resultData);
  const memoryResult = call.name === "remember_project_fact" && (memoryData?.title || memoryData?.content) ? <MemoryDetail data={resultData} fallback={content ?? ""} /> : null;
  const changeResult = call.name === "propose_section_update" ? <ChangeDetail data={data} call={call} /> : null;
  const markdownResult = MARKDOWN_RESULT_TOOLS.has(call.name) && content ? <AgentMarkdown content={content} /> : null;
  const hasSpecialResult = Boolean(todos.length || searchResult || memoryResult || changeResult || markdownResult);
  return <details className={`agent-timeline-tool ${pending ? "pending" : isError ? "error" : "done"}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <i>{pending ? <LoaderCircle className="spinning" size={12} /> : isError ? <X size={12} /> : <Check size={12} />}</i>
      <div>
        <b>{isTodo ? <><ListChecks size={12} />执行计划</> : toolLabel(call.name)}</b>
        <span>{isTodo && todos.length ? `${completedTodos}/${todos.length} 已完成` : pending ? "正在执行" : resultPreview(content ?? "")}</span>
      </div>
      <ChevronRight size={12} />
    </summary>
    {!pending && <div className="agent-tool-detail">
      {todos.length > 0 ? <PlanDetail items={todos} /> : searchResult || memoryResult || changeResult || markdownResult || (args && <section><b>参数</b><pre>{args}</pre></section>)}
      {content && (isError || !hasSpecialResult) && <section><b>{isError ? "错误" : "返回"}</b><pre>{content}</pre></section>}
    </div>}
  </details>;
}

function MessageBubble({ role, content, showLabel = true }: { role: "user" | "assistant"; content: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return <article className={`agent-chat-message ${role}`}>
    {showLabel && (role === "user"
      ? <UserTurnLabel action={<button type="button" className="agent-message-copy" aria-label={copied ? "已复制消息" : "复制消息"} title={copied ? "已复制" : "复制消息"} onClick={() => void copyContent()}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>} />
      : <b>Agent</b>)}
    <div className="agent-message-body">
      {role === "assistant"
        ? <AgentMarkdown content={content} />
        : <p>{content}</p>}
    </div>
  </article>;
}

function UserTurnLabel({ action }: { action?: React.ReactNode }) {
  return <div className="agent-user-label">{action}<b>你</b><span><UserRound size={12} /></span></div>;
}

function AgentTurnLabel() {
  return <div className="agent-turn-label"><span><Bot size={12} /></span><b>Agent</b></div>;
}

function PersistedTimeline({ messages }: { messages: AgentMessage[] }) {
  const calls = new Map<string, AgentToolCall>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      calls.set(call.id, { id: call.id, name: call.function.name, arguments: args });
    }
  }
  return <>{messages.map((message, index) => {
    const previous = messages[index - 1];
    const startsAgentTurn = message.role !== "user" && (!previous || previous.role === "user");
    if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim()) {
      return <div className="agent-timeline-entry" key={`message-${index}`}>{startsAgentTurn && <AgentTurnLabel />}<MessageBubble role={message.role} content={message.content} showLabel={message.role === "user"} /></div>;
    }
    if (message.role === "tool" && message.tool_call_id) {
      const call = calls.get(message.tool_call_id) ?? { id: message.tool_call_id, name: "tool", arguments: {} };
      return <div className="agent-timeline-entry" key={`tool-${message.tool_call_id}-${index}`}>{startsAgentTurn && <AgentTurnLabel />}<ToolStep call={call} content={message.content ?? ""} data={message.tool_result_data} isError={message.tool_result_is_error} /></div>;
    }
    if (startsAgentTurn && message.role === "assistant" && message.tool_calls?.length) return <AgentTurnLabel key={`agent-${index}`} />;
    return null;
  })}</>;
}

function LiveTimeline({ events }: { events: AgentEvent[] }) {
  const completed = new Set(events.filter(event => event.type === "tool_result").map(event => event.type === "tool_result" ? event.call.id : ""));
  const visible = events.some(event => event.type === "text" || event.type === "tool_call" || event.type === "tool_result" || event.type === "context_compacted");
  return <>{visible && <AgentTurnLabel />}{events.map(event => {
    if (event.type === "context_compacted") return <div className="agent-context-compacted" key={event.id}>已自动压缩上下文：{event.beforeTokens.toLocaleString()} → {event.afterTokens.toLocaleString()} tokens</div>;
    if (event.type === "text") return <MessageBubble key={event.id} role="assistant" content={event.content} showLabel={false} />;
    if (event.type === "tool_call" && !completed.has(event.call.id)) return <ToolStep key={event.id} call={event.call} pending />;
    if (event.type === "tool_result") {
      return <ToolStep key={event.id} call={event.call} content={event.result.content} data={event.result.data} isError={event.result.isError} />;
    }
    return null;
  })}</>;
}

export function AgentConversationTimeline({ messages, events, running }: { messages: AgentMessage[]; events: AgentEvent[]; running: boolean }) {
  const hasHistory = messages.some(message => message.role === "user" || message.role === "assistant" || message.role === "tool");
  return <>
    <PersistedTimeline messages={messages} />
    <LiveTimeline events={events} />
    {running && !events.some(event => event.type === "tool_call" || event.type === "text") && <div className="agent-chat-working"><LoaderCircle className="spinning" size={14} /><span>Agent 正在思考</span></div>}
    {!hasHistory && !running && null}
  </>;
}

