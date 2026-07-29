# TechProposal Studio 项目待办

> 最后整理：2026-07-29。本文档是根目录唯一的项目待办来源；实现细节发生变化时同步更新本文件。

## 执行原则

- 正文和索引默认留在本机；AI 只接收当前任务需要的正文和用户明确附加的资料。
- 所有 AI 正文修改先生成可审核提案，用户接受后才更新编辑器状态。
- 接受 AI 提案不直接写入工作区文件，磁盘写入继续由“保存”操作触发。
- API Key 不得写入项目 localStorage 缓存。
- 每项功能完成前补齐相应测试，并运行 `pnpm test` 和 `pnpm build`。

## P0 当前改动收尾

当前工作区已有章节删除、章节移动、自定义模板和 Agent 会话持久化相关改动，合并前需要统一收尾：

- [ ] 核对章节删除行为：禁止误删文档标题，删除父章节时包含全部子章节，删除后章节选择仍有效。
- [ ] 核对章节移动行为：不能移动到自己的子树中，移动后标题编号和目录同步更新。
- [ ] 为自定义模板补齐保存、读取、应用、删除和异常数据测试。
- [ ] 验证浏览器与桌面端的模板存储边界：浏览器使用 localStorage，桌面使用 `<workspace.root>/.gouan/templates/`。
- [ ] 完成 Agent 会话从 localStorage 迁移到工作区文件后的兼容、并发刷新和错误处理测试。
- [ ] 清理不应提交的运行数据，例如 `workspace/.gouan/*.db` 和 Agent 会话实例文件。
- [ ] 完成定向测试、全量测试和生产构建。

## P0 Agent 会话存储 SQLite 改造

目标：桌面端以 `<workspace.root>/.gouan/conversations.db` 作为 Agent 会话唯一真源；前端以内存运行态为即时数据源，通过增量事件同步持久化结果。发送、切换、新建、删除和修改会话开关均不得依赖整页刷新或整库重载。

### 存储模型

- [x] 新建独立 Rust `agent_conversations` 存储模块，不复用应用数据目录 `workspace.db`，也不混入记忆模块 `memory.db`。
- [x] 创建 `agent_conversation` 表：`id`、`project_id`、`title`、`summary`、三个会话开关、`created_at`、`updated_at`、`revision`。
- [x] 创建 `agent_conversation_message` 表：`conversation_id`、`sequence`、`role`、`message_json`、`created_at`，以 `(conversation_id, sequence)` 为主键并启用级联删除。
- [x] 创建 `agent_conversation_meta` 表记录 schema 版本和 JSON 迁移完成标记。
- [x] 为 `project_id + updated_at`、`conversation_id + sequence` 建立索引。
- [ ] 数据库连接启用 `foreign_keys`、`busy_timeout` 和 WAL；schema 升级必须在事务中完成并使用 `PRAGMA user_version`。
- [x] `message_json` 保留完整 `AgentMessage` 契约，避免拆散 tool call、tool result 和扩展字段；列表查询不得读取消息 JSON。

### Tauri 命令与事件

- [x] 增加 `agent_conversation_list(project_id, workspace_root)`，只返回会话摘要和开关。
- [x] 增加 `agent_conversation_get(id, workspace_root)`，按 `sequence` 返回单个完整会话。
- [x] 增加 `agent_conversation_upsert(input, workspace_root)`，在一个事务中更新元数据和消息；使用 `revision` 检测陈旧写入。
- [x] 增加 `agent_conversation_patch(id, patch, expected_revision)`，用于标题和会话开关的局部更新，不重写消息。
- [x] 增加 `agent_conversation_delete`、`agent_conversation_clear_project`，返回受影响 ID。
- [ ] 所有成功变更发送统一 `agent-conversations:changed` 事件，载荷使用 `upsert`、`delete`、`clear`，并携带 `projectId`、`conversationId`、摘要和 `revision`。
- [ ] 所有数据库操作放入阻塞线程；同一会话写入在前端继续串行排队，Rust 事务作为最终一致性边界。

### JSON 迁移与兼容

- [x] 首次打开工作区数据库时，如果未标记迁移且存在 `.gouan/agent-conversations.json`，解析、校验并在单个事务中导入。
- [ ] 按会话 ID 幂等导入；非法会话跳过并返回可见警告，不能导致整个数据库不可用。
- [x] 导入成功后写入迁移标记；旧 JSON 保留为只读备份，不再由新代码写入。
- [ ] localStorage 继续作为浏览器模式适配器；桌面端只在 SQLite 尚无数据且 JSON 迁移源不存在时执行一次 legacy localStorage 导入。
- [ ] 迁移失败时继续使用旧存储读取且禁止覆盖 JSON；修复后可安全重试。

### 前端运行态

- [ ] 将 `conversationStore.ts` 拆为统一接口和 Browser/SQLite 两个 adapter，React 组件不得直接调用 `invoke` 或读取 JSON。
- [ ] 建立按 `conversationId` 索引的运行时缓存，保存消息、事件、Todo、草稿审核、运行状态和 AbortController。
- [x] 切换会话优先同步激活运行时缓存；缓存未命中时只加载目标会话，不重新加载会话列表。
- [ ] 新建会话先乐观插入空运行态，再后台持久化；失败只回滚该会话。
- [x] 删除会话先局部移除，成功事件确认；删除当前会话时只激活内存中的下一条，不重新查询列表。
- [x] 会话开关先更新运行态并调用 `patch`；不得触发完整会话 upsert 或时间线重建。
- [ ] Agent 运行中的 token、工具事件和 Todo 只更新运行态；在稳定检查点或结束时持久化，不因切换面板而 abort。
- [ ] 订阅 Rust 增量事件并按 `revision` reconcile；忽略旧事件，禁止以整列表替换当前运行态。
- [ ] 限制闲置完整会话缓存数量并使用 LRU 淘汰；当前会话、运行中会话和待审核草稿不得淘汰。

### 测试与切换

- [ ] Rust 覆盖 schema 初始化、版本迁移、事务回滚、级联删除、分页列表、单会话读取和 revision 冲突。
- [ ] 覆盖 JSON 正常迁移、重复迁移、部分非法数据、空文件、损坏文件和 localStorage legacy 导入。
- [ ] 覆盖重叠保存严格串行、后写不被先写覆盖、失败写不推进 revision、数据库 busy 后可重试。
- [ ] 前端覆盖发送中切换会话、后台完成后回切、新建、删除、三个开关、外部增量事件和 LRU 淘汰。
- [ ] 增加回归断言：上述操作不得调用完整列表查询，不得卸载 Agent runner，不得触发页面 reload。
- [ ] 先以开发开关启用 SQLite adapter，完成真实工作区迁移验证后删除 JSON 写路径和临时开关。
- [ ] 完成 `pnpm test`、`pnpm build`、Rust 测试及 Tauri 手工流程，再清理 `.gouan/agent-conversations.json` 写命令。

## P1 Agent 文档编辑工具

目标：让 Agent 根据用户指令和当前编辑上下文，自动选择章节改写、选区修改、章节插入或章节删除工具；所有操作都必须经过审核。

### 统一编辑提案

- [ ] 将现有 `AgentDraft` 扩展为带操作类型和目标信息的统一编辑提案。
- [ ] 支持 `replace_section`、`replace_selection`、`insert_section`、`delete_section` 四种操作。
- [ ] 提案记录目标章节、原文快照、选区范围、修改说明和必要的基准校验信息。
- [ ] 接受提案前校验目标和原文快照；文档已变化时报告冲突，不覆盖新内容。

### Markdown 操作

- [ ] 在 `src/markdownDoc.ts` 提供插入章节、删除章节、替换选区和统一应用提案的纯函数。
- [ ] 插入章节支持指定章节的 `before` / `after` 位置，并保持 Markdown 间隔正确。
- [ ] 删除章节包含其正文和全部子章节，禁止通过 Agent 删除文档 H1。
- [ ] 插入或删除后按现有规则重新编号标题。
- [ ] 选区替换同时支持章节编辑和全文编辑模式。

### Agent 工具注册

- [x] 已有 `read_current_section` 和 `propose_section_update`，支持改写当前章节并等待用户审核。
- [ ] 增加 `read_selected_text` 和 `read_proposal_section`。
- [ ] 增加 `propose_selection_update`、`propose_section_insert`、`propose_section_delete`。
- [ ] 没有非空选区时不注册选区修改工具；没有有效章节时不暴露对应章节工具。
- [ ] 系统提示词明确工具选择规则，工具只提交提案，不得声称已经写入文件。

### 审核与应用

- [ ] 审核界面根据操作类型显示章节前后对照、选区前后对照、插入位置或删除警告。
- [ ] 接受一项提案只产生一条撤销记录。
- [ ] 应用后恢复合理的当前章节、光标和滚动位置。
- [ ] 覆盖接受、拒绝、取消、目标丢失、原文冲突和连续多次提案测试。

## P2 全文优化

目标：在单次编辑提案之上，提供“生成计划 -> 逐章优化 -> 分章审核或全文接受 -> 一致性复核”的长文档流程。

### 领域模型与章节解析

- [ ] 定义全文优化计划、章节上下文、章节草稿和优化会话类型。
- [ ] 为全文记录 `baseMarkdownHash`，为每章记录 `beforeHash`。
- [ ] MVP 会话只保存在 React 状态中；切换文件或关闭未处理任务前提示用户。
- [ ] 提供稳定的章节切分结果，记录标题、层级、正文范围和原始文本。
- [ ] 覆盖重复标题、空章节、中文标题、代码围栏内井号和无标题文档测试。

### 上下文与模型服务

- [ ] 规划阶段生成全文摘要、受众、写作规则、术语、关键事实和章节目标。
- [ ] 长文档先逐章摘要再汇总计划，并维护滚动摘要、术语和章节衔接信息。
- [ ] 按系统规则、全文摘要、当前章节、相邻章节和明确附加资料的顺序分配上下文预算。
- [ ] 超出预算时优先裁剪低优先级资料，不静默裁剪当前章节原文。
- [ ] 增加生成全文计划、生成章节草稿和一致性检查的模型服务接口。
- [ ] Browser/Tauri 使用相同请求契约，并支持取消、单章失败重试和结构化响应校验。

### 交互与安全应用

- [ ] AI 面板增加 `当前章节` / `全文` 作用范围切换。
- [ ] 全文模式先展示计划，用户确认后再逐章调用模型。
- [ ] 展示任务总进度、章节状态、失败原因、停止和重试操作。
- [ ] 支持单章接受/拒绝以及接受全部/拒绝全部。
- [ ] “结构优化”默认关闭；关闭时禁止模型改变标题和章节顺序。
- [ ] 用户在生成期间修改章节时立即标记冲突，旧草稿不得静默覆盖新内容。
- [ ] 接受全部前在内存中完成全部校验和 Markdown 合成，再一次性更新项目状态。
- [ ] 失败或冲突章节默认不进入“接受全部”，确认时列出遗漏章节。

### 最终复核与验收

- [ ] 本地检查标题层级和编号、代码围栏、表格、图片及链接结构。
- [ ] 模型一致性检查先使用目录、摘要、术语和关键事实，只按疑点补充章节片段。
- [ ] 一致性问题作为建议展示，不自动二次改写已接受正文。
- [ ] 使用至少 9 章的真实方案完成一次浏览器和一次 Tauri 手工流程。
- [ ] 验证未明确附加的资料不会进入模型上下文，API Key 不会进入项目缓存。

## P3 桌面与交付验证

- [ ] 在安装 Rust stable、MSVC 和 WebView2 的 Windows 环境运行 `pnpm tauri dev`。
- [ ] 验证系统凭据、工作区 SQLite、文件打开/保存、图片资源、PTY 终端和受控命令。
- [ ] 运行 `pnpm tauri build`，验证 NSIS/MSI 安装产物和升级路径。
- [ ] 使用实际 Word 阅读器检查 DOCX 的标题、目录、表格、本地图片、分页和中文字体效果。

## 全文优化 MVP 暂不包含

- AI 自动写入工作区 Markdown 文件。
- 跨设备或跨会话恢复正在生成的全文任务。
- 多模型并行优化同一文档。
- 未经审核的自动章节重排、删除或新增。

