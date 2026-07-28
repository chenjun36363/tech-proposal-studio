# TechProposal Studio 会话交接

## 项目定位

Windows 优先的本地技术方案编写工具，中文品牌名“构案”。采用 Tauri 2 + Rust、React + TypeScript、SQLite；AI 默认连接 OpenAI-compatible 联网模型，Ollama 作为后续可选本地后端。

## 已完成

- 三栏写作工作台：章节树、分块编辑区、AI/资料/任务侧栏。
- 默认 9 章技术方案结构，可改章节标题、新增章节和添加多种内容块。
- 内容块类型：正文、表格、代码、Mermaid、引用、决策、命令证据。
- 浏览器模式自动保存至 localStorage，模型和搜索 API Key 不落盘。
- OpenAI-compatible Chat Completions 调用及 AI 修改 diff 接受/拒绝流程。
- SearXNG、Brave Search 接口；Agent 联网搜索按会话开关授权，启用后直接执行查询（无需每次确认 query）。
- Markdown 资料导入、引用上下文选择和 Markdown 导出。
- 独立 DOCX 生成模块及有效 ZIP/DOCX 结构测试；工具栏尚未接通 Word 导出。
- Tauri Rust 后端源码：SQLite FTS5、系统凭据、模型与搜索代理、Markdown 落盘、受控 CLI、输出脱敏。
- 前端生产构建通过；原测试 4 项通过；浏览器实测无控制台错误。

## 本次重命名

- 新根目录：`E:\opencode\tech-proposal-studio`
- npm/Cargo package：`tech-proposal-studio`
- Rust crate：`tech_proposal_studio_lib`
- Tauri productName：`TechProposal Studio`
- Tauri identifier 和凭据命名空间：`com.techproposal.studio`
- Windows 标题：`构案 - TechProposal Studio`
- 浏览器存储键：`tech-proposal-studio.project.v1`
- 保留旧 localStorage 键和 `cn.gouan.writer` 凭据读取作为迁移来源。

## 环境与限制

- 本机 Node `v24.13.0`、pnpm `10.33.0`、Python `3.14.3`。
- 本机没有 Rust/Cargo，因此尚未编译 Tauri 桌面安装包。
- 没有 LibreOffice/Poppler，尚未做 DOCX 页面渲染检查。
- 旧中文目录被当前 Codex 沙箱占用，项目内容已迁往英文目录；当前会话结束后可删除空目录 `E:\opencode\文档工具`。

## 下一步建议

1. 在新目录运行 `pnpm install`、`pnpm test`、`pnpm build`，确认重命名后的锁文件与测试。
2. 全局搜索旧名称，仅允许它们出现在迁移代码和本交接文档中。
3. 将 DOCX 导出模块接入工具栏，并增加企业模板映射。
4. 安装 Rust stable 后运行 `pnpm tauri dev`，修正 Rust 编译问题并验证 Windows Credential Manager、SQLite 和 CLI。
5. 实现章节删除、拖拽排序、自定义模板保存/切换；当前“从模板新建”仍是占位按钮。

## 常用命令

```powershell
cd E:\opencode\tech-proposal-studio
pnpm install
pnpm test
pnpm build
pnpm dev --host 0.0.0.0
```
