import { describe, expect, it } from "vitest";
import { applyAgentModeTools } from "./modes";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

function registry() {
  const result = new AgentToolRegistry();
  for (const name of ["write_todo", "read_current_section", "propose_section_update", "run_powershell"]) {
    result.register({
      definition: { type: "function", function: { name, description: name, parameters: objectSchema({}) } },
      execute: () => ({ content: "ok", isError: false }),
    });
  }
  return result;
}

describe("agent modes", () => {
  it("keeps planning and read tools in Plan mode while denying mutations", () => {
    const tools = applyAgentModeTools(registry(), "plan");
    expect(tools.has("write_todo")).toBe(true);
    expect(tools.has("read_current_section")).toBe(true);
    expect(tools.has("propose_section_update")).toBe(false);
    expect(tools.has("run_powershell")).toBe(false);
  });

  it("removes task planning in Build mode while retaining execution tools", () => {
    const tools = applyAgentModeTools(registry(), "build");
    expect(tools.has("write_todo")).toBe(false);
    expect(tools.has("read_current_section")).toBe(true);
    expect(tools.has("propose_section_update")).toBe(true);
    expect(tools.has("run_powershell")).toBe(true);
  });
});
