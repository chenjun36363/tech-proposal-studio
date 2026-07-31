// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalImagePath, highlightPreviewHtml, MarkdownSourceEditor } from "./MarkdownEditor";

describe("local Markdown image paths", () => {
  it("decodes paths encoded by marked before filesystem resolution", () => {
    expect(decodeLocalImagePath("assets/import-%E5%B8%B8%E5%B7%9E/image%201.png"))
      .toBe("assets/import-常州/image 1.png");
  });

  it("preserves decoded and malformed paths", () => {
    expect(decodeLocalImagePath("assets/import-demo/image.png")).toBe("assets/import-demo/image.png");
    expect(decodeLocalImagePath("assets/import-%E5/image.png")).toBe("assets/import-%E5/image.png");
  });
});

describe("Markdown editor selection capture", () => {
  it("renders all source matches in the mirrored highlight layer", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(MarkdownSourceEditor, { value: "LIMS 和 LIMS", onChange: () => undefined, highlights: [{ start: 0, end: 4 }, { start: 7, end: 11 }], activeHighlight: 1 })));
    expect(host.querySelectorAll(".md-source-highlight mark")).toHaveLength(2);
    expect(host.querySelectorAll(".md-source-highlight mark.active")).toHaveLength(1);
    act(() => root.unmount());
  });

  it("reports a non-empty selection before focus moves to the Agent input", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSelectionChange = vi.fn();

    act(() => root.render(createElement(MarkdownSourceEditor, {
      value: "选中的正文",
      onChange: () => undefined,
      onSelectionChange,
    })));
    const textarea = host.querySelector("textarea")!;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(0, 3);
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
    });

    expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 0, end: 3 });

    act(() => root.unmount());
    host.remove();
  });
});

describe("Markdown preview search highlighting", () => {
  it("marks matching rendered text without changing element attributes", () => {
    const html = highlightPreviewHtml('<p title="LIMS">LIMS 与 lims</p>', "lims", false);
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("p")?.getAttribute("title")).toBe("LIMS");
    expect(host.querySelectorAll("mark.md-search-match")).toHaveLength(2);
  });
});
