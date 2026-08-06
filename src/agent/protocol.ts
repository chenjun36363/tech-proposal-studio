export type AgentRunStatus = "idle" | "running" | "waiting_approval" | "waiting_user" | "completed" | "round_limit_reached" | "failed" | "cancelled";

export type AgentUserQuestionChoice = "A" | "B" | "C" | "D";
export interface AgentUserQuestionOption { choice: Exclude<AgentUserQuestionChoice, "D">; title: string; overview: string; }
export interface AgentUserQuestion { question: string; options: [AgentUserQuestionOption, AgentUserQuestionOption, AgentUserQuestionOption]; }
export interface AgentUserQuestionAnswer { choice: AgentUserQuestionChoice; answer: string; }

export type AgentGitOperation = "stage" | "unstage" | "commit" | "create_branch" | "switch_branch" | "stash_push" | "stash_pop" | "fetch" | "pull" | "push";
export interface AgentGitApprovalRequest {
  operation: AgentGitOperation;
  title: string;
  description: string;
  details: Array<{ label: string; value: string }>;
}

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string; }

export interface AgentToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface AgentToolResult { content: string; data?: unknown; isError: boolean; }
export type AgentEditOperation = "replace_section" | "replace_selection" | "replace_document" | "insert_section" | "delete_section" | "move_section";
export interface AgentDraftTarget {
  sectionId?: string;
  sectionTitle?: string;
  sectionLevel?: number;
  position?: "before" | "after";
  selectionStart?: number;
  selectionEnd?: number;
  selectionScope?: "section" | "document";
  /** Target snapshot used to reject stale proposals before applying them. */
  snapshot?: string;
  destinationSectionId?: string;
  destinationSectionTitle?: string;
  /** Destination snapshot used together with snapshot for safe chapter movement. */
  destinationSnapshot?: string;
}
export interface AgentDraft {
  callId: string;
  operation: AgentEditOperation;
  target: AgentDraftTarget;
  before: string;
  after: string;
  instruction: string;
}
export interface AgentEditorSelection {
  start: number;
  end: number;
  text: string;
  scope: "section" | "document";
  sectionId?: string;
  sectionTitle?: string;
}

export type AgentEvent =
  | { id: string; type: "run_started"; at: number; model: string }
  | { id: string; type: "round_started"; at: number; round: number }
  | { id: string; type: "context_compacted"; at: number; round: number; beforeTokens: number; afterTokens: number; removedMessages: number }
  | { id: string; type: "stream_started"; at: number; round: number; phase: "thinking" | "output" | "tool" }
  | { id: string; type: "reasoning"; at: number; round: number; content: string }
  | { id: string; type: "text"; at: number; round: number; content: string }
  | { id: string; type: "tool_call"; at: number; round: number; call: AgentToolCall }
  | { id: string; type: "tool_started"; at: number; round: number; callId: string }
  | { id: string; type: "tool_result"; at: number; round: number; call: AgentToolCall; result: AgentToolResult }
  | { id: string; type: "run_completed"; at: number; summary: string }
  | { id: string; type: "round_limit_reached"; at: number; maxRounds: number }
  | { id: string; type: "run_failed"; at: number; error: string }
  | { id: string; type: "run_cancelled"; at: number };

export interface AgentToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown>; };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_result_data?: unknown;
  tool_result_is_error?: boolean;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; }>;
  transient?: boolean;
}

export interface AgentModelResponse { choices?: Array<{ message?: AgentMessage; finish_reason?: string | null; }>; }
