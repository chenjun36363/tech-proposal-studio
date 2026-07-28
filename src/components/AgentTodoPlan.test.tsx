import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTodoPlan } from "./AgentTodoPlan";

const todos = [
  { content: "读取资料", status: "completed" as const, activeForm: "正在读取资料" },
  { content: "编写方案", status: "in_progress" as const, activeForm: "正在编写方案" },
  { content: "复核", status: "pending" as const, activeForm: "正在复核" },
];

describe("AgentTodoPlan", () => {
  it("renders progress and the active form", () => {
    const html = renderToStaticMarkup(<AgentTodoPlan todos={todos} collapsed={false} toggle={vi.fn()} />);
    expect(html).toContain("1/3");
    expect(html).toContain("正在编写方案");
    expect(html).toContain("33.33333333333333%");
  });

  it("keeps the progress header and hides rows when collapsed", () => {
    const html = renderToStaticMarkup(<AgentTodoPlan todos={todos} collapsed toggle={vi.fn()} />);
    expect(html).toContain("1/3");
    expect(html).not.toContain("正在编写方案");
    expect(html).toContain('aria-expanded="false"');
  });
});
