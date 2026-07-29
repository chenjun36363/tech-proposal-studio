import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../data";
import { searchWeb } from "../services/search";
import { fetchKnowledgeWebPage } from "../knowledge";
import type { DocumentBlock } from "../types";
import { buildEditorSelectionPrompt, createProposalToolRegistry } from "./proposalTools";

vi.mock("../services/search", () => ({ searchWeb: vi.fn() }));
vi.mock("../knowledge", async importOriginal => {
  const original = await importOriginal<typeof import("../knowledge")>();
  return { ...original, fetchKnowledgeWebPage: vi.fn() };
});

const block: DocumentBlock = {
  id: "block-1",
  sectionId: "当前章节",
  type: "text",
  content: "## 当前章节",
  order: 0,
  status: "draft",
  sourceRefs: [],
};

function registry(reviewDraft: () => boolean | Promise<boolean> = () => true) {
  const project = createProject();
  project.markdown = "# 方案\n\n## 当前章节";
  return createProposalToolRegistry({
    project,
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

describe("proposal agent document editing tools", () => {
  it("injects the captured selection into transient model context", () => {
    const prompt = buildEditorSelectionPrompt({
      start: 10,
      end: 14,
      text: "选中正文",
      scope: "section",
      sectionId: "背景",
      sectionTitle: "背景",
    });

    expect(prompt).toContain('"text": "选中正文"');
    expect(prompt).toContain("不得声称无法看到选区");
    expect(prompt).toContain("不得要求用户再次粘贴");
    expect(prompt).toContain("必须调用 propose_selection_update");
  });

  it("lists stable heading ids and reads an arbitrary proposal section", async () => {
    const tools = registry();
    const signal = new AbortController().signal;
    const outline = await tools.execute({ id: "outline", name: "get_proposal_outline", arguments: {} }, signal);
    const section = await tools.execute({ id: "section", name: "read_proposal_section", arguments: { heading_id: "当前章节" } }, signal);

    expect(outline.content).toContain('"id": "当前章节"');
    expect(section.content).toBe("## 当前章节");
  });

  it("registers selection tools only for a non-empty editor selection", async () => {
    const withoutSelection = registry();
    expect(withoutSelection.has("read_selected_text")).toBe(false);
    expect(withoutSelection.has("propose_selection_update")).toBe(false);

    const project = createProject();
    project.markdown = "# 方案\n\n## 当前章节\n\n原文";
    const start = project.markdown.indexOf("原文");
    const reviewDraft = vi.fn().mockResolvedValue(false);
    const tools = createProposalToolRegistry({
      project,
      block: { ...block, content: "## 当前章节\n\n原文" },
      selection: { start, end: start + 2, text: "原文", scope: "section", sectionId: "当前章节", sectionTitle: "当前章节" },
      reviewDraft,
      onTodos: () => undefined,
    });

    expect(tools.has("read_selected_text")).toBe(true);
    const read = await tools.execute({ id: "read-selection", name: "read_selected_text", arguments: {} }, new AbortController().signal);
    await tools.execute({ id: "update-selection", name: "propose_selection_update", arguments: { markdown: "新文", instruction: "精简选区" } }, new AbortController().signal);

    expect(read.content).toBe("原文");
    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({
      operation: "replace_selection",
      before: "原文",
      after: "新文",
      target: expect.objectContaining({ selectionStart: start, selectionEnd: start + 2 }),
    }), expect.any(AbortSignal));
  });

  it("creates reviewed insert and delete proposals and blocks H1 deletion", async () => {
    const project = createProject();
    project.markdown = "# 方案\n\n## 背景\n\n正文\n\n## 架构\n\n正文";
    const reviewDraft = vi.fn().mockResolvedValue(false);
    const tools = createProposalToolRegistry({
      project,
      block: { ...block, sectionId: "背景", content: "## 背景\n\n正文" },
      reviewDraft,
      onTodos: () => undefined,
    });
    const signal = new AbortController().signal;

    await tools.execute({ id: "insert", name: "propose_section_insert", arguments: { target_heading_id: "架构", position: "before", markdown: "## 安全\n\n安全正文", instruction: "补充安全" } }, signal);
    await tools.execute({ id: "delete", name: "propose_section_delete", arguments: { target_heading_id: "背景", instruction: "删除重复章节" } }, signal);
    const blocked = await tools.execute({ id: "delete-h1", name: "propose_section_delete", arguments: { target_heading_id: "方案", instruction: "删除标题" } }, signal);

    expect(reviewDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: "insert_section", target: expect.objectContaining({ sectionId: "架构", position: "before" }) }), signal);
    expect(reviewDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: "delete_section", target: expect.objectContaining({ sectionId: "背景" }) }), signal);
    expect(blocked).toEqual(expect.objectContaining({ isError: true, content: expect.stringContaining("不能删除文档 H1") }));
  });

  it("creates a chapter move proposal with source and destination snapshots", async () => {
    const project = createProject();
    project.markdown = "# 方案\n\n## 背景\n\n正文\n\n### 细节\n\n子正文\n\n## 架构\n\n架构正文";
    const reviewDraft = vi.fn().mockResolvedValue(false);
    const tools = createProposalToolRegistry({ project, block: { ...block, sectionId: "背景", content: "## 背景\n\n正文\n\n### 细节\n\n子正文" }, reviewDraft, onTodos: () => undefined });
    const signal = new AbortController().signal;

    await tools.execute({ id: "move", name: "propose_section_move", arguments: { source_heading_id: "背景", target_heading_id: "架构", position: "after", instruction: "先讲架构" } }, signal);
    const h1 = await tools.execute({ id: "move-h1", name: "propose_section_move", arguments: { source_heading_id: "方案", target_heading_id: "架构", position: "after", instruction: "移动标题" } }, signal);
    const self = await tools.execute({ id: "move-self", name: "propose_section_move", arguments: { source_heading_id: "背景", target_heading_id: "背景", position: "after", instruction: "移动" } }, signal);
    const descendant = await tools.execute({ id: "move-child", name: "propose_section_move", arguments: { source_heading_id: "背景", target_heading_id: "细节", position: "after", instruction: "移动" } }, signal);

    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({
      operation: "move_section",
      before: expect.stringContaining("子正文"),
      target: expect.objectContaining({ sectionId: "背景", destinationSectionId: "架构", position: "after", snapshot: expect.any(String), destinationSnapshot: expect.stringContaining("架构正文") }),
    }), signal);
    expect(h1.content).toContain("不能移动文档 H1");
    expect(self.content).toContain("不能将章节移动到自身");
    expect(descendant.content).toContain("不能将章节移动到其子章节内");
  });
});
