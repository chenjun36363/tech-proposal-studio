import type { AgentMessage, TodoItem } from "./protocol";

export function normalizeTodoItems(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const todo = item as Record<string, unknown>;
    if (typeof todo.content !== "string" || !todo.content.trim()) return null;
    if (todo.status !== "pending" && todo.status !== "in_progress" && todo.status !== "completed") return null;
    todos.push({
      content: todo.content.trim(),
      status: todo.status,
      activeForm: typeof todo.activeForm === "string" && todo.activeForm.trim() ? todo.activeForm.trim() : todo.content.trim(),
    });
  }
  return todos;
}

export function latestTodosFromMessages(messages: AgentMessage[]): TodoItem[] {
  const snapshots = new Map<string, TodoItem[]>();
  let latest: TodoItem[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.function.name !== "write_todo") continue;
      try {
        const parsed = JSON.parse(call.function.arguments || "{}") as { todos?: unknown };
        const todos = normalizeTodoItems(parsed.todos);
        if (todos) snapshots.set(call.id, todos);
      } catch {
        // Invalid tool arguments never produce a successful snapshot.
      }
    }
    if (message.role === "tool" && message.tool_call_id && !message.tool_result_is_error) {
      const todos = normalizeTodoItems(message.tool_result_data) ?? snapshots.get(message.tool_call_id);
      if (todos) latest = todos;
    }
  }
  return latest;
}
