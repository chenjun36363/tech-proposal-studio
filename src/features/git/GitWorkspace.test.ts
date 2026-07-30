import { describe, expect, it } from "vitest";
import { getGitStatusCounts, parseUnifiedDiff } from "./GitWorkspace";

describe("parseUnifiedDiff", () => {
  it("tracks old and new line numbers", () => {
    const lines = parseUnifiedDiff("@@ -2,2 +2,2 @@\n same\n-old\n+new");
    expect(lines.slice(1)).toMatchObject([
      { kind: "context", oldLine: 2, newLine: 2 },
      { kind: "delete", oldLine: 3, newLine: null },
      { kind: "add", oldLine: null, newLine: 3 },
    ]);
  });
});

describe("getGitStatusCounts", () => {
  it("keeps untracked files out of staged and unstaged counts", () => {
    expect(getGitStatusCounts([
      { path: "staged.ts", indexStatus: "M", worktreeStatus: "." },
      { path: "unstaged.ts", indexStatus: ".", worktreeStatus: "M" },
      { path: "both.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "new.ts", indexStatus: "?", worktreeStatus: "?" },
    ])).toEqual({ staged: 2, unstaged: 2, untracked: 1 });
  });
});
