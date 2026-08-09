import { useState } from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import type { LongWritingTaskRecord } from "./types";
import type { OpenCodeSessionActivityMap } from "./openCodeEvents";

function activityTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour12: false });
}

export function OpenCodeSessionMonitor({ task, activities, busy }: {
  task: LongWritingTaskRecord;
  activities: OpenCodeSessionActivityMap;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sessions = [
    ...(task.mainSessionId ? [{ id: task.mainSessionId, title: "目录生成", phase: task.status }] : []),
    ...task.chapters.filter(job => job.sessionId).map(job => ({
      id: job.sessionId!,
      title: job.titlePath.join(" / "),
      phase: job.status,
    })),
  ];
  if (!sessions.length) return null;

  return <section className="opencode-session-monitor">
    <header><span><Activity size={13} /><b>OpenCode 会话</b>{busy && <i />}</span><em>{sessions.length} 个</em></header>
    <div className="opencode-session-list" aria-live="polite">
      {sessions.map(session => {
        const items = activities[session.id] ?? [];
        const isExpanded = expanded.has(session.id);
        const latest = items.at(-1)?.summary ?? "等待会话事件";
        return <div className="opencode-session" key={session.id}>
          <button type="button" onClick={() => setExpanded(value => { const next = new Set(value); next.has(session.id) ? next.delete(session.id) : next.add(session.id); return next; })} aria-expanded={isExpanded}>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span><b>{session.title}</b><small>{latest}</small></span>
            <em>{session.phase}</em>
          </button>
          {isExpanded && <div className="opencode-session-activity">
            {items.length ? items.slice(-80).map(item => <div className={`kind-${item.kind}`} key={item.id}>
              <time>{activityTime(item.at)}</time><span>{item.summary}</span>
            </div>) : <p>尚未收到可展示的文本、状态或工具事件。</p>}
          </div>}
        </div>;
      })}
    </div>
    <p>实时流仅保存在内存中；不展示隐藏推理或工具输入。</p>
  </section>;
}
