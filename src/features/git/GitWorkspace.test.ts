import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./GitWorkspace";

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
