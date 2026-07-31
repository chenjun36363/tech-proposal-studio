# TechProposal Studio（构案）

本地优先的软件技术方案写作桌面工具。以 Markdown 为正文载体，把「章节化编辑、多提供商 AI 写作、知识库检索、Agent Skills、Git 协作」收进一个以隐私为底线的 Windows 工作台：正文与索引默认留在本机，AI 只接收当前章节和用户明确附加的资料，所有文档修改先生成可审核提案，接受后才生效。

- 当前开发计划与未完成事项统一维护在 [TODO.md](./TODO.md)。
- 面向 AI 助手的仓库指引见 [AGENTS.md](./AGENTS.md)。

## 功能特性

**章节化 Markdown 编辑**

- 内置九章技术方案模板；按 `第N章` / `1.1` / `1.1.1` 规则自动编号，章节增删移动后自动重排。
- 源码 / 分栏 / 预览三种视图；左栏目录树（按章节 / 全文）并支持折叠与批量调整层级。
- 查找替换（`Ctrl+F` / `Ctrl+H`）可限定当前章节或全文；粘贴图片自动写入工作区 `assets/` 并在预览中解析。
- 自定义模板的保存、读取、应用与删除。

**AI 写作与 Agent**

- 多提供商 LLM 连接：OpenAI Completions / OpenAI Responses / Anthropic Messages / Google Generative AI 四种协议，支持模型目录拉取与 CC Switch 订阅导入。
- 单块 AI 改写（AI 页签）：只优化当前内容块，返回可接受 / 拒绝的 diff。
- 多轮 Agent（Agent 页签）：自动选择工具完成「读取目录 / 章节 / 选区、检索知识库、查记忆、联网搜索、Git、执行计划、向用户提问」等动作。
- 文档编辑全部走提案审核：章节改写、选区替换、章节插入 / 移动 / 删除、标题重命名、文本替换；接受前校验原文快照，文档被改动时报告冲突而不覆盖。
- 执行计划（Todo）、上下文压缩、会话开关（联网搜索 / 知识工具 / 记忆）、自定义指令与回应风格。

**知识库**

- 工作区 `knowledge/` 下的 Markdown 与网页资料可入库；识别文档结构（本地扫描 + AI 辅助判断），确认后切片建立本地索引。
- SQLite FTS5 + Jieba 中文分词的全文检索，支持按标题 / 章节路径 / 正文限定范围，片段质量（优质 / 普通 / 劣质）参与排序并可人工修正。
- Agent 检索工具按预算返回证据片段，本地资料支持面板内 Markdown 预览。

**Agent Skills 技能市场**

- 支持 `SKILL.md` 渐进披露协议（兼容 `skill.json` 与 README 回退），内置 docx、excel、agent-browser 三个技能。
- 内置 / 全局 / 工作区三层发现，工作区同名技能优先；创建、校验、安装、删除、打包与 ClawHub 市场搜索 / 更新检查。
- 技能执行走受控 `skill_run_command`，限制程序、工作目录、环境与超时并逐次确认。

**长期记忆**

- 项目级事实记忆（`memory.db`），Agent 自动记录并检索；记忆写入与重要修改走审核流程，可单独查看、接受、删除或重建。

**Git 集成**

- 左栏 Git 视图：状态、差异对比、暂存、提交、分支、stash、pull / push、commit message 生成。
- Agent 的 Git 工具：读操作直接可用，写操作（暂存、提交、分支、推送等）执行前需审批。

**受控 CLI 与嵌入式终端**

- 受控命令执行：程序白名单、禁止 shell 直通、Windows npm shim 解析；Agent 预设采用非交互式参数。
- 右侧面板内嵌 PowerShell PTY 终端（桌面端），会话随面板生命周期管理。

**导出与文档解析**

- 导出 Markdown 或 Word（`.docx`）：Word 使用黑体标题 + 宋体正文的中文排版，本地图片自动内嵌。
- MinerU 云端文档解析：Word / PDF → Markdown 入库（`模型服务` 之外独立配置）。

**在线更新**

- 基于 Tauri updater 的桌面端在线升级，设置 → 关于与更新 中检查与安装。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2 + Rust（`rusqlite` / `jieba-rs` / `portable-pty` / `keyring` / `reqwest`） |
| 前端 | React 19 + TypeScript 5.7 + Vite 6，Tailwind CSS 4 |
| Markdown | marked + highlight.js + KaTeX + mermaid |
| 终端 | xterm.js + FitAddon |
| 导出 | docx v9 |
| 测试 | Vitest + jsdom |
| 包管理 | pnpm |

## 快速开始

前置要求：Node.js 22+、pnpm；桌面端还需 Rust stable（MSVC 工具链）与 Windows WebView2。

```powershell
pnpm install
pnpm dev          # 浏览器开发模式，Vite 运行在 http://localhost:1420
pnpm test         # 运行全部 Vitest 测试
pnpm build        # tsc -b && vite build → dist/
pnpm tauri dev    # 桌面开发模式（需要 MSVC，可用 scripts/run-tauri-dev.bat 辅助）
```

浏览器模式（`pnpm dev`）不需要 Rust，用于快速开发与基础功能预览：项目状态存 `localStorage`，搜索走浏览器直连，文件 / 终端 / 受控命令等桌面能力为降级或不可用。桌面模式（`pnpm tauri dev`）由 Rust 后端承担模型请求、系统凭据、SQLite、PTY 终端与受控进程。

## 桌面构建与发布

### 本地构建 Windows EXE

安装 Rust stable（MSVC）以及 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载后：

```powershell
pnpm install
pnpm build:exe
```

脚本会通过 `vswhere` 定位 MSVC 环境并调用 `pnpm tauri build --bundles nsis`，NSIS 下载失败时自动重试（可传 `-MaxAttempts` / `-RetryDelaySeconds`）。构建产物位于 `src-tauri/target/release/bundle/nsis/*.exe`。

### CI 发布与在线升级

`.github/workflows/windows-build.yml` 会在 `main` 推送、Pull Request 或手工触发时运行测试并构建 NSIS EXE，产物作为 Actions Artifact 保留 14 天。

推送语义化版本 tag（例如 `v0.3.0`），或手工运行 `.github/workflows/desktop-release.yml` 并填写版本 tag 后，流水线会构建 NSIS、MSI 与 Tauri 更新签名文件（`prepare-release-version.mjs` 从 tag 生成版本号），将安装包与 `latest.json` 发布到 GitHub Release。客户端默认从 `https://github.com/chenjun36363/tech-proposal-studio/releases/latest/download/latest.json` 检查、下载和安装更新。

首次发布前，在 GitHub 仓库的 Settings → Secrets and variables → Actions 中配置：

- Secret `TAURI_SIGNING_PRIVATE_KEY`：通过 `pnpm tauri signer generate -w ~/.tauri/tech-proposal-studio.key` 生成的私钥内容。
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成私钥时设置的密码。
- Variable `TAURI_UPDATER_PUBLIC_KEY`：同一命令输出的公钥内容。
- Variable `TAURI_UPDATE_ENDPOINT`：可选；不设置时使用上述 GitHub Release 地址。
- Secret `RELEASE_TOKEN`：仅在 CI 自动提供的仓库 token 无法创建 Release 时设置，需具备仓库发布写权限。

升级地址必须使用 HTTPS；签名私钥只能保存在 Actions Secret 中，不能提交到仓库。CI runner 需要 `windows-latest` 标签；若使用自托管标签，请同步修改 workflow 的 `runs-on`。

## 双运行时架构

前端共享，模块在 `src/services/` 选择 Browser / Tauri 适配器，由 `services/runtime.ts` 的 `isDesktop()`（检测 `window.__TAURI_INTERNALS__`）判断运行时：

- **Browser**：`fetch` 调用 OpenAI-compatible `/chat/completions` 与搜索 API；项目状态存 `localStorage`；Markdown 通过 Blob 下载；CLI / 终端 / 工作区磁盘 IO 为降级实现。
- **Tauri**：`invoke(...)` 调用注册在 `src-tauri/src/lib.rs` 的 Rust 命令；模型、搜索、凭据、导出、进程、终端、记忆与知识库实现于各自 Rust 模块；SQLite（`workspace.db`）存放命令运行历史与工作区连接配置。

规则：先扩展服务层（`src/services/*`、`src/features/workspace/workspace.ts`）再实现对应 Tauri 命令；React 组件不直接调用 `invoke`，也不判断具体命令实现。

## 项目结构

```text
tech-proposal-studio/
├─ src/
│  ├─ main.tsx                      # 应用入口，主题初始化与全局样式加载
│  ├─ App.tsx                       # 顶层布局、三栏工作区、设置与应用级弹窗
│  ├─ core/                         # 领域模型：types.ts / data.ts（工厂）/ theme.ts
│  ├─ services/
│  │  ├─ runtime.ts                 # 浏览器 / Tauri 运行时识别
│  │  ├─ llm/                       # 多协议 LLM 适配器（openai / anthropic / google）
│  │  ├─ model.ts / search.ts       # 模型、搜索 Browser/Tauri Adapter
│  │  ├─ system.ts                  # 文件交付、命令与终端能力
│  │  ├─ git.ts / privileged.ts     # Git 与受控系统能力
│  │  └─ updater.ts                 # 应用更新检查
│  ├─ hooks/                        # 应用级 hooks（文档控制、工作区、文件动作等）
│  ├─ features/
│  │  ├─ editor/                    # Markdown 编辑器、章节模型、查找替换、模板
│  │  ├─ inspector/                 # 右侧检查器（Agent / AI / 上下文 / 知识库 / 终端）
│  │  ├─ workspace/                 # 工作区、连接配置、项目存储
│  │  ├─ knowledge/                 # 知识库管理
│  │  ├─ search/                    # 联网搜索弹窗
│  │  ├─ git/                       # Git 工作台
│  │  ├─ skills/                    # Agent Skills 前端
│  │  ├─ settings/                  # 设置分区（模型 / 工具 / 技能 / 更新等）
│  │  ├─ terminal/                  # 嵌入式 PowerShell 终端
│  │  ├─ export/                    # Markdown / DOCX 导出与文档导入
│  │  └─ environment/               # 环境检测
│  ├─ agent/                        # Agent 协议、执行器、工具注册、会话、记忆、技能工具
│  │  ├─ protocol.ts / runner.ts    # Agent 事件 / 消息 / 提案类型与执行器
│  │  ├─ toolCatalog.ts             # 工具目录（planning / read / edit / knowledge / memory / web / git / system）
│  │  ├─ proposalTools.ts           # 文档编辑工具（章节增删改移、选区替换等）
│  │  ├─ conversationStore.ts       # 会话运行态
│  │  ├─ gitTools.ts / skillTools.ts / memoryService.ts
│  │  ├─ settings.ts / presets.ts / todos.ts / contextBuilder.ts
│  │  └─ styles/                    # Agent 相关样式
│  ├─ components/                   # 通用组件（Agent 面板、审核弹窗、diff 等）
│  └─ utils/
└─ src-tauri/src/
   ├─ main.rs / lib.rs              # crate 入口 + Tauri 命令注册
   ├─ integrations/
   │  ├─ model.rs                   # 模型代理、鉴权、流式与错误归一
   │  ├─ search.rs                  # SearXNG / Brave 搜索代理
   │  ├─ mineru.rs                  # MinerU 文档转换
   │  ├─ ccswitch.rs                # CC Switch 提供商导入
   │  └─ updater.rs                 # 应用更新检查 / 安装
   ├─ platform/
   │  ├─ credentials.rs             # keyring 与旧服务名迁移
   │  ├─ export.rs                  # Markdown / DOCX 文件交付
   │  ├─ process.rs                 # 受控命令执行 + 命令历史（workspace.db）
   │  ├─ system.rs                  # 外部链接系统调用
   │  ├─ terminal.rs                # PowerShell PTY 生命周期
   │  └─ privileged.rs              # 受控系统文件 / PowerShell 操作
   ├─ workspace/
   │  ├─ connections.rs             # 工作区连接配置（SQLite）
   │  └─ git.rs                     # Git 命令
   ├─ agent/
   │  ├─ conversations.rs           # Agent 会话 SQLite
   │  ├─ memory.rs                  # 长期记忆
   │  └─ skills.rs                  # Agent Skills 发现 / 安装 / 市场
   └─ knowledge/
      ├─ mod.rs                     # 知识库命令与流程
      ├─ parser.rs / headings.rs    # 章节解析与标题候选识别
      ├─ repository.rs              # Repository 接口、连接与迁移
      └─ repository/
         ├─ indexing.rs             # 原子索引替换与质量继承
         └─ queries.rs              # 文档 / 章节 / 切片 / FTS5 查询
```

### 核心交互

- **左侧**：目录树（按章节 / 全文）+ Git 视图切换；下方为工作区 Markdown 文件列表。
- **中间**：Markdown 源码编辑器 + 渲染预览（源码 / 分栏 / 预览）；标题工具栏批量设置 H1–H6 后自动编号；查找替换栏；粘贴图片写入 `assets/`。
- **右侧** 检查器五个页签：`Agent`（多轮 Agent 对话，含 Todo 计划、提案审核、提问）、`AI`（单块改写，接受 / 拒绝 diff）、`上下文`（AI 上下文与引用资料）、`知识库`（本地检索、章节范围、质量标记）、`终端`（桌面端 PowerShell PTY）。
- **工具栏**：打开 / 保存（工作区 `.md`）、重新加载（重读磁盘）、导出菜单（Markdown / Word）、设置、主题切换。
- 左右面板宽度为可拖拽分割条；项目状态 500ms 防抖持久化，磁盘中的打开 `.md` 是正文事实来源。

## 数据与持久化

```text
React Project state
  ├─ 500ms debounce → localStorage 项目缓存（剥离 API Key）
  ├─ 当前 Markdown → workspace.root 下打开的 .md 文件
  ├─ 连接配置 → 应用数据目录 workspace.db 的 workspace_connections 表
  ├─ 系统凭据镜像 → OS keyring
  ├─ Agent 会话 → workspace.root/.gouan/conversations.db
  ├─ 长期记忆 → workspace.root/.gouan/memory.db
  └─ 知识索引 → workspace.root/.gouan/knowledge.db
```

- **项目缓存**：`localStorage` 键 `tech-proposal-studio.project.v1`；写入前始终剥离 `model.apiKey` 与 `search.apiKey`。旧键 `schematic-writer.project.v1` 仅作为一次性迁移源。
- **连接配置**（模型 + 搜索 + MinerU）：桌面端以应用数据目录 SQLite `workspace.db` 的 `workspace_connections` 表为准，按工作区 root 键控；浏览器模式（无 root）存 `localStorage` 键 `tech-proposal-studio.connections.v1`。旧版 `<workspace.root>/.gouan/connections.json` 只在无数据库行时导入一次，之后不再写入。API Key 按用户要求保存在该 SQLite 行中，但绝不进入项目缓存。
- **系统凭据**：keyring 服务 `com.techproposal.studio`，若存在旧服务 `cn.gouan.writer` 会一次性复制；保存设置时镜像写入 keyring，模型调用可从中补空 API Key。
- **Agent 会话**：`<workspace.root>/.gouan/conversations.db`（`agent_conversation` / `agent_conversation_message` / `agent_conversation_meta` 表），含增量事件同步与 revision 冲突检测；旧 JSON 仅作只读迁移源。
- **长期记忆**：`<workspace.root>/.gouan/memory.db`，另在 `.gouan/memory/` 下保留决策记录 Markdown。
- **命令历史**：应用数据目录 `workspace.db`。
- **知识索引**：见下文「知识库存储与索引」。

## 核心能力说明

### 知识检索可靠性

- 自然语言查询压缩为有限核心词，过滤常见疑问词 / 动作词 / 连接词，避免 FTS 表达式失控。
- 「全部核心词匹配 → 少一个词匹配 → OR 宽松匹配」零召回级联，逐层去重、命中即停。
- 相关性优先排序，质量等级只提供小幅加权；`search_knowledge` 直接返回受预算限制的正文证据、章节 ID、相关性、质量与截断状态，仅在证据不足时才补调 `read_knowledge`。
- 知识检索是关键词 FTS，不生成 embedding、不使用向量数据库。

### 统一编辑提案

- `AgentDraft` 携带操作类型（`replace_section` / `replace_selection` / `insert_section` / `delete_section` / `move_section` / `replace_document`）与目标信息（目标章节、原文快照、选区范围、说明）。
- 接受前校验目标与原文快照；文档已变化时报冲突，不覆盖新内容；章节移动额外校验目标位置快照并禁止移入自身子树。
- 审核界面按操作类型展示章节 / 选区前后对照、插入位置或删除警告；接受一项提案只产生一条撤销记录。

### Agent 会话

- 桌面端会话以 `.gouan/conversations.db` 为唯一真源，前端以内存运行态为即时数据源，通过 `agent-conversations:changed` 增量事件同步。
- 发送、切换、新建、删除与开关修改均不依赖整页刷新或整库重载；`revision` 检测陈旧写入。
- Agent 运行中的 token、工具事件与 Todo 只更新运行态，在稳定检查点或结束时持久化。

## 隐私与安全

- **本地优先**：正文与索引默认留在设备上；AI 只接收当前章节、选区与用户明确附加的参考资料。
- **密钥隔离**：API Key 不写入项目 `localStorage` 缓存；连接配置与 keyring 按上文「数据与持久化」管理。
- **联网搜索默认关闭**：Agent 侧 web search 每会话默认关闭，用户开启后才直接调用（不再逐查询确认）；手动工具栏搜索始终由用户主动触发。
- **先提案后应用**：所有 AI 正文修改先生成可审核提案，接受后才更新编辑器状态；接受提案不直接写盘，磁盘写入仍由「保存」触发。
- **受控命令**：`run_command` 不接受 shell 直通，按白名单程序执行并解析 Windows npm shim；`skill_run_command` 限制程序、工作目录、环境、超时与输出，逐次确认。
- **Git 写操作审批**：Agent 的 Git 写操作（暂存、提交、分支、推送等）执行前必须获得用户批准。

## 知识库存储与索引

桌面端建立知识库索引后，原文与索引都保存在当前工作目录：

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

知识文档路径统一以 `workspace.root` 为基准保存为相对路径（例如 `knowledge/方案.md`、`knowledge/web/网页.md`）；旧版 `history/` 路径会自动迁移，跨环境迁移工作区时不依赖原机器盘符。

中文内容先使用 Jieba 分词，再将文档标题、章节路径和正文分别写入 FTS5。检索可组合选择这些字段作为搜索范围；未指定范围时搜索全部字段。搜索使用列限定的 FTS5 `MATCH` 与 BM25 排序，并对标题 / 章节路径 / 正文直接包含查询词的结果加权。

知识片段质量分为优质（`good`）、普通（`normal`）和劣质（`bad`）。新建及旧数据库迁移后的片段默认普通；检索默认包含优质和普通、排除劣质，先按质量再按 BM25 相关度排序。质量标记存储在 `knowledge_chunks.quality`，可在检索条件中筛选、在结果中修改。

浏览器开发模式不建立这套桌面端 SQLite 知识库索引。

## 知识文档结构识别

知识管理中的「识别结构」用于在建立索引前确认 Markdown 的章节层级：

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

系统按行读取 Markdown，按以下规则生成标题候选：

- 已有 Markdown 标题（`#` 至 `######`）直接保留，默认选中，置信度 `1.0`，用户不能取消或修改层级。
- `第N章`、`第一章` 等章标题识别为 H1。
- `1.1`、`1.1.1` 等点分编号按深度推断为 H2、H3，以此类推，最高 H6。候选不超过 120 字符，且不能以句号或分号结尾。
- 文档前 500 行存在至少 3 个 `[#_Toc]` 形式的 Word 目录链接则视为目录，在正文中查找同名行并采用目录推断层级，默认置信度 `0.98`。
- 独占一行、前后空行、长度不超过 80 字符的 Markdown 粗体短行作为低置信度候选，默认不选中，初始层级 H2，置信度 `0.45`。

扫描忽略代码围栏、已识别目录区域、表格行与链接行；比较前清理空白、粗体标记、标题井号与 Word 目录链接格式。

### AI 辅助判断

只有存在低置信度粗体候选时才调用配置的 OpenAI-compatible 模型：

- 每次最多发送 80 个候选，每个候选含候选文字、原始行号及前后约 2 行上下文，不发送整篇文档。
- 模型只返回候选是否为标题及建议的 H1-H6 层级，不改写原文。
- 请求使用连接配置的 `timeoutMs`；完成或超时后前端才显示结构确认弹窗。
- 未配置模型 / API Key、调用失败、超时或返回非有效 JSON 时，本地识别结果仍保留，错误显示在确认弹窗。

### 人工确认与写回

确认后依次执行：

1. 将原 Markdown 备份到 `.gouan/backups/knowledge/<document-id>/`。
2. 给选中的非 Markdown 标题行添加对应数量的 `#`；已有 Markdown 标题保持原样。
3. 在已识别的 Word 目录前后写入 `<!-- knowledge-toc:start -->` / `<!-- knowledge-toc:end -->`，使目录保留在原文但不参与切片。
4. 将规范化后的 Markdown 写回 `knowledge` 文件，并记录原文与规范化版本的内容指纹。
5. 解析章节树、生成知识切片并写入 `.gouan/knowledge.db`。
6. 对文档标题、章节路径和切片正文进行 Jieba 分词后写入 FTS5 全文索引（完全本地执行）。

当前「识别结构」把本地扫描与 AI 辅助判断作为同一个等待流程，期间知识管理界面处于忙碌状态；带大量目录项或低置信度候选的大文档、响应较慢的模型服务可能耗时较长。

## 测试

Vitest + jsdom，测试文件与被测模块同目录存放（`*.test.ts` / `*.test.tsx`）。覆盖范围包括：模板结构、密钥剥离、legacy 键迁移、Markdown 导出、DOCX ZIP 魔数、章节增删移动、选区替换、知识检索排序、Agent 会话与工具注册等。

```powershell
pnpm test                                     # 全部测试
pnpm exec vitest run src/storage.test.ts      # 单个文件
pnpm exec vitest run -t "never persists"      # 按名称
pnpm build                                    # tsc -b（类型检查）+ vite build
```

## 开发路线图

功能开发按工作包推进，详细状态见 [TODO.md](./TODO.md)。当前优先级：Agent 文档编辑工具（P3）→ 全文优化（P4）→ 会话可靠性与工作区实时同步（P1/P2）→ 桌面交付验证（P5）。

- 遵循产品约束：正文与索引默认留本机；AI 修改先审核后应用；API Key 不进项目缓存；Agent 联网搜索默认关闭。
- 源码结构治理（P7）：固定依赖方向 `app → features → domain/shared/services`，领域纯函数不依赖 React / Tauri；新增代码不堆入 `App.tsx` 与 `index.css`。
