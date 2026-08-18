import { describe, expect, it, vi } from "vitest";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

describe("AgentToolRegistry", () => {
  it("dispatches a registered tool after schema validation", async () => {
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } },
      execute: args => ({ content: String(args.path), isError: false }),
    });
    const result = await registry.execute({ id: "1", name: "read", arguments: { path: "proposal.md" } }, new AbortController().signal);
    expect(result).toEqual({ content: "proposal.md", isError: false });
  });

  it("returns a stable structured error for an unknown name", async () => {
    const result = await new AgentToolRegistry().execute({ id: "1", name: "missing", arguments: {} }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual(expect.objectContaining({ code: "UNKNOWN_TOOL", retryable: false }));
    expect(result.content).toContain("TOOL_ERROR");
  });

  it("rejects missing, invalid-enum and non-coercible wrong-type fields without calling the executor", async () => {
    const execute = vi.fn(() => ({ content: "should not run", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "update", description: "update", parameters: objectSchema({
        title: { type: "string", minLength: 2 }, mode: { type: "string", enum: ["append", "replace"] }, count: { type: "integer", minimum: 1 },
      }, ["title", "mode", "count"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "update", arguments: { title: true, mode: "merge", extra: true } }, new AbortController().signal);
    expect(result.failure).toEqual(expect.objectContaining({ code: "INVALID_ARGUMENTS", retryable: true }));
    expect(result.failure?.issues.map(item => [item.path, item.code])).toEqual(expect.arrayContaining([
      ["count", "REQUIRED"], ["title", "INVALID_TYPE"], ["mode", "INVALID_ENUM"],
    ]));
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates nested objects and arrays after tolerant normalization", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "batch", description: "batch", parameters: objectSchema({
        options: { type: "object", properties: { label: { type: "string", minLength: 1 } }, required: ["label"], additionalProperties: false },
        ids: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
      }, ["options", "ids"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "batch", arguments: { options: { label: "", unknown: true }, ids: [1, 0.5] } }, new AbortController().signal);
    expect(result.failure?.issues.map(item => item.path)).toEqual(expect.arrayContaining(["options.label", "ids[1]"]));
    expect(execute).not.toHaveBeenCalled();
  });

  it("tolerates unknown fields, camelCase aliases and string-typed primitives in one call", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "search", description: "search", parameters: objectSchema({
        query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 }, case_sensitive: { type: "boolean" },
      }, ["query"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "search", arguments: { query: "标准", limit: "5", caseSensitive: "true", note: "额外说明" } }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ query: "标准", limit: 5, case_sensitive: true }, expect.any(AbortSignal));
  });

  it("normalizes nested array items with their item schema", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "plan", description: "plan", parameters: objectSchema({
        todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, active_form: { type: "string" } }, required: ["content", "status", "active_form"], additionalProperties: false } },
      }, ["todos"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "plan", arguments: { todos: [{ content: "任务", status: "pending", active_form: "执行中", extra: true }] } }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ todos: [{ content: "任务", status: "pending", active_form: "执行中" }] }, expect.any(AbortSignal));
  });

  it("keeps undeclared fields only when the schema allows them and drops null placeholders on declared keys", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "job", description: "job", parameters: objectSchema({
        items: { type: "object", properties: { title: { type: "string" }, note: { type: "string" } }, additionalProperties: true },
      }, []) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "job", arguments: { items: { title: "t", note: null, extra: 1 }, comment: "kept" } }, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(execute).toHaveBeenCalledWith({ items: { title: "t", extra: 1 } }, expect.any(AbortSignal));
  });

  it("still fails a required field that arrives as null", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ path: { type: "string" } }, ["path"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "read", arguments: { path: null } }, new AbortController().signal);
    expect(result.failure?.issues.map(item => [item.path, item.code])).toEqual([["path", "REQUIRED"]]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes documented legacy aliases before validation", async () => {
    const execute = vi.fn(args => ({ content: String(args.heading_id), isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({ heading_id: { type: "string" } }, ["heading_id"]) } },
      normalizeArgs: args => { const { headingId, ...rest } = args; return { ...rest, heading_id: args.heading_id ?? headingId }; },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "read", arguments: { headingId: "h-1" } }, new AbortController().signal);
    expect(result).toEqual({ content: "h-1", isError: false });
    expect(execute).toHaveBeenCalledWith({ heading_id: "h-1" }, expect.any(AbortSignal));
  });

  it("adds stable model-facing property descriptions", () => {
    const schema = objectSchema({ heading_id: { type: "string" }, custom_value: { type: "number" } });
    expect((schema.properties.heading_id as { description?: string }).description).toContain("get_proposal_outline");
    expect((schema.properties.custom_value as { description?: string }).description).toContain("custom_value");
  });

  it("can remove optional tools before a run", () => {
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "search_knowledge", description: "search", parameters: objectSchema({}) } },
      execute: () => ({ content: "ok", isError: false }),
    });
    registry.unregister("search_knowledge");
    expect(registry.definitions()).toEqual([]);
  });
});
