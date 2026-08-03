// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalImagePath, highlightPreviewHtml, MarkdownPreview, MarkdownSourceEditor } from "./MarkdownEditor";

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

  it("aligns the highlight mirror when matches appear after the source has scrolled", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    const root = createRoot(host);
    const props = { value: "第一行\n第二行 LIMS", onChange: () => undefined };
    act(() => root.render(createElement(MarkdownSourceEditor, props)));
    const textarea = host.querySelector("textarea")!;
    textarea.scrollLeft = 12;
    textarea.scrollTop = 80;

    act(() => root.render(createElement(MarkdownSourceEditor, {
      ...props,
      highlights: [{ start: 8, end: 12 }],
    })));

    expect(host.querySelector<HTMLElement>(".md-source-highlight > div")?.style.transform)
      .toBe("translate3d(-12px, -80px, 0)");
    act(() => root.unmount());
  });

  it("keeps the caret after typing a second heading marker when the section value shrinks", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const fullSection = "# 标题\n\n正文\n\n## 下一章\n\n后续";

    act(() => root.render(createElement(MarkdownSourceEditor, { value: fullSection, onChange })));
    const textarea = host.querySelector("textarea")!;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, `#${textarea.value}`);
      textarea.setSelectionRange(2, 2);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenLastCalledWith(`##${fullSection.slice(1)}`);

    act(() => root.render(createElement(MarkdownSourceEditor, { value: "## 标题", onChange })));

    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(2);

    act(() => root.unmount());
    host.remove();
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

describe("Markdown preview syntax highlighting", () => {
  it("emits highlight.js token classes on fenced code blocks", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    const root = createRoot(host);
    const markdown = "```ts\nconst x: number = 1;\nfunction f() { return x; }\n```";
    act(() => root.render(createElement(MarkdownPreview, { markdown })));
    const code = host.querySelector<HTMLElement>(".md-preview pre code")!;
    expect(code.className).toContain("hljs");
    expect(code.className).toContain("language-ts");
    expect(code.querySelector(".hljs-keyword, .hljs-title, .hljs-number, .hljs-variable")).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders ==text== from the highlight button as a mark element", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(MarkdownPreview, { markdown: "这是 ==重点内容== 需要标黄" })));
    const mark = host.querySelector<HTMLElement>(".md-preview mark.md-mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("重点内容");
    expect(host.textContent).not.toContain("==");
    act(() => root.unmount());
  });
});
