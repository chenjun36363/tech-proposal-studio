import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../agent/protocol";
import { AgentConversationTimeline } from "./AgentConversationTimeline";

describe("AgentConversationTimeline", () => {
  it("renders persisted tool activity inline with conversation messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "查一下部署约束" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "search_knowledge", arguments: "{\"query\":\"部署\"}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "部署目标为 Windows Server 2022" },
      { role: "assistant", content: "已经找到部署约束。" },
    ];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain("查一下部署约束");
    expect(html).toContain("检索知识库");
    expect(html).toContain("部署目标为 Windows Server 2022");
    expect(html).toContain("你");
    expect(html).toContain('aria-label="复制消息"');
    expect(html.match(/aria-label="复制消息"/g)).toHaveLength(1);
    expect(html).toMatch(/agent-user-label[^>]*>[\s\S]*agent-message-copy/);
    expect(html).not.toMatch(/agent-message-body[^>]*>[\s\S]*agent-message-copy/);
    expect(html).toContain("已经找到部署约束");
    expect(html.indexOf("查一下部署约束")).toBeLessThan(html.indexOf("检索知识库"));
    expect(html.indexOf("检索知识库")).toBeLessThan(html.indexOf("已经找到部署约束"));
  });

  it("uses the same Chinese tool labels as the settings catalog", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "memory-read", type: "function", function: { name: "read_memory", arguments: '{"id":"memory-1"}' } }] },
      { role: "tool", tool_call_id: "memory-read", content: "# 部署约束\n\n系统必须离线部署" },
      { role: "assistant", content: null, tool_calls: [{ id: "section-read", type: "function", function: { name: "read_proposal_section", arguments: '{"heading_id":"部署"}' } }] },
      { role: "tool", tool_call_id: "section-read", content: "## 部署\n\n正文" },
    ];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain("读取长期记忆");
    expect(html).toContain("读取指定章节");
    expect(html).not.toContain("读取项目记忆");
    expect(html).not.toContain(">read_proposal_section<");
  });

  it("renders agent Markdown as formatted HTML", () => {
    const messages: AgentMessage[] = [{
      role: "assistant",
      content: "## 部署建议\n\n- 使用 Windows Server 2022\n- 配置 `HTTPS`\n\n| 项目 | 要求 |\n| --- | --- |\n| 端口 | 443 |",
    }];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain('class="agent-message-markdown"');
    expect(html).toContain("<h2>部署建议</h2>");
    expect(html).toContain("<li>使用 Windows Server 2022</li>");
    expect(html).toContain("<code>HTTPS</code>");
    expect(html).toContain("<table>");
  });

  it("renders write_todo as a compact, collapsed execution step", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "plan-1", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "检查章节结构", status: "completed" }, { content: "补全实施方案", status: "in_progress" }, { content: "复核术语", status: "pending" }] }) } }] },
      { role: "tool", tool_call_id: "plan-1", content: "计划已更新，共 3 项。" },
    ];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain('class="agent-plan-detail"');
    expect(html).toMatch(/<details(?![^>]*open)[^>]*>[\s\S]*agent-plan-detail/);
    expect(html).toContain("执行计划");
    expect(html).toContain("1/3 已完成");
    expect(html).toContain("检查章节结构");
    expect(html).toContain('class="in_progress"');
    expect(html).not.toContain('&quot;todos&quot;');
  });

  it("does not infer todo completion from a proposal submission", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "plan-2", type: "function", function: { name: "write_todo", arguments: JSON.stringify({ todos: [{ content: "分析章节", status: "completed" }, { content: "撰写优化稿并提交", status: "in_progress" }] }) } }] },
      { role: "tool", tool_call_id: "plan-2", content: "计划已更新，共 2 项。" },
      { role: "assistant", content: null, tool_calls: [{ id: "draft-1", type: "function", function: { name: "propose_section_update", arguments: JSON.stringify({ markdown: "优化稿", instruction: "补全内容" }) } }] },
      { role: "tool", tool_call_id: "draft-1", content: "修改稿已提交给用户审批。", tool_result_data: { instruction: "补全内容", beforeChars: 10, afterChars: 20 }, tool_result_is_error: false },
    ];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain("1/2 已完成");
    expect(html).toContain('class="in_progress"');
  });

  it("renders persisted search data as result cards", () => {
    const messages: AgentMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"LIMS"}' } }] },
      { role: "tool", tool_call_id: "search-1", content: "[]", tool_result_data: { query: "LIMS", results: [{ title: "LIMS 指南", url: "https://example.com/lims", excerpt: "实施说明" }] }, tool_result_is_error: false },
    ];

    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain('class="agent-search-results"');
    expect(html).toContain("LIMS 指南");
    expect(html).toContain("实施说明");
    expect(html).not.toContain("<pre>[]</pre>");
  });

  it("adds formula rendering and code block controls while escaping raw HTML", () => {
    const messages: AgentMessage[] = [{ role: "assistant", content: "公式：$E=mc^2$\n\n```ts\nconst enabled = true;\n```\n\n<script>alert(1)</script>" }];
    const html = renderToStaticMarkup(<AgentConversationTimeline messages={messages} events={[]} running={false} />);
    expect(html).toContain("katex");
    expect(html).toContain('data-agent-code-action="copy"');
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

