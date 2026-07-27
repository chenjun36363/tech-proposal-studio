// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderInlineMarkdown } from "./InlineMarkdown";

describe("renderInlineMarkdown", () => {
  it("renders emphasis without exposing Markdown markers", () => {
    expect(renderInlineMarkdown("第1章 **建设概述**")).toBe("第1章 <strong>建设概述</strong>");
  });

  it("keeps heading labels inline and strips links and raw HTML", () => {
    expect(renderInlineMarkdown("[说明](https://example.com) <img src=x onerror=alert(1)>")).toBe("说明 ");
  });
});
