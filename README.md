# TechProposal Studio（构案）

本地优先的软件技术方案编写桌面工具。支持模板化章节、自由内容块、知识库引用、OpenAI-compatible AI 优化、SearXNG/Brave 搜索和受控 CLI 任务。

## 运行

```powershell
pnpm install
pnpm dev
```

桌面端还需要 Rust stable 和 Windows WebView2，然后运行 `pnpm tauri dev`。浏览器开发模式使用 `localStorage`；Tauri 模式由 Rust 后端处理模型请求、系统凭据、SQLite 和受控进程。

## 构建 Windows EXE

安装 Rust stable（MSVC 工具链）以及 Visual Studio Build Tools 的“使用 C++ 的桌面开发”工作负载后，执行：

```powershell
pnpm install
pnpm build:exe
```

脚本会初始化 MSVC 编译环境，并只生成 NSIS 安装程序。构建产物位于 `src-tauri/target/release/bundle/nsis/*.exe`。

正文和索引默认留在本机。方案正文优化只发送当前内容块和明确加入的引用；知识文档结构识别可能发送低置信度标题及相邻上下文，但知识入库和索引不会把正文切片发送给模型。联网搜索执行前显示实际查询词。项目缓存始终剥离 API Key；工作区连接配置可按用户设置将密钥保存在 `.gouan/connections.json`，桌面端同时镜像到 OS keyring。

## 代码架构

项目采用 React 前端与 Tauri Rust 后端共用领域模型的双运行时架构。浏览器模式用于快速开发和基础功能预览；桌面模式提供文件系统、SQLite、系统凭据、PTY 终端和受控进程能力。

```text
tech-proposal-studio/
├─ src/
│  ├─ App.tsx                         # 顶层布局、面板编排和应用级弹窗
│  ├─ hooks/
│  │  ├─ useProposalDocumentController.ts # Project 状态、保存、撤销/重做
│  │  ├─ useWorkspaceSession.ts           # 工作区启动、配置应用和资料刷新
│  │  ├─ useProposalFileActions.ts        # 方案打开、保存、导入和重命名
│  │  ├─ useEnvironmentTools.ts            # CLI 检测、安装与任务执行状态
│  │  └─ useSourcePreview.ts               # 资料预览加载与生命周期
│  ├─ features/
│  │  ├─ inspector/                   # AI、资料、任务、终端检查器
│  │  ├─ knowledge/                   # 知识管理与工作区资料转移
│  │  ├─ search/                      # 联网搜索、快捷链接与资料入库
│  │  └─ environment/                 # 环境检查视图
│  ├─ components/                     # 通用及工作流组件
│  ├─ agent/                          # Agent 协议、执行器与工具注册
│  ├─ services/
│  │  ├─ model.ts                     # 模型 Browser/Tauri Adapter
│  │  ├─ search.ts                    # 搜索 Browser/Tauri Adapter
│  │  ├─ system.ts                    # 文件交付、命令与终端能力
│  │  └─ runtime.ts                   # 桌面运行时识别
│  ├─ workspace.ts                    # 工作区服务
│  ├─ markdownDoc.ts                  # Markdown 结构与编号
│  ├─ docxExport.ts                   # Word 导出
│  └─ index.css                       # 主题、基础布局和共享样式
└─ src-tauri/src/
   ├─ lib.rs                          # Tauri 命令注册与共享基础能力
   ├─ model.rs                        # 模型请求、鉴权与流式输出
   ├─ credentials.rs                  # keyring 与旧服务名迁移
   ├─ search.rs                       # SearXNG/Brave 搜索代理
   ├─ export.rs                       # Markdown/DOCX 文件交付
   ├─ system.rs                       # 外部链接系统调用
   ├─ process.rs                      # 受控命令执行与工具检测
   ├─ terminal.rs                     # PowerShell PTY 生命周期
   ├─ mineru.rs                       # MinerU 文档转换
   ├─ knowledge.rs                    # 知识库应用流程与查询命令
   └─ knowledge/
      ├─ parser.rs                    # Markdown 章节解析与切片
      ├─ headings.rs                  # 标题候选识别与规范化
      ├─ repository.rs                # Repository 接口、连接与迁移
      └─ repository/
         ├─ indexing.rs               # 原子索引替换与质量继承
         └─ queries.rs                # 文档、章节、切片与 FTS5 查询
```

### 前端职责边界

- `App.tsx` 负责组合顶栏、三栏工作区、右侧页签和应用级弹窗；文档状态及工作区副作用通过 hooks 暴露的接口接入。
- `useProposalDocumentController` 是当前 `Project` 状态的控制入口，集中处理 Markdown 元数据同步、500ms 防抖持久化以及撤销/重做。
- `useWorkspaceSession` 负责运行时启动、工作区配置、连接加载和文件清单；`useProposalFileActions` 只负责当前方案的磁盘生命周期。
- `useKnowledgeTransfer` 拥有方案文件转入知识库时的保存、移动、刷新和界面切换流程。
- `useEnvironmentTools` 隐藏桌面 CLI 检测、Agent 安装、环境任务执行以及每项输出状态；环境弹窗只消费一个 controller 接口。
- `useSourcePreview` 集中资料内容的加载、错误处理和预览开关，检查器与应用级预览不再各自维护一套状态。
- `InspectorPanel` 拥有知识筛选、章节范围展开、质量标记和上下文选择；`WebSearchModal` 拥有查询确认、快捷链接和网页资料入库流程。
- `features` 下的组件拥有对应交互状态和专属样式；基础 tokens、通用控件和整体布局保留在 `index.css`。
- 浏览器与桌面是两个真实 Adapter；React 调用方不判断具体命令实现。
- React 组件不直接依赖 Tauri `invoke`。模型与搜索通过各自 Module 内的 Browser/Tauri Adapter 接入；桌面文件能力通过 `workspace.ts` 或 `services/system.ts` 暴露。

当前没有引入额外全局状态库。项目编辑状态仍以单个 `Project` 为核心，通过领域 hook 收敛写入入口；只有出现多个独立页面共享服务端缓存等需求时，才考虑增加新的状态基础设施。

### Rust 职责边界

- `lib.rs` 保留 Tauri command 注册、工作区基础类型和少量共享文件能力。
- `model.rs` 封装模型端点校验、密钥解析、请求头、上游错误和流式响应。
- `credentials.rs` 独立管理 keyring 读取、写入和旧服务名迁移；`search.rs` 与 `export.rs` 分别拥有搜索代理和导出交付。
- `process.rs` 封装可执行程序白名单、Windows npm shim、工作目录、命令历史表和命令输出事件。
- `terminal.rs` 管理 PTY 会话以及打开、写入、调整大小和关闭操作。
- `knowledge.rs` 编排知识导入、结构确认、搜索和质量标记；解析、标题识别和数据库访问分别下沉到 `knowledge/` 子模块。
- `knowledge/repository.rs` 是知识持久化的唯一 Repository 接口；索引写入与查询实现继续收敛在其内部子模块，应用流程不直接接触 SQL 或数据库连接。

新增桌面能力时，应先扩展前端服务接口，再实现对应 Tauri command；不要从 React 页面直接创建仅桌面可用的调用路径。

### 状态与持久化

```text
React Project state
  ├─ 500ms debounce → localStorage 项目缓存（剥离 API Key）
  ├─ 当前 Markdown → workspace.root 下打开的 .md 文件
  ├─ contextSourceRefs → 用户明确加入的项目级 AI 上下文
  ├─ 连接配置 → workspace.root/.gouan/connections.json
  ├─ 系统凭据镜像 → OS keyring
  └─ 知识索引 → workspace.root/.gouan/knowledge.db
```

磁盘中的当前 Markdown 是桌面工作区正文的事实来源，`localStorage` 只承担恢复缓存，不应替代明确的文件保存。
旧项目中的 `sections[0].blocks[0].sourceRefs` 会在读取时迁移到 `contextSourceRefs`；运行态与新缓存不再保留 legacy `sections` 正文结构。

## 知识库存储与索引

桌面端建立知识库索引后，原文和索引都保存在当前工作目录中：

```text
<workspace.root>/
├─ .gouan/
│  ├─ knowledge.db          # SQLite 知识库索引
│  └─ backups/knowledge/    # 结构规范化前的 Markdown 备份
└─ knowledge/
   ├─ *.md                  # 导入的 Markdown 原文
   └─ web/*.md              # 网页正文转换得到的 Markdown
```

其中 `.gouan/knowledge.db` 使用 SQLite 存储结构化数据：

- `knowledge_documents`：文档来源、原文件路径、内容指纹和索引状态。
- `knowledge_sections`：从 Markdown 标题解析出的章节层级和标题路径。
- `knowledge_chunks`：按章节和长度切分的正文、字符位置及人工质量状态。
- `knowledge_chunk_sections`：正文切片与章节之间的关联。
- `knowledge_chunk_fts`：基于 SQLite FTS5 的全文倒排索引，分别保存文档标题、章节路径和正文。

知识文档路径统一以 `workspace.root` 为基准保存为相对路径，例如 `knowledge/方案.md`、`knowledge/web/网页.md`。旧版 `history/` 路径会自动迁移到 `knowledge/`，从其他环境迁移工作区时也不依赖原机器盘符和目录。

中文内容先使用 Jieba 分词，再将文档标题、章节路径和正文分别写入 FTS5。知识检索可以组合选择这些字段作为搜索范围；未指定范围时搜索全部字段。搜索时使用列限定的 FTS5 `MATCH` 和 BM25 排序，并对标题、章节路径或正文直接包含查询词的结果加权。

知识片段质量分为优质（`good`）、普通（`normal`）和劣质（`bad`）。新建及旧数据库迁移后的片段默认为普通。知识检索默认包含优质和普通、排除劣质，并先按优质、普通、劣质排序，同一质量内再按 BM25 相关度排序。用户可以在检索条件中选择状态，也可以在搜索结果中修改片段质量；质量标记存储在 `knowledge_chunks.quality`。

当前知识库采用关键词全文检索，不生成 embedding，也不使用向量数据库。浏览器开发模式不建立这套桌面端 SQLite 知识库索引。

## 知识文档结构识别

知识管理中的“识别结构”用于在建立索引前确认 Markdown 的章节层级。当前流程如下：

```text
选择 Markdown
  → 确保文件位于 workspace.historyDir
  → 本地扫描标题候选
  → 可选 AI 判断低置信度候选
  → 用户确认标题及 H1-H6 层级
  → 备份原文并规范化 Markdown
  → 按确认后的结构切片并建立本地索引
```

### 本地候选识别

系统按行读取 Markdown，并按照以下规则生成标题候选：

- 已有 Markdown 标题（`#` 至 `######`）直接保留，默认选中，置信度为 `1.0`，用户不能取消或修改其层级。
- `第N章`、`第一章`等章标题识别为 H1。
- `1.1`、`1.1.1`等点分编号按编号深度推断为 H2、H3，以此类推，最高为 H6。候选必须不超过 120 个字符，并且不能以句号或分号结尾。
- 文档前 500 行内如果存在至少 3 个 `[#_Toc]` 形式的 Word 目录链接，则将其视为目录。系统在正文中查找同名行，并采用目录推断出的层级，默认置信度为 `0.98`。
- 独占一行、前后为空行、长度不超过 80 个字符的 Markdown 粗体短行会作为低置信度候选，默认不选中，初始层级为 H2，置信度为 `0.45`。

扫描会忽略代码围栏中的内容、已识别的目录区域、Markdown 表格行以及链接行。标题比较前会清理空白字符、粗体标记、标题井号和 Word 目录链接格式。

### AI 辅助判断

只有存在低置信度粗体候选时才调用配置的 OpenAI-compatible 模型：

- 每次最多发送 80 个候选。
- 每个候选包含候选文字、原始行号及前后各约 2 行上下文，不发送整篇文档。
- 模型只负责返回候选是否为标题及建议的 H1-H6 层级，不改写原文。
- 模型请求使用连接配置中的 `timeoutMs`；请求完成或超时后，前端才显示结构确认弹窗。
- 未配置模型或 API Key、模型调用失败、超时或返回内容不是有效 JSON 时，本地识别结果仍会保留，错误显示在确认弹窗中。

### 人工确认与写回

结构确认弹窗左侧显示全部候选，右侧显示选中标题组成的章节树。用户可以选中或取消非原生 Markdown 候选，并调整其 H1-H6 层级；弹窗会提示低置信度候选和标题层级跳跃。

确认后，系统执行以下操作：

1. 将原 Markdown 备份到 `.gouan/backups/knowledge/<document-id>/`。
2. 给选中的非 Markdown 标题行添加对应数量的 `#`；已有 Markdown 标题保持原样。
3. 在已识别的 Word 目录前后写入 `<!-- knowledge-toc:start -->` 和 `<!-- knowledge-toc:end -->`，使目录保留在原文中但不参与章节切片。
4. 将规范化后的 Markdown 写回 `knowledge` 文件，并记录原文与规范化版本的内容指纹。
5. 解析章节树、生成知识切片并写入 `.gouan/knowledge.db`。
6. 对文档标题、章节路径和切片正文进行 Jieba 分词，然后写入 FTS5 全文索引。该步骤完全在本地执行。

当前“识别结构”把本地扫描和 AI 辅助判断作为同一个等待流程，期间知识管理界面处于忙碌状态。带有大量 Word 目录项或低置信度候选的大文档，以及响应较慢的模型服务，可能需要较长时间才会打开确认弹窗。
