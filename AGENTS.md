# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

TechProposal Studio（中文品牌「构案」）— Windows-first, local-first desktop tool for writing software tech proposals. Stack: Tauri 2 + Rust backend, React 19 + TypeScript frontend, Vite, pnpm.

Identity / rename map (keep consistent when touching config or storage):

| Surface | Value |
| --- | --- |
| npm / Cargo package | `tech-proposal-studio` |
| Rust lib crate | `tech_proposal_studio_lib` |
| Tauri productName | `TechProposal Studio` |
| Tauri identifier / keyring service | `com.techproposal.studio` |
| Window title | `构案 - TechProposal Studio` |
| Browser storage key | `tech-proposal-studio.project.v1` |

Legacy migration sources (read-only fallbacks only): localStorage `schematic-writer.project.v1`, keyring `cn.gouan.writer`. New code should not write to legacy names.

## Commands

```powershell
pnpm install
pnpm dev                 # Vite on http://localhost:1420 (strictPort)
pnpm build               # tsc -b && vite build → dist/
pnpm test                # vitest run (all tests)
pnpm exec vitest run src/storage.test.ts   # single file
pnpm exec vitest run -t "never persists"   # single test by name
pnpm tauri dev           # desktop shell (needs Rust stable + WebView2)
pnpm tauri build         # NSIS/MSI bundles
```

No ESLint/Prettier scripts are configured. Typecheck is part of `pnpm build` (`tsc -b`).

Tauri is not yet verified on machines without Rust; frontend can be developed fully in browser mode.

## Architecture

### Dual runtime

Frontend is shared. Modules under `src/services/` select Browser/Tauri adapters using `services/runtime.ts`:

- **Browser**: `fetch` to OpenAI-compatible `/chat/completions` and search APIs; project state in `localStorage`; Markdown download via Blob; CLI / terminal / workspace disk IO are stubs or no-ops.
- **Tauri**: `invoke(...)` to Rust commands registered in `src-tauri/src/lib.rs`; model, search, credentials, export, process, terminal, memory, and knowledge implementations live in dedicated Rust modules. SQLite (`workspace.db` under app data) holds command run history.

Prefer extending the service layer / `src/workspace.ts` + matching Tauri command rather than calling APIs only from React.

### Domain model

Defined in `src/types.ts`, factory in `src/data.ts`:

```
Project
  markdown   (primary body — workspace .md file contents)
  contextSourceRefs[]  (project-level sources explicitly attached to AI context)
  sources[]  (history library Markdown + web search hits)
  model / search / commands
  workspace? { root, historyDir }
  filePath?  (absolute path of the open workspace .md)
```

Default body is a Markdown template with H1 + nine `##` chapters (`src/markdownDoc.ts`). Left TOC is derived from Markdown headings.

### User workspace (desktop)

| Path | Role |
| --- | --- |
| `workspace.root` | Working directory; open/save current proposal `.md` here; terminal `cwd`; paste images → `assets/` |
| `workspace.historyDir` | Reference materials only (`*.md` auto-loaded into 资料) |

Config: localStorage `tech-proposal-studio.workspace.v1`. Boot creates `knowledge/` + `assets/` under root. Legacy `history/`, `proposalsDir`, and `libraryDir` normalize or migrate to `historyDir`.

Toolbar **打开/保存** operate on Markdown under `root` (`list_workspace_markdown`, `read_text_file`, `write_text_file`, `pick_markdown_file`). History import still uses `write_library_markdown`.

### UI shape

`src/App.tsx`: top bar + three columns (no bottom dock).

- Left: Markdown heading TOC (按章节 / 全文) + workspace `.md` file list
- Center: Markdown source editor + rendered preview (源码 / 分栏 / 预览); heading toolbar sets H1–H6 on selection (batch) then renumbers (H1 `第N章`, H2 `1.1`, H3 `1.1.1`, …); find/replace bar (Ctrl+F / Ctrl+H) scopes to current section or full doc; paste image writes to workspace `assets/` and preview resolves via `convertFileSrc` + Tauri `assetProtocol` (needs desktop restart after config change)
- Right inspector tabs: AI / 资料 / 任务 / 终端; left/right panel borders are drag splitters (`leftWidth` default 240px, `rightWidth` default 360px)
- Toolbar / left panel **重新加载** re-reads `project.filePath` from disk into `markdown`
- Terminal lives in the right panel 终端 tab (toolbar terminal button opens that tab)

State is one `Project` with 500ms debounced `saveProject` (localStorage cache). Disk truth for the body is the open `.md` when `filePath` is set.

### Embedded terminal

Desktop only, hosted in the right panel. Rust uses `portable-pty` (`terminal_open` / `write` / `resize` / `close`); frontend uses xterm.js + FitAddon with `ResizeObserver`. PTY starts on first visit to the 终端 tab and stays while the right panel stays open (tab content is CSS-hidden, not unmounted). Collapsing the right panel unmounts the terminal (session ends). Shell preference: `pwsh` then `powershell`. Sessions are held in `TerminalState` (Mutex-wrapped master/writer/child).

### CLI / agent tools

`run_command`: no shell mode (`allow_shell` rejected); allowlisted programs; on Windows resolve `.exe`/`.cmd`/`.bat` and launch scripts via `cmd.exe /D /S /C` (avoids os error 193 on npm shims). Agent presets in `src/agents.ts` use non-interactive flags (`Codex -p`, `codex exec`, `opencode run`). Interactive AI editing is intended via the right-panel PowerShell terminal.

### Persistence and secrets

`src/storage.ts`:

- Saves project JSON to localStorage; **always strips `model.apiKey` and `search.apiKey`** before write.
- Loads current key, then migrates from legacy key if needed.
- `ensureCommands` migrates missing agent-check presets on older projects.

**Connection config (model + search)** lives in the workspace file  
`<workspace.root>/.gouan/connections.json` via `src/connections.ts` (`loadWorkspaceConnections` / `saveWorkspaceConnections`).  
Loaded on desktop workspace boot and when applying a workspace root; written when the user saves Settings.  
Browser mode (no root) keeps the same JSON shape under localStorage key `tech-proposal-studio.connections.v1`.  
API keys **are** stored in that workspace file (user-requested); they still never go into the project cache (`tech-proposal-studio.project.v1`).

Rust keyring (`store_secret` / `load_secret`): service `com.techproposal.studio`, with one-time copy from `cn.gouan.writer` if present. Saving settings also mirrors keys into keyring so model calls can fill empty API key from keyring when possible.

### AI / search contracts

- AI improves **one content block** with optional selected source excerpts; returns `AiDraft { blockId, before, after, instruction }` for accept/reject diff UI. System prompt asks for body-only output (no fences/explanations).
- Local 资料筛选 is keyword-only (title/excerpt/path); no vector search. Optional web search still requires user confirm of the exact query before send. Local sources support in-panel Markdown preview via `read_text_file`.

### Export

- Toolbar “导出” menu: Markdown (`.md`) via `exportMarkdown` + `saveMarkdown`, and Word (`.docx`) via `src/docxExport.ts` (`buildDocx` / `buildDocxBytes` / `downloadDocx` from current `project.markdown`). Browser packing uses `Packer.toArrayBuffer`/`toBlob` (not `toBuffer` — WebView has no Node buffer). Desktop writes via `save_binary_file` (save dialog) or `save_docx_export` fallback under app `exports/`.
- Word styles: H1 黑体 2号 (22pt) black; other headings 黑体 black; body 宋体 小四 (12pt). Local images (`![…](assets/…)` etc.) embed via `ImageRun`; bytes loaded with `read_binary_file` / `readBinaryFile`, resolved against `workspace.root` (for `assets/`) or open file dir.
- Workspace save: toolbar “保存” writes the open proposal Markdown under `workspace.root`.

### Tests

Vitest + jsdom for storage tests (`// @vitest-environment jsdom` in file). Coverage today: template shape, secret stripping, legacy key migration, Markdown export, DOCX ZIP magic bytes. Prefer colocated `*.test.ts` next to the module under test.

### Windows desktop dev note

`pnpm tauri dev` needs MSVC (vcvars). Helper: `.\.tmp\run-tauri-dev.bat` loads vsdevcmd then runs tauri. Vite is `strictPort: 1420` — kill listeners on 1420 before restart if `beforeDevCommand` fails.

## Product constraints (from README / handoff)

- Body and indexes stay on-device by default; AI only receives the current block plus explicitly attached sources.
- API keys must not land in project localStorage cache; connection secrets may live under workspace `.gouan/connections.json`.
- Search outbound query must be shown before execution.
- Known gaps: section delete/reorder, custom templates.
