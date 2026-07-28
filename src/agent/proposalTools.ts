import type { AgentDraft } from "./protocol";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";
import type { DocumentBlock, Project } from "../types";
import { searchWeb } from "../services/search";

import { fetchKnowledgeWebPage, getKnowledgeSectionScope, searchKnowledge } from "../knowledge";
import { proposeProjectMemory, readProjectMemory, searchProjectMemories } from "./memoryService";
const text = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数：${field}`);
  return value.trim();
};

export const proposalAgentSystemPrompt = `你是“构案”中的软件技术方案 Agent。你的职责是基于当前方案和明确提供的资料，完成可审计的方案写作任务。

工作规则：
1. 先调用 read_current_section 理解当前章节，再决定后续动作。
2. 需要事实依据时，优先使用用户明确加入上下文的资料；仍不足时用 search_knowledge 检索知识库，再用 read_knowledge 阅读相关章节。
3. 规划工具可用时，首轮先用 write_todo 列出完整计划。每次调用都必须提交完整清单；始终仅有一个 in_progress，完成一步后立即更新，再开始下一步。
4. 正文修改只能通过 propose_section_update 提交，禁止声称已经直接写入文件。
5. propose_section_update 必须返回可完整替换当前章节的 Markdown，保留正确的标题行。
6. 不编造资料中不存在的事实；缺少关键输入时在最终回复中明确列出待确认项。
7. 提交修改后，用一句简短总结说明改动依据，不要重复输出整篇正文。
8. 用户明确加入的资料已直接提供在系统上下文中；其他知识先 search_knowledge，再 read_knowledge。
9. 联网搜索可用时，仅在本地资料和知识库不足以回答时调用 web_search。需要搜索时直接调用工具，不要在回复文本中询问用户是否同意查询。搜索次数不得超过系统配置的单任务上限，每次任务最多阅读 3 个网页；优先选择政府、标准组织和厂商官方来源，达到足够依据后立即停止检索并完成用户任务，不要遍历全部结果或重复查询。需要依据网页正文时调用 read_web_page，不能只根据搜索摘要下结论。
10. 只有跨会话仍有价值的事实、偏好或决策，才可调用 remember_project_fact 提出待审核记忆；不得声称记忆已被用户确认。`;

export function createProposalToolRegistry(params: {
  project: Project;
  block: DocumentBlock;
  reviewDraft: (draft: AgentDraft, signal: AbortSignal) => boolean | Promise<boolean>;
  onTodos: (todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }>) => void;
}) {
  const { project, block } = params;
  let currentBlockContent = block.content;
  const searchableWebUrls = new Set<string>();
  const searchedQueries = new Set<string>();
  const readWebUrls = new Set<string>();
  const webSearchMaxCalls = Math.max(1, Math.min(10, Math.round(project.agent?.webSearchMaxCalls ?? 2)));
  let webSearchCalls = 0;
  const registry = new AgentToolRegistry();
  return registry
    .register({
      definition: { type: "function", function: { name: "read_current_section", description: "读取当前正在编辑的技术方案章节。", parameters: objectSchema({}) } },
      execute: () => ({ content: currentBlockContent || "（当前章节为空）", data: { blockId: block.id }, isError: false }),
    })
    .register({
      definition: { type: "function", function: { name: "get_proposal_outline", description: "读取整篇技术方案的 Markdown 标题目录。", parameters: objectSchema({}) } },
      execute: () => {
        const headings = project.markdown.split(/\r?\n/).filter(line => /^#{1,6}\s+/.test(line));
        return { content: headings.join("\n") || "（尚无标题）", data: { count: headings.length }, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "web_search", description: `联网搜索当前或外部信息。仅在已有资料不足时使用；启用后查询默认直接执行。本次任务最多调用 ${webSearchMaxCalls} 次。`, parameters: objectSchema({ query: { type: "string", description: "将发送给搜索服务的完整查询词" } }, ["query"]) } },
      execute: async args => {
        const query = text(args.query, "query");
        const normalizedQuery = query.toLocaleLowerCase();
        if (searchedQueries.has(normalizedQuery)) return { content: "该查询已执行过，请使用之前的搜索结果并继续完成任务。", data: { query, duplicate: true }, isError: true };
        if (webSearchCalls >= webSearchMaxCalls) return { content: `本次任务已达到 ${webSearchMaxCalls} 次联网搜索上限，请使用已有结果并继续完成任务。`, data: { query, limitReached: true }, isError: true };
        searchedQueries.add(normalizedQuery);
        webSearchCalls += 1;
        const results = await searchWeb(query, project.search);
        if (webSearchCalls >= webSearchMaxCalls) registry.unregister("web_search");
        const rows = results.map(({ title, url, excerpt }) => ({ title, url, excerpt }));
        rows.forEach(result => searchableWebUrls.add(result.url));
        return { content: rows.length ? JSON.stringify(rows, null, 2) : "联网搜索没有返回结果。", data: { query, approved: true, results: rows }, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "read_web_page", description: "读取 web_search 返回的网页正文并转换为 Markdown。只能读取当前任务搜索结果中的 URL。", parameters: objectSchema({ url: { type: "string", description: "web_search 返回的完整 URL" } }, ["url"]) } },
      execute: async args => {
        const url = text(args.url, "url");
        if (!searchableWebUrls.has(url)) return { content: "只能读取本次 web_search 返回的网页 URL。", data: { url }, isError: true };
        if (readWebUrls.has(url)) return { content: "该网页已经阅读过，请使用之前返回的正文并继续完成任务。", data: { url, duplicate: true }, isError: true };
        if (readWebUrls.size >= 3) return { content: "本次任务已达到 3 个网页的阅读上限，请基于已读内容继续完成任务。", data: { url, limitReached: true }, isError: true };
        readWebUrls.add(url);
        const page = await fetchKnowledgeWebPage(url);
        const maxChars = 30000;
        const markdown = page.markdown.slice(0, maxChars);
        const truncated = page.markdown.length > maxChars;
        return {
          content: `# ${page.title}\n\n来源：${page.url}\n\n${markdown}${truncated ? "\n\n[网页正文过长，已截断]" : ""}`,
          data: { title: page.title, url: page.url, chars: markdown.length, truncated },
          isError: false,
        };
      },
    })
    .register({
      definition: { type: "function", function: { name: "search_knowledge", description: "检索桌面工作区知识库。用于查找尚未手动加入上下文的资料。", parameters: objectSchema({ query: { type: "string", description: "检索关键词" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]) } },
      execute: async args => {
        if (!project.workspace?.root) return { content: "当前项目尚未配置工作区，无法检索知识库。", isError: true };
        const query = text(args.query, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(10, Math.floor(args.limit))) : 5;
        const results = await searchKnowledge(project.workspace, query, ["good", "normal"], undefined, limit);
        const rows = results.map(item => ({ sectionId: item.scopeSectionId, document: item.chunk.documentTitle, heading: item.chunk.headingPath, excerpt: item.excerpt }));
        return { content: rows.length ? JSON.stringify(rows, null, 2) : "知识库中没有匹配内容。", data: rows, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "read_knowledge", description: "读取 search_knowledge 返回的知识库章节正文。", parameters: objectSchema({ section_id: { type: "string", description: "知识库章节 ID" } }, ["section_id"]) } },
      execute: async args => {
        if (!project.workspace?.root) return { content: "当前项目尚未配置工作区，无法读取知识库。", isError: true };
        const scope = await getKnowledgeSectionScope(project.workspace, text(args.section_id, "section_id"));
        return { content: `# ${scope.documentTitle} / ${scope.headingPath}\n\n${scope.content}`, data: { sectionId: scope.id, documentId: scope.documentId }, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "search_memory", description: "检索本项目跨会话保存的长期记忆。", parameters: objectSchema({ query: { type: "string" } }, ["query"]) } },
      execute: async args => {
        const rows = await searchProjectMemories(project, text(args.query, "query"));
        const result = rows.map(item => ({ id: item.id, title: item.title, type: item.memoryType, excerpt: item.content.slice(0, 180) }));
        return { content: result.length ? JSON.stringify(result, null, 2) : "没有匹配的项目记忆。", data: result, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "read_memory", description: "根据记忆 ID 读取一条项目长期记忆的完整内容。", parameters: objectSchema({ id: { type: "string", description: "记忆 ID" } }, ["id"]) } },
      execute: async args => {
        const memory = await readProjectMemory(project, text(args.id, "id"));
        return { content: `# ${memory.title}\n\n${memory.content}`, data: memory, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "remember_project_fact", description: "提出一条待用户审核的长期记忆。不得保存密钥、临时步骤、知识库原文、工具日志或可直接从方案读取的普通事实。", parameters: objectSchema({ title: { type: "string", description: "简短语义标题" }, content: { type: "string", description: "一条自包含的稳定事实" }, memory_type: { type: "string", enum: ["decision", "preference", "constraint", "fact", "reference"] } }, ["title", "content", "memory_type"]) } },
      execute: async args => {
        const memory = await proposeProjectMemory(project, { title: text(args.title, "title"), content: text(args.content, "content"), memoryType: text(args.memory_type, "memory_type") as "decision" | "preference" | "constraint" | "fact" | "reference" });
        return { content: `已生成待审核记忆：${memory.title}。用户可在设置 > 记忆中确认。`, data: memory, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "write_todo", description: "创建或更新本次任务的执行计划。每次调用会完整替换旧清单；必须提交全部计划项，且最多一个项目为 in_progress。", parameters: objectSchema({ todos: { type: "array", items: { type: "object", properties: { content: { type: "string", description: "任务的命令式描述" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string", description: "任务进行中时显示的描述" } }, required: ["content", "status", "activeForm"], additionalProperties: false } } }, ["todos"]) } },
      execute: args => {
        if (!Array.isArray(args.todos)) throw new Error("write_todo 需要 todos 数组。");
        const todos = args.todos.map<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm: string }>((item, index) => {
          if (!item || typeof item !== "object") throw new Error(`todos[${index}] 必须是对象。`);
          const todo = item as Record<string, unknown>;
          if (typeof todo.content !== "string" || !todo.content.trim()) throw new Error(`todos[${index}].content 不能为空。`);
          const status = todo.status;
          if (status !== "pending" && status !== "in_progress" && status !== "completed") throw new Error(`todos[${index}].status 无效。`);
          if (typeof todo.activeForm !== "string" || !todo.activeForm.trim()) throw new Error(`todos[${index}].activeForm 不能为空。`);
          return { content: todo.content.trim(), status, activeForm: todo.activeForm.trim() };
        });
        if (todos.filter(todo => todo.status === "in_progress").length > 1) throw new Error("执行计划最多只能有一个 in_progress 项目。");
        params.onTodos(todos);
        const completed = todos.filter(todo => todo.status === "completed").length;
        return { content: `计划已更新（${completed}/${todos.length} 已完成）。`, data: todos, isError: false };
      },
    })
    .register({
      definition: { type: "function", function: { name: "propose_section_update", description: "提交完整的当前章节 Markdown 修改稿，供用户查看差异并决定是否接受。不会直接写入文件。", parameters: objectSchema({ markdown: { type: "string", description: "可完整替换当前章节的 Markdown" }, instruction: { type: "string", description: "本次修改的简短说明" } }, ["markdown", "instruction"]) } },
      execute: async (args, signal) => {
        const after = text(args.markdown ?? args.content, "markdown");
        const instruction = typeof args.instruction === "string" && args.instruction.trim() ? args.instruction.trim() : "优化当前章节";
        const draft: AgentDraft = { callId: crypto.randomUUID(), before: currentBlockContent, after, instruction };
        const approved = await params.reviewDraft(draft, signal);
        if (approved) currentBlockContent = after;
        return {
          content: approved
            ? "用户已接受修改稿。不要再次输出完整正文，请简要总结修改依据。"
            : "用户已拒绝修改稿。请尊重该决定，必要时询问修改方向或结束任务。",
          data: { instruction, beforeChars: draft.before.length, afterChars: after.length, approved },
          isError: false,
        };
      },
    });
}
