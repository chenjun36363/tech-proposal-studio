// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { OpenCodeConversationMessageCard } from "./LongWritingDetailModal";
import type { OpenCodeConversationMessage } from "./openCodeConversation";

const message: OpenCodeConversationMessage = {
  id: "message-1",
  role: "assistant",
  model: "gpt-5",
  parts: [{ id: "part-1", kind: "text", text: "可选择并复制的会话正文" }],
};

describe("OpenCodeConversationMessageCard", () => {
  it("expands and collapses a conversation message from its header control", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let expanded = true;
    const render = () => root.render(<OpenCodeConversationMessageCard
      message={message}
      expanded={expanded}
      onToggle={() => { expanded = !expanded; render(); }}
    />);

    act(render);
    const toggle = container.querySelector<HTMLButtonElement>(".opencode-conversation-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("可选择并复制的会话正文");
    act(() => toggle?.click());
    expect(container.querySelector(".opencode-conversation-message")?.classList.contains("is-collapsed")).toBe(true);
    expect(container.querySelector(".opencode-conversation-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("可选择并复制的会话正文");
    act(() => root.unmount());
    container.remove();
  });
});
