// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { decodeLocalImagePath, MarkdownSourceEditor } from "./markdownEditor";

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
