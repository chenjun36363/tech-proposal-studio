import { Check, ChevronDown, ChevronRight, Circle, ListChecks, LoaderCircle } from "lucide-react";
import type { TodoItem } from "../agent/protocol";

export function AgentTodoPlan({ todos, collapsed, toggle }: { todos: TodoItem[]; collapsed: boolean; toggle: () => void }) {
  const completed = todos.filter(todo => todo.status === "completed").length;
  if (!todos.length) return null;
  return <section className={`agent-live-todos${collapsed ? " collapsed" : ""}`}>
    <button type="button" className="agent-live-todos-head" onClick={toggle} aria-expanded={!collapsed}>
      <span><ListChecks size={14} /><b>执行计划</b></span>
      <span><em>{completed}/{todos.length}</em>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
    </button>
    <div className="agent-live-todos-progress"><i style={{ width: `${completed / todos.length * 100}%` }} /></div>
    {!collapsed && <div className="agent-live-todos-list">{todos.map((todo, index) => <div key={`${index}-${todo.content}`} className={todo.status}>
      <i>{todo.status === "completed" ? <Check size={11} /> : todo.status === "in_progress" ? <LoaderCircle className="spinning" size={11} /> : <Circle size={10} />}</i>
      <span>{todo.status === "in_progress" ? todo.activeForm : todo.content}</span>
    </div>)}</div>}
  </section>;
}
