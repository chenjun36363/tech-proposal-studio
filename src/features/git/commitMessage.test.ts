import { describe, expect, it } from "vitest";
import { normalizeCommitMessage } from "./commitMessage";

describe("normalizeCommitMessage", () => {
  it("keeps only the first non-empty line and removes wrapping", () => {
    expect(normalizeCommitMessage("```text\n\"feat: 增加 Git 历史\"\n额外解释\n```"))
      .toBe("feat: 增加 Git 历史");
  });

  it("limits unexpectedly verbose model output", () => {
    expect(normalizeCommitMessage(`feat: ${"长".repeat(150)}`)).toHaveLength(120);
  });
});
