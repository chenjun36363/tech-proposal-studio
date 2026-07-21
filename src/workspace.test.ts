import { describe, expect, it } from "vitest";
import { uniqueImportedMarkdownName } from "./workspace";

describe("workspace Markdown import", () => {
  it("keeps an unused Markdown filename", () => {
    expect(uniqueImportedMarkdownName("方案.md", ["其他.md"])).toBe("方案.md");
  });

  it("adds a numeric suffix for case-insensitive conflicts", () => {
    expect(uniqueImportedMarkdownName("方案.md", ["方案.MD", "方案 (1).md"])).toBe("方案 (2).md");
  });

  it("normalizes markdown extensions and unsafe filename characters", () => {
    expect(uniqueImportedMarkdownName("外部:方案.markdown", [])).toBe("外部_方案.md");
  });
});
