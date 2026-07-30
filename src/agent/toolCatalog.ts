export interface AgentToolCatalogItem {
  name: string;
  label: string;
  description: string;
  group: "文档读取" | "文档修改" | "知识与搜索" | "工作区" | "系统";
}

export const agentToolCatalog: AgentToolCatalogItem[] = [
  { name: "write_todo", label: "执行计划", description: "创建和更新任务执行计划", group: "文档读取" },
  { name: "ask_user", label: "向用户提问", description: "缺少关键上下文时给出三种方案并等待用户选择", group: "文档读取" },
  { name: "get_proposal_outline", label: "读取方案目录", description: "获取当前方案的标题结构", group: "文档读取" },
  { name: "read_current_section", label: "读取当前章节", description: "读取编辑器当前章节内容", group: "文档读取" },
  { name: "read_selected_text", label: "读取选中文本", description: "读取发送任务时选中的文本", group: "文档读取" },
  { name: "read_proposal_section", label: "读取指定章节", description: "按目录标识读取方案章节", group: "文档读取" },
  { name: "find_document_text", label: "查找文档文本", description: "在当前方案中搜索文本", group: "文档读取" },
  { name: "propose_section_update", label: "修改当前章节", description: "提交当前章节修改供用户审核", group: "文档修改" },
  { name: "propose_selection_update", label: "修改选中文本", description: "提交选区替换内容供用户审核", group: "文档修改" },
  { name: "propose_section_insert", label: "插入章节", description: "提交新增章节提案", group: "文档修改" },
  { name: "propose_section_move", label: "移动章节", description: "提交章节移动提案", group: "文档修改" },
  { name: "propose_section_delete", label: "删除章节", description: "提交章节删除提案", group: "文档修改" },
  { name: "insert_heading", label: "插入标题", description: "在当前文档中插入标题", group: "文档修改" },
  { name: "rename_document_title", label: "修改文档标题", description: "修改方案 H1 标题", group: "文档修改" },
  { name: "replace_document_text", label: "替换文档文本", description: "替换当前文档中的匹配文本", group: "文档修改" },
  { name: "search_knowledge", label: "检索知识库", description: "搜索工作区知识库资料", group: "知识与搜索" },
  { name: "read_knowledge", label: "读取知识资料", description: "读取知识库中的资料正文", group: "知识与搜索" },
  { name: "search_memory", label: "检索长期记忆", description: "搜索当前项目的长期记忆", group: "知识与搜索" },
  { name: "read_memory", label: "读取长期记忆", description: "读取一条长期记忆", group: "知识与搜索" },
  { name: "remember_project_fact", label: "写入长期记忆", description: "保存项目事实到长期记忆", group: "知识与搜索" },
  { name: "web_search", label: "联网搜索", description: "搜索互联网信息", group: "知识与搜索" },
  { name: "read_web_page", label: "读取网页", description: "读取搜索结果网页正文", group: "知识与搜索" },
  { name: "list_workspace_documents", label: "列出工作区文档", description: "列出工作区 Markdown 文档", group: "工作区" },
  { name: "create_blank_document", label: "新建空白文档", description: "创建并打开空白 Markdown", group: "工作区" },
  { name: "open_workspace_document", label: "打开工作区文档", description: "打开指定 Markdown 文档", group: "工作区" },
  { name: "save_current_document", label: "保存当前文档", description: "将当前内容写入磁盘", group: "工作区" },
  { name: "reload_current_document", label: "重新加载文档", description: "从磁盘重新读取当前文档", group: "工作区" },
  { name: "rename_current_document", label: "重命名文档文件", description: "重命名当前 Markdown 文件", group: "工作区" },
  { name: "delete_workspace_document", label: "删除工作区文档", description: "移除指定工作区文档", group: "工作区" },
  { name: "system_file_operation", label: "系统文件操作", description: "读写、移动或删除任意文件", group: "系统" },
  { name: "run_powershell", label: "运行 PowerShell", description: "执行 PowerShell 脚本", group: "系统" },
];

export const agentToolNames = new Set(agentToolCatalog.map(tool => tool.name));
