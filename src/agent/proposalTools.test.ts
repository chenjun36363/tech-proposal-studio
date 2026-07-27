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

function registry(confirmWebSearch: (query: string, provider: string) => boolean) {
  return createProposalToolRegistry({
    project: createProject(),
    block,
    sourceContents: {},
    onDraft: () => undefined,
    onTodos: () => undefined,
    confirmWebSearch,
  });
}

describe("proposal agent web search tool", () => {
  beforeEach(() => {
    vi.mocked(searchWeb).mockReset();
    vi.mocked(fetchKnowledgeWebPage).mockReset();
  });

  it("does not send a rejected query", async () => {
    const result = await registry(() => false).execute(
      { id: "call-1", name: "web_search", arguments: { query: "最新行业数据" } },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(searchWeb).not.toHaveBeenCalled();
  });

  it("returns structured sources after approval", async () => {
    vi.mocked(searchWeb).mockResolvedValue([
      { title: "官方报告", url: "https://example.com/report", excerpt: "报告摘要" },
    ]);
    const project = createProject();
    const approve = vi.fn(() => true);
    const result = await createProposalToolRegistry({
      project,
      block,
      sourceContents: {},
      onDraft: () => undefined,
      onTodos: () => undefined,
      confirmWebSearch: approve,
    }).execute(
      { id: "call-2", name: "web_search", arguments: { query: "最新行业数据" } },
      new AbortController().signal,
    );

    expect(approve).toHaveBeenCalledWith("最新行业数据", "searxng");
    expect(searchWeb).toHaveBeenCalledWith("最新行业数据", project.search);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("https://example.com/report");
  });

  it("allows web search by default when no approval callback is provided", async () => {
    vi.mocked(searchWeb).mockResolvedValue([]);
    const result = await createProposalToolRegistry({
      project: createProject(), block, sourceContents: {}, onDraft: () => undefined, onTodos: () => undefined,
    }).execute({ id: "default-search", name: "web_search", arguments: { query: "LIMS" } }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(searchWeb).toHaveBeenCalledOnce();
  });

  it("reads only pages returned by the current search", async () => {
    vi.mocked(searchWeb).mockResolvedValue([{ title: "官方报告", url: "https://example.com/report", excerpt: "摘要" }]);
    vi.mocked(fetchKnowledgeWebPage).mockResolvedValue({ title: "官方报告", url: "https://example.com/report", markdown: "网页正文" });
    const tools = registry(() => true);
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
    const tools = registry(() => true);
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
      project, block, sourceContents: {}, onDraft: () => undefined, onTodos: () => undefined,
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
    const tools = createProposalToolRegistry({ project: createProject(), block, sourceContents: {}, onDraft: () => undefined, onTodos });
    const todos = [
      { content: "读取当前章节", status: "in_progress", activeForm: "正在读取当前章节" },
      { content: "检索知识库", status: "pending", activeForm: "正在检索知识库" },
    ];

    const result = await tools.execute({ id: "todo-1", name: "write_todo", arguments: { todos } }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(onTodos).toHaveBeenCalledWith(todos);
  });

  it("rejects plans with multiple active items", async () => {
    const tools = registry(() => true);
    const result = await tools.execute({ id: "todo-2", name: "write_todo", arguments: { todos: [
      { content: "读取章节", status: "in_progress", activeForm: "正在读取章节" },
      { content: "联网搜索", status: "in_progress", activeForm: "正在联网搜索" },
    ] } }, new AbortController().signal);

    expect(result).toEqual(expect.objectContaining({ isError: true, content: expect.stringContaining("最多只能有一个") }));
  });
});
