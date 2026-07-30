// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AgentDraftReviewModal } from "./AgentDraftReviewModal";

describe("AgentDraftReviewModal", () => {
  it("portals the review dialog outside its panel container", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const panel = document.createElement("aside");
    document.body.appendChild(panel);
    const root = createRoot(panel);

    act(() => root.render(<AgentDraftReviewModal
        draft={{ callId: "call-1", operation: "replace_section", target: { sectionId: "section-1" }, before: "优化前正文", after: "优化后正文", instruction: "补全技术约束" }}
        close={vi.fn()}
        reject={vi.fn()}
        accept={vi.fn()}
      />));

    const overlay = document.querySelector<HTMLElement>(".agent-review-overlay");
    expect(overlay?.parentElement).toBe(document.body);
    expect(panel.querySelector(".agent-review-overlay")).toBeNull();
    const html = overlay?.innerHTML ?? "";
    const text = overlay?.textContent ?? "";
    expect(text).toContain("优化前正文");
    expect(text).toContain("优化后正文");
    expect(html).toContain("同步滚动");
    expect(html).toContain("调整原文与优化稿宽度");
    expect(html).toContain("恢复均分");
    expect(html).toContain("拒绝修改");
    expect(html).toContain("接受并替换");
    expect(html).toContain("agent-review-diff-line delete");
    expect(html).toContain("agent-review-diff-line add");
    expect(html).toContain("原稿差异");
    expect(html).toContain("修订稿差异");

    act(() => root.unmount());
    panel.remove();
  });

  it("shows a destructive warning for a section deletion proposal", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const panel = document.createElement("aside");
    document.body.appendChild(panel);
    const root = createRoot(panel);

    act(() => root.render(<AgentDraftReviewModal
      draft={{ callId: "delete-1", operation: "delete_section", target: { sectionId: "risk", sectionTitle: "风险" }, before: "## 风险\n\n旧内容", after: "", instruction: "删除重复章节" }}
      close={vi.fn()}
      reject={vi.fn()}
      accept={vi.fn()}
    />));

    const html = document.querySelector<HTMLElement>(".agent-review-overlay")?.innerHTML ?? "";
    expect(html).toContain("章节删除审核");
    expect(html).toContain("删除章节将同时删除其全部子章节");
    expect(html).toContain("整个章节将被删除");
    expect(html).toContain("确认删除");
    expect(html).toContain("-3 行");

    act(() => root.unmount());
    panel.remove();
  });

  it("shows source and destination details for a chapter move", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
    const panel = document.createElement("aside");
    document.body.appendChild(panel);
    const root = createRoot(panel);

    act(() => root.render(<AgentDraftReviewModal
      draft={{ callId: "move-1", operation: "move_section", target: { sectionId: "risk", sectionTitle: "风险", destinationSectionId: "test", destinationSectionTitle: "测试", destinationSnapshot: "## 测试\n\n目标内容", position: "before" }, before: "## 风险\n\n源内容", after: "## 风险\n\n源内容", instruction: "调整叙事顺序" }}
      close={vi.fn()} reject={vi.fn()} accept={vi.fn()}
    />));

    const html = document.querySelector<HTMLElement>(".agent-review-overlay")?.innerHTML ?? "";
    expect(html).toContain("章节移动审核");
    expect(html).toContain("将「风险」移动到「测试」之前");
    expect(html).toContain("目标内容");
    expect(html).toContain("接受并移动");
    expect(html).toContain("正文未修改，仅调整位置");
    expect(html).not.toContain("agent-review-diff-line delete");
    act(() => root.unmount());
    panel.remove();
  });
});

