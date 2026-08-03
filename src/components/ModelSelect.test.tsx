// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../core/types";
import { ModelSelect } from "./ModelSelect";

const providers: LlmProvider[] = [{
  id: "provider-1",
  name: "OpenAI-compatible",
  protocol: "openai-completions",
  baseUrl: "https://example.test/v1",
  apiKey: "",
  timeoutMs: 30_000,
  headers: {},
  enabled: true,
  activeModels: ["gpt-5.2"],
  catalog: [
    { id: "gpt-4.1", displayName: "GPT-4.1" },
    { id: "gpt-5.2", displayName: "GPT-5.2" },
  ],
}];

describe("ModelSelect", () => {
  it("fuzzy-searches only active models when activeOnly is enabled", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => root.render(<ModelSelect providers={providers} value={null} onChange={onChange} activeOnly />));
    act(() => container.querySelector<HTMLButtonElement>(".model-combobox-trigger")?.click());

    const input = container.querySelector<HTMLInputElement>(".model-combobox-input");
    expect(input).not.toBeNull();
    act(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(input, "gt52");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("GPT-5.2");
    expect(container.textContent).not.toContain("GPT-4.1");
    act(() => container.querySelector<HTMLButtonElement>(".model-combobox-option")?.click());
    expect(onChange).toHaveBeenCalledWith({ providerId: "provider-1", model: "gpt-5.2" });

    act(() => root.unmount());
    container.remove();
  });
});
