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

  it("rejects missing, unknown, wrong-type and enum fields without calling the executor", async () => {
    const execute = vi.fn(() => ({ content: "should not run", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "update", description: "update", parameters: objectSchema({
        title: { type: "string", minLength: 2 }, mode: { type: "string", enum: ["append", "replace"] }, count: { type: "integer", minimum: 1 },
      }, ["title", "mode", "count"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "update", arguments: { title: 1, mode: "merge", extra: true } }, new AbortController().signal);
    expect(result.failure).toEqual(expect.objectContaining({ code: "INVALID_ARGUMENTS", retryable: true }));
    expect(result.failure?.issues.map(item => [item.path, item.code])).toEqual(expect.arrayContaining([
      ["count", "REQUIRED"], ["title", "INVALID_TYPE"], ["mode", "INVALID_ENUM"], ["extra", "UNKNOWN_FIELD"],
    ]));
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates nested objects and arrays", async () => {
    const execute = vi.fn(() => ({ content: "ok", isError: false }));
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "batch", description: "batch", parameters: objectSchema({
        options: { type: "object", properties: { label: { type: "string", minLength: 1 } }, required: ["label"], additionalProperties: false },
        ids: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
      }, ["options", "ids"]) } },
      execute,
    });
    const result = await registry.execute({ id: "1", name: "batch", arguments: { options: { label: "", unknown: true }, ids: [1, 0.5] } }, new AbortController().signal);
    expect(result.failure?.issues.map(item => item.path)).toEqual(expect.arrayContaining(["options.label", "options.unknown", "ids[1]"]));
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
