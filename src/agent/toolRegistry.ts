import type { AgentToolCall, AgentToolDefinition, AgentToolResult } from "./protocol";

export type AgentToolExecutor = (args: Record<string, unknown>, signal: AbortSignal) => Promise<AgentToolResult> | AgentToolResult;
export interface AgentToolRegistration { definition: AgentToolDefinition; execute: AgentToolExecutor; }

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolRegistration>();
  register(registration: AgentToolRegistration) {
    const name = registration.definition.function.name;
    if (this.tools.has(name)) throw new Error(`Agent 工具重复注册：${name}`);
    this.tools.set(name, registration);
    return this;
  }
  unregister(name: string) { this.tools.delete(name); return this; }
  has(name: string) { return this.tools.has(name); }
  definitions(): AgentToolDefinition[] { return [...this.tools.values()].map(item => item.definition); }
  async execute(call: AgentToolCall, signal: AbortSignal): Promise<AgentToolResult> {
    if (signal.aborted) throw new DOMException("Agent 任务已取消", "AbortError");
    const registration = this.tools.get(call.name);
    if (!registration) return { content: `未知工具：${call.name}`, isError: true };
    try { return await registration.execute(call.arguments, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
