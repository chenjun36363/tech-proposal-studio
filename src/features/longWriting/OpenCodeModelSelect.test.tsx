// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeModelSelect } from "./OpenCodeModelSelect";
import type { OpenCodeModelOption } from "./opencodeService";

const models: OpenCodeModelOption[] = [
  { providerId: "openai", providerName: "OpenAI", modelId: "gpt-5.2-codex", modelName: "GPT 5.2 Codex", isDefault: true },
  { providerId: "deepseek", providerName: "DeepSeek", modelId: "deepseek-chat", modelName: "DeepSeek V3", isDefault: false },
];

describe("OpenCodeModelSelect", () => {
  it("places search inside the dropdown and preserves the selected model while filtering", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => root.render(<OpenCodeModelSelect models={models} value={{ providerId: "openai", modelId: "gpt-5.2-codex" }} onChange={onChange} />));
    expect(container.querySelector(".model-combobox-input")).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".model-combobox-trigger")?.click());

    const input = container.querySelector<HTMLInputElement>(".model-combobox-input");
    expect(input).not.toBeNull();
    act(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, "deepseek");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = [...container.querySelectorAll<HTMLElement>(".model-combobox-option")];
    expect(options.map(option => option.textContent)).toEqual([
      "GPT 5.2 Codex（默认）OpenAI · gpt-5.2-codex",
      "DeepSeek V3DeepSeek · deepseek-chat",
    ]);
    act(() => options[1].click());
    expect(onChange).toHaveBeenCalledWith({ providerId: "deepseek", modelId: "deepseek-chat" });
    expect(container.querySelector(".model-combobox-input")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
