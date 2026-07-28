// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderRows } from "./ModelSettingsSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HeaderRows", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
  });

  it("keeps a newly added blank request-header row visible", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<HeaderRows headers={{}} onChange={vi.fn()} />));
    expect(container.querySelectorAll(".provider-header-row")).toHaveLength(1);

    const addButton = Array.from(container.querySelectorAll("button"))
      .find(button => button.textContent === "添加请求头");
    act(() => addButton?.click());

    expect(container.querySelectorAll(".provider-header-row")).toHaveLength(2);
    act(() => root.unmount());
  });
});
