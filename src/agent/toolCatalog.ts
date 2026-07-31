export type AgentToolGroupId = "planning" | "skills" | "document-read" | "document-edit" | "knowledge" | "memory" | "web" | "workspace" | "git-read" | "git-write" | "system";

export interface AgentToolGroup {
  id: AgentToolGroupId;
  label: string;
  description: string;
}

export const agentToolGroups: AgentToolGroup[] = [
  { id: "planning", label: "规划与协作", description: "制定执行计划并在关键信息不足时向用户提问" },
  { id: "skills", label: "技能", description: "按需读取已启用 Skill 并执行受控技能命令" },
  { id: "document-read", label: "方案读取", description: "读取目录、章节、选区并查找方案文本" },
  { id: "document-edit", label: "方案编辑", description: "提交章节、选区和文档结构修改" },
  { id: "knowledge", label: "知识库", description: "检索和阅读工作区知识资料" },
  { id: "memory", label: "长期记忆", description: "检索、读取和提出项目记忆" },
  { id: "web", label: "联网访问", description: "搜索互联网并读取搜索结果网页" },
  { id: "workspace", label: "工作区文档", description: "创建、打开、保存、重命名和删除 Markdown 文档" },
  { id: "git-read", label: "Git 读取", description: "查看仓库状态、差异、历史和分支" },
  { id: "git-write", label: "Git 变更", description: "经逐项审批后暂存、提交、切换分支或访问远程" },
  { id: "system", label: "系统访问", description: "完全访问模式下操作系统文件或执行 PowerShell" },
];

export interface AgentToolCatalogItem {
  name: string;
  label: string;
  description: string;
  group: AgentToolGroupId;
}

export const agentToolCatalog: AgentToolCatalogItem[] = [
  { name: "write_todo", label: "执行计划", description: "创建和更新任务执行计划", group: "planning" },
  { name: "ask_user", label: "向用户提问", description: "缺少关键上下文时给出三种方案并等待用户选择", group: "planning" },
  { name: "skills_manager", label: "Skill 管理器", description: "列出并按需读取项目配置启用的 Skill", group: "skills" },
  { name: "skill_run_command", label: "Skill 命令", description: "运行已启用 Skill 所需的受控命令", group: "skills" },
  { name: "get_proposal_outline", label: "读取方案目录", description: "获取当前方案的标题结构", group: "document-read" },
  { name: "read_current_section", label: "读取当前章节", description: "读取编辑器当前章节内容", group: "document-read" },
  { name: "read_selected_text", label: "读取选中文本", description: "读取发送任务时选中的文本", group: "document-read" },
  { name: "read_proposal_section", label: "读取指定章节", description: "按目录标识读取方案章节", group: "document-read" },
  { name: "find_document_text", label: "查找文档文本", description: "在当前方案中搜索文本", group: "document-read" },
  { name: "propose_section_update", label: "修改当前章节", description: "提交当前章节修改供用户审核", group: "document-edit" },
  { name: "propose_selection_update", label: "修改选中文本", description: "提交选区替换内容供用户审核", group: "document-edit" },
  { name: "propose_section_insert", label: "插入章节", description: "提交新增章节提案", group: "document-edit" },
  { name: "propose_section_move", label: "移动章节", description: "提交章节移动提案", group: "document-edit" },
  { name: "propose_section_delete", label: "删除章节", description: "提交章节删除提案", group: "document-edit" },
  { name: "insert_heading", label: "插入标题", description: "在当前文档中插入标题", group: "document-edit" },
  { name: "rename_document_title", label: "修改文档标题", description: "修改方案 H1 标题", group: "document-edit" },
  { name: "replace_document_text", label: "替换文档文本", description: "替换当前文档中的匹配文本", group: "document-edit" },
  { name: "search_knowledge", label: "检索知识库", description: "搜索工作区知识库资料", group: "knowledge" },
  { name: "read_knowledge", label: "读取知识资料", description: "读取知识库中的资料正文", group: "knowledge" },
  { name: "search_memory", label: "检索长期记忆", description: "搜索当前项目的长期记忆", group: "memory" },
  { name: "read_memory", label: "读取长期记忆", description: "读取一条长期记忆", group: "memory" },
  { name: "remember_project_fact", label: "写入长期记忆", description: "保存项目事实到长期记忆", group: "memory" },
  { name: "web_search", label: "联网搜索", description: "搜索互联网信息", group: "web" },
  { name: "read_web_page", label: "读取网页", description: "读取搜索结果网页正文", group: "web" },
  { name: "list_workspace_documents", label: "列出工作区文档", description: "列出工作区 Markdown 文档", group: "workspace" },
  { name: "create_blank_document", label: "新建空白文档", description: "创建并打开空白 Markdown", group: "workspace" },
  { name: "open_workspace_document", label: "打开工作区文档", description: "打开指定 Markdown 文档", group: "workspace" },
  { name: "save_current_document", label: "保存当前文档", description: "将当前内容写入磁盘", group: "workspace" },
  { name: "reload_current_document", label: "重新加载文档", description: "从磁盘重新读取当前文档", group: "workspace" },
  { name: "rename_current_document", label: "重命名文档文件", description: "重命名当前 Markdown 文件", group: "workspace" },
  { name: "delete_workspace_document", label: "删除工作区文档", description: "移除指定工作区文档", group: "workspace" },
  { name: "git_status", label: "Git 状态", description: "读取仓库和文件变更状态", group: "git-read" },
  { name: "git_diff", label: "Git 差异", description: "读取文件的工作区或暂存区差异", group: "git-read" },
  { name: "git_log", label: "Git 历史", description: "读取最近提交记录", group: "git-read" },
  { name: "git_show_commit", label: "提交详情", description: "读取指定提交和补丁", group: "git-read" },
  { name: "git_list_branches", label: "Git 分支", description: "列出本地和远程分支", group: "git-read" },
  { name: "git_stage", label: "暂存更改", description: "暂存文件或全部变更，执行前审批", group: "git-write" },
  { name: "git_unstage", label: "取消暂存", description: "取消暂存文件或全部变更，执行前审批", group: "git-write" },
  { name: "git_commit", label: "创建提交", description: "提交暂存区，执行前审批", group: "git-write" },
  { name: "git_create_branch", label: "创建分支", description: "创建并切换本地分支，执行前审批", group: "git-write" },
  { name: "git_switch_branch", label: "切换分支", description: "切换本地或远程分支，执行前审批", group: "git-write" },
  { name: "git_stash_push", label: "保存 stash", description: "保存工作区变更，执行前审批", group: "git-write" },
  { name: "git_stash_pop", label: "应用 stash", description: "应用最近 stash，执行前审批", group: "git-write" },
  { name: "git_fetch", label: "获取远程更新", description: "执行 fetch，执行前审批", group: "git-write" },
  { name: "git_pull", label: "拉取远程更新", description: "执行 fast-forward pull，执行前审批", group: "git-write" },
  { name: "git_push", label: "推送当前分支", description: "推送到 origin，执行前审批", group: "git-write" },
  { name: "system_file_operation", label: "系统文件操作", description: "读写、移动或删除任意文件", group: "system" },
  { name: "run_powershell", label: "运行 PowerShell", description: "执行 PowerShell 脚本", group: "system" },
];

export const agentToolNames = new Set(agentToolCatalog.map(tool => tool.name));
