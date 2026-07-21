# TechProposal Studio（构案）

本地优先的软件技术方案编写桌面工具。支持模板化章节、自由内容块、历史资料引用、OpenAI-compatible AI 优化、SearXNG/Brave 搜索和受控 CLI 任务。

## 运行

```powershell
pnpm install
pnpm dev
```

桌面端还需要 Rust stable 和 Windows WebView2，然后运行 `pnpm tauri dev`。浏览器开发模式使用 `localStorage`；Tauri 模式由 Rust 后端处理模型请求、系统凭据、SQLite 和受控进程。

正文和索引默认留在本机。AI 只发送当前内容块和明确加入的引用；联网搜索执行前显示实际查询词；API Key 不写入项目文件。
