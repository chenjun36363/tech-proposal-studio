// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { listAgentMemories, searchAgentMemories, upsertAgentMemory } from "./memoryStore";

describe("browser memory adapter", () => {
  beforeEach(() => localStorage.clear());

  it("normalizes legacy facts and keeps them active", () => {
    localStorage.setItem("tech-proposal-studio.agent-memory.v1", JSON.stringify([{ id: "old", projectId: "p", content: "旧版部署决策", createdAt: 1, updatedAt: 1 }]));
    expect(listAgentMemories("p")[0]).toEqual(expect.objectContaining({ id: "old", memoryType: "fact", status: "active", confidence: "confirmed" }));
  });

  it("keeps pending candidates out of agent search until accepted", () => {
    upsertAgentMemory("p", { title: "接口约束", content: "接口必须记录审计日志", memoryType: "constraint", confidence: "inferred", status: "pending_review" });
    expect(listAgentMemories("p", true)).toHaveLength(1);
    expect(listAgentMemories("p", false)).toHaveLength(0);
    expect(searchAgentMemories("p", "审计")).toHaveLength(0);
  });
});
