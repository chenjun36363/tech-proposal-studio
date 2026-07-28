import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../data";
import { searchWeb } from "../services/search";
import { fetchKnowledgeWebPage } from "../knowledge";
import type { DocumentBlock } from "../types";
import { createProposalToolRegistry } from "./proposalTools";

vi.mock("../services/search", () => ({ searchWeb: vi.fn() }));
vi.mock("../knowledge", async importOriginal => {
  const original = await importOriginal<typeof import("../knowledge")>();
  return { ...original, fetchKnowledgeWebPage: vi.fn() };
});

const block: DocumentBlock = {
  id: "block-1",
  sectionId: "section-1",
  type: "text",
  content: "## 当前章节",
  order: 0,
  status: "draft",
  sourceRefs: [],
};

function registry(reviewDraft: () => boolean | Promise<boolean> = () => true) {
  return createProposalToolRegistry({
    project: createProject(),
    block,
    reviewDraft,
    onTodos: () => undefined,
  });
}

describe("proposal agent web search tool", () => {
  beforeEach(() => {
    vi.mocked(searchWeb).mockReset();
    vi.mocked(fetchKnowledgeWebPage).mockReset();
  });

  it("returns structured sources without a separate approval step", async () => {
    vi.mocked(searchWeb).mockResolvedValue([
      { title: "官方报告", url: "https://example.com/report", excerpt: "报告摘要" },
    ]);
    const project = createProject();
    const result = await createProposalToolRegistry({
      project,
      block,
      reviewDraft: () => true,
      onTodos: () => undefined,
    }).execute(
      { id: "call-2", name: "web_search", arguments: { query: "最新行业数据" } },
      new AbortController().signal,
    );

    expect(searchWeb).toHaveBeenCalledWith("最新行业数据", project.search);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://example.com/report");
  });

  it("executes web search when the tool is registered", async () => {
    vi.mocked(searchWeb).mockResolvedValue([]);
    const result = await createProposalToolRegistry({
      project: createProject(), block, reviewDraft: () => true, onTodos: () => undefined,
    }).execute({ id: "default-search", name: "web_search", arguments: { query: "LIMS" } }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(searchWeb).toHaveBeenCalledOnce();
  });

  it("reads only pages returned by the current search", async () => {
    vi.mocked(searchWeb).mockResolvedValue([{ title: "官方报告", url: "https://example.com/report", excerpt: "摘要" }]);
    vi.mocked(fetchKnowledgeWebPage).mockResolvedValue({ title: "官方报告", url: "https://example.com/report", markdown: "网页正文" });
    const tools = registry();
    await tools.execute({ id: "search", name: "web_search", arguments: { query: "报告" } }, new AbortController().signal);

    const allowed = await tools.execute({ id: "read", name: "read_web_page", arguments: { url: "https://example.com/report" } }, new AbortController().signal);
    const blocked = await tools.execute({ id: "blocked", name: "read_web_page", arguments: { url: "https://other.example.com" } }, new AbortController().signal);

    expect(allowed.content).toContain("网页正文");
    expect(blocked.isError).toBe(true);
    expect(fetchKnowledgeWebPage).toHaveBeenCalledTimes(1);
  });

  it("prevents repeated searches and repeated page reads", async () => {
    vi.mocked(searchWeb).mockResolvedValue([{ title: "报告", url: "https://example.com/report", excerpt: "摘要" }]);
    vi.mocked(fetchKnowledgeWebPage).mockResolvedValue({ title: "报告", url: "https://example.com/report", markdown: "正文" });
    const tools = registry();
    await tools.execute({ id: "search-1", name: "web_search", arguments: { query: "LIMS" } }, new AbortController().signal);
    const duplicateSearch = await tools.execute({ id: "search-2", name: "web_search", arguments: { query: "lims" } }, new AbortController().signal);
    await tools.execute({ id: "read-1", name: "read_web_page", arguments: { url: "https://example.com/report" } }, new AbortController().signal);
    const duplicateRead = await tools.execute({ id: "read-2", name: "read_web_page", arguments: { url: "https://example.com/report" } }, new AbortController().signal);

    expect(duplicateSearch.isError).toBe(true);
    expect(duplicateRead.isError).toBe(true);
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(fetchKnowledgeWebPage).toHaveBeenCalledTimes(1);
  });

  it("enforces the configured per-task web search limit", async () => {
    vi.mocked(searchWeb).mockResolvedValue([]);
    const project = createProject();
    project.agent.webSearchMaxCalls = 1;
    const tools = createProposalToolRegistry({
      project, block, reviewDraft: () => true, onTodos: () => undefined,
    });

    const first = await tools.execute({ id: "search-1", name: "web_search", arguments: { query: "LIMS 标准" } }, new AbortController().signal);
    const second = await tools.execute({ id: "search-2", name: "web_search", arguments: { query: "LIMS 规范" } }, new AbortController().signal);

    expect(first.isError).toBe(false);
    expect(second).toEqual(expect.objectContaining({ isError: true, content: expect.stringContaining("未知工具") }));
    expect(tools.has("web_search")).toBe(false);
    expect(searchWeb).toHaveBeenCalledTimes(1);
  });
});

describe("proposal agent todo tool", () => {
  it("accepts a complete plan with one active item", async () => {
    const onTodos = vi.fn();
    const tools = createProposalToolRegistry({ project: createProject(), block, reviewDraft: () => true, onTodos });
    const todos = [
      { content: "读取当前章节", status: "in_progress", activeForm: "正在读取当前章节" },
      { content: "检索知识库", status: "pending", activeForm: "正在检索知识库" },
    ];

    const result = await tools.execute({ id: "todo-1", name: "write_todo", arguments: { todos } }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(onTodos).toHaveBeenCalledWith(todos);
  });

  it("rejects plans with multiple active items", async () => {
    const tools = registry();
    const result = await tools.execute({ id: "todo-2", name: "write_todo", arguments: { todos: [
      { content: "读取章节", status: "in_progress", activeForm: "正在读取章节" },
      { content: "联网搜索", status: "in_progress", activeForm: "正在联网搜索" },
    ] } }, new AbortController().signal);

    expect(result).toEqual(expect.objectContaining({ isError: true, content: expect.stringContaining("最多只能有一个") }));
  });
});

describe("proposal agent draft review", () => {
  it("does not finish the tool call before the user decides", async () => {
    let decide: ((approved: boolean) => void) | undefined;
    const tools = registry(() => new Promise<boolean>(resolve => { decide = resolve; }));
    let settled = false;
    const pending = tools.execute({ id: "draft-wait", name: "propose_section_update", arguments: { markdown: "## 等待", instruction: "更新" } }, new AbortController().signal).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    decide?.(true);
    await expect(pending).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({ approved: true }) }));
  });

  it("waits for acceptance and uses the accepted draft as the next section baseline", async () => {
    const reviewDraft = vi.fn().mockResolvedValue(true);
    const tools = registry(reviewDraft);
    const signal = new AbortController().signal;

    const proposed = await tools.execute({ id: "draft-1", name: "propose_section_update", arguments: { markdown: "## 新正文", instruction: "更新" } }, signal);
    const current = await tools.execute({ id: "read-1", name: "read_current_section", arguments: {} }, signal);

    expect(proposed).toEqual(expect.objectContaining({ isError: false, data: expect.objectContaining({ approved: true }) }));
    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({ before: "## 当前章节", after: "## 新正文" }), signal);
    expect(current.content).toBe("## 新正文");
  });

  it("keeps the current section unchanged after rejection", async () => {
    const tools = registry(() => false);
    const signal = new AbortController().signal;
    const proposed = await tools.execute({ id: "draft-2", name: "propose_section_update", arguments: { markdown: "## 被拒绝", instruction: "更新" } }, signal);
    const current = await tools.execute({ id: "read-2", name: "read_current_section", arguments: {} }, signal);

    expect(proposed).toEqual(expect.objectContaining({ isError: false, data: expect.objectContaining({ approved: false }) }));
    expect(current.content).toBe("## 当前章节");
  });
});
