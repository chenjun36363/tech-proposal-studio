import { describe, expect, it } from "vitest";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

describe("AgentToolRegistry", () => {
  it("dispatches a registered tool and returns its structured result", async () => {
    const registry = new AgentToolRegistry().register({
      definition: { type: "function", function: { name: "read", description: "read", parameters: objectSchema({}) } },
      execute: args => ({ content: String(args.path), isError: false }),
    });
    const result = await registry.execute({ id: "1", name: "read", arguments: { path: "proposal.md" } }, new AbortController().signal);
    expect(result).toEqual({ content: "proposal.md", isError: false });
  });

  it("returns a tool error for an unknown name", async () => {
    const result = await new AgentToolRegistry().execute({ id: "1", name: "missing", arguments: {} }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing");
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
