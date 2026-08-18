// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../../core/data";
import { testModel } from "../../services/model";
import { ModelSettingsSection, HeaderRows } from "./ModelSettingsSection";

vi.mock("../../services/model", () => ({
  listModels: vi.fn(),
  testModel: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HeaderRows", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
    vi.clearAllMocks();
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

describe("model connection tests", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("tests the default model and each configured fallback model", async () => {
    const project = createProject();
    const provider = project.providers[0];
    const fallbackModel = "fallback-model";
    provider.activeModels = [...provider.activeModels, fallbackModel];
    provider.catalog = [...(provider.catalog ?? []), { id: fallbackModel, displayName: fallbackModel }];
    project.fallbackModels = [{ providerId: provider.id, model: fallbackModel }];
    vi.mocked(testModel).mockResolvedValue({ output: "OK" });

    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<ModelSettingsSection draft={project} setDraft={vi.fn()} />));

    const defaultButton = container.querySelector('button[title="测试默认模型"]');
    const fallbackButton = container.querySelector('button[title="测试模型"]');
    expect(defaultButton).not.toBeNull();
    expect(fallbackButton).not.toBeNull();

    await act(async () => { defaultButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { fallbackButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    expect(vi.mocked(testModel)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(testModel).mock.calls[0][0].model).toBe(provider.activeModels[0]);
    expect(vi.mocked(testModel).mock.calls[1][0].model).toBe(fallbackModel);
    expect(container.textContent).toContain("模型可用：OK");
    act(() => root.unmount());
  });
});
