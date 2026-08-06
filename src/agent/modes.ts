import type { AgentMode } from "./conversationStore";
import { AgentToolRegistry } from "./toolRegistry";

export const PLAN_TOOL_NAMES = new Set([
  "write_todo", "ask_user", "review_content",
  "get_proposal_outline", "read_current_section", "read_selected_text", "read_proposal_section", "find_document_text",
  "search_knowledge", "read_knowledge", "search_memory", "read_memory",
  "web_search", "read_web_page", "list_workspace_documents",
  "git_status", "git_diff", "git_log", "git_show_commit", "git_list_branches",
]);

export function applyAgentModeTools(registry: AgentToolRegistry, mode: AgentMode) {
  if (mode === "build") {
    registry.unregister("write_todo");
    return registry;
  }
  for (const definition of registry.definitions()) {
    if (!PLAN_TOOL_NAMES.has(definition.function.name)) registry.unregister(definition.function.name);
  }
  return registry;
}
