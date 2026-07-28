export type AgentRunStatus = "idle" | "running" | "waiting_approval" | "completed" | "round_limit_reached" | "failed" | "cancelled";

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; activeForm: string; }

export interface AgentToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface AgentToolResult { content: string; data?: unknown; isError: boolean; }
export interface AgentDraft { callId: string; before: string; after: string; instruction: string; }

export type AgentEvent =
  | { id: string; type: "run_started"; at: number; model: string }
  | { id: string; type: "round_started"; at: number; round: number }
  | { id: string; type: "context_compacted"; at: number; round: number; beforeTokens: number; afterTokens: number; removedMessages: number }
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
  tool_call_id?: string;
  tool_result_data?: unknown;
  tool_result_is_error?: boolean;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; }>;
  transient?: boolean;
}

export interface AgentModelResponse { choices?: Array<{ message?: AgentMessage; finish_reason?: string | null; }>; }
