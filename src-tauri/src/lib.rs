use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env, fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

mod knowledge;

const CREDENTIAL_SERVICE: &str = "com.techproposal.studio";
const LEGACY_CREDENTIAL_SERVICE: &str = "cn.gouan.writer";

const ALLOWED_PROGRAMS: &[&str] = &[
    "node", "npm", "npx", "pnpm", "git", "claude", "codex", "opencode", "pwsh", "powershell",
];

struct TerminalSession {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn io::Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<TerminalSession>>>,
}

// MasterPty is Send but not Sync; Mutex makes the session shareable across Tauri commands.

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelConfig {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    #[serde(default)]
    pub(crate) model: String,
    pub(crate) timeout_ms: u64,
    pub(crate) headers: HashMap<String, String>,
}
#[derive(Deserialize)]
struct SearchConfig {
    provider: String,
    endpoint: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(default = "default_search_engines")]
    engines: Vec<String>,
}

fn default_search_engines() -> Vec<String> {
    vec!["baidu".into(), "360search".into(), "bing".into()]
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDraft {
    block_id: String,
    before: String,
    after: String,
    instruction: String,
}
#[derive(Serialize)]
struct SearchResult {
    title: String,
    url: String,
    excerpt: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandPreset {
    program: String,
    args: Vec<String>,
    cwd: String,
    timeout_ms: u64,
    allow_shell: bool,
    #[serde(default)]
    stdin: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u128,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    id: u64,
    data: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    id: u64,
    code: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePaths {
    root: String,
    /// 历史方案 JSON 与资料 Markdown 共用目录
    history_dir: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposalFile {
    name: String,
    path: String,
    updated_at: String,
    size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile {
    title: String,
    path: String,
    excerpt: String,
    updated_at: String,
    size: u64,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn init_db(app: &AppHandle) -> Result<(), String> {
    let dir = app_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db = rusqlite::Connection::open(dir.join("workspace.db")).map_err(|e| e.to_string())?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL, excerpt TEXT NOT NULL, fingerprint TEXT NOT NULL, accessed_at TEXT NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(id UNINDEXED, title, excerpt, tokenize='unicode61');
         CREATE TABLE IF NOT EXISTS command_runs(id INTEGER PRIMARY KEY, program TEXT NOT NULL, exit_code INTEGER NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);",
    )
    .map_err(|e| e.to_string())
}

fn load_secret(name: &str) -> String {
    let current = keyring::Entry::new(CREDENTIAL_SERVICE, name).ok();
    if let Some(value) = current
        .as_ref()
        .and_then(|entry| entry.get_password().ok())
        .filter(|value| !value.is_empty())
    {
        return value;
    }
    let legacy = keyring::Entry::new(LEGACY_CREDENTIAL_SERVICE, name)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .unwrap_or_default();
    if !legacy.is_empty() {
        if let Some(entry) = current {
            let _ = entry.set_password(&legacy);
        }
    }
    legacy
}

fn program_basename(program: &str) -> String {
    Path::new(program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(program)
        .to_ascii_lowercase()
}

fn ensure_allowed(program: &str) -> Result<(), String> {
    let base = program_basename(program);
    if ALLOWED_PROGRAMS.contains(&base.as_str()) {
        Ok(())
    } else {
        Err(format!(
            "不允许执行程序 `{program}`。当前白名单：{}",
            ALLOWED_PROGRAMS.join(", ")
        ))
    }
}

fn tool_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(r"AppData\Roaming\npm"));
        dirs.push(home.join(r".local\bin"));
        dirs.push(home.join(r".cargo\bin"));
    }
    for extra in [
        r"E:\software\node.js",
        r"C:\Program Files\nodejs",
        r"C:\Program Files (x86)\nodejs",
        r"C:\Windows\System32",
        r"C:\Windows\System32\WindowsPowerShell\v1.0",
        r"C:\Program Files\PowerShell\7",
    ] {
        dirs.push(PathBuf::from(extra));
    }
    if let Ok(path) = env::var("PATH") {
        for p in env::split_paths(&path) {
            if !dirs.iter().any(|x| x == &p) {
                dirs.push(p);
            }
        }
    }
    dirs
}

fn is_windows_exec(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("exe") | Some("cmd") | Some("bat") | Some("com") => true,
        // extensionless: only accept if not a text shim (heuristic: size or shebang check later)
        None => {
            // On Windows, npm creates extensionless bash shims that are not PE binaries.
            // Prefer never treating extensionless as executable unless it's under System32-like paths.
            let s = path.to_string_lossy().to_ascii_lowercase();
            s.contains(r"\windows\system32") || s.contains(r"\windows\syswow64")
        }
        _ => false,
    }
}

fn resolve_executable(program: &str) -> Result<PathBuf, String> {
    let direct = PathBuf::from(program);
    if direct.is_absolute() && direct.is_file() && is_windows_exec(&direct) {
        return Ok(direct);
    }

    // OpenCode's `run` command requires a positional message and does not consume
    // plain stdin as that message. Prefer its native binary so multiline prompts
    // bypass cmd.exe parsing when passed as an argument.
    if program.eq_ignore_ascii_case("opencode") {
        for dir in tool_search_dirs() {
            let candidate = dir.join("node_modules").join("opencode-ai").join("bin").join("opencode.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // Prefer real Windows launchers first to avoid npm's extensionless bash shims (os error 193).
    let mut names = Vec::new();
    if program.contains('.') {
        names.push(program.to_string());
    } else {
        names.extend([
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]);
    }

    for dir in tool_search_dirs() {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() && is_windows_exec(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "找不到可执行文件 `{program}`。请确认已安装并加入 PATH（例如 npm 全局目录）。"
    ))
}

fn child_path_env() -> Option<std::ffi::OsString> {
    let mut parts = tool_search_dirs();
    if let Ok(path) = env::var("PATH") {
        for p in env::split_paths(&path) {
            if !parts.iter().any(|x| x == &p) {
                parts.push(p);
            }
        }
    }
    env::join_paths(parts).ok()
}

fn quote_cmd_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if !arg.contains([' ', '\t', '"', '&', '|', '<', '>', '^', '%']) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\"\""))
}

async fn spawn_and_wait(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout_ms: u64,
    stdin_data: Option<&str>,
) -> Result<(i32, String, String, u128), String> {
    let started = std::time::Instant::now();
    let use_cmd = program
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);

    let mut command = if use_cmd {
        // Always launch .cmd/.bat via cmd.exe to avoid ERROR_BAD_EXE_FORMAT (193)
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/D").arg("/S").arg("/C");
        let mut line = quote_cmd_arg(&program.to_string_lossy());
        for arg in args {
            line.push(' ');
            line.push_str(&quote_cmd_arg(arg));
        }
        cmd.arg(line);
        cmd
    } else {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    };

    command
        .current_dir(cwd)
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(path) = child_path_env() {
        command.env("PATH", path);
    }

    let mut child = command.spawn().map_err(|e| {
        format!(
            "启动失败: {e}（程序：{}）",
            program.display()
        )
    })?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(data.as_bytes())
                .await
                .map_err(|e| format!("写入 stdin 失败: {e}"))?;
        }
    }

    let output = timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
        .await
        .map_err(|_| "命令执行超时".to_string())?
        .map_err(|e| e.to_string())?;

    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        started.elapsed().as_millis(),
    ))
}

fn resolve_shell() -> Result<(PathBuf, Vec<String>), String> {
    if let Ok(pwsh) = resolve_executable("pwsh") {
        return Ok((pwsh, vec!["-NoLogo".into()]));
    }
    if let Ok(ps) = resolve_executable("powershell") {
        return Ok((
            ps,
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
            ],
        ));
    }
    Err("未找到 PowerShell（pwsh / powershell）".into())
}

#[tauri::command]
fn open_workspace_powershell(cwd: String) -> Result<(), String> {
    let workdir = resolve_workdir(&cwd)?;
    let (shell, args) = resolve_shell()?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        std::process::Command::new(shell)
            .args(args)
            .current_dir(workdir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("打开 PowerShell 失败: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = (shell, args, workdir);
        Err("独立 PowerShell 窗口目前仅支持 Windows".into())
    }
}

#[tauri::command]
async fn generate_text(
    block_id: String,
    mut config: ModelConfig,
    payload: Value,
    instruction: String,
    before: String,
) -> Result<AiDraft, String> {
    if config.api_key.is_empty() {
        config.api_key = load_secret("openai-api-key");
    }
    if config.api_key.is_empty()
        && !config.base_url.contains("localhost")
        && !config.base_url.contains("127.0.0.1")
    {
        return Err("API Key 未配置".into());
    }
    let mut request = reqwest::Client::new()
        .post(format!(
            "{}/chat/completions",
            config.base_url.trim_end_matches('/')
        ))
        .bearer_auth(&config.api_key)
        .json(&payload);
    for (key, value) in &config.headers {
        request = request.header(key, value);
    }
    let response = request
        .timeout(Duration::from_millis(config.timeout_ms))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("模型服务返回 {}", status));
    }
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(AiDraft {
        block_id,
        before,
        after: body
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        instruction,
    })
}

#[tauri::command]
fn store_secret(name: String, value: String) -> Result<(), String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &name)
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_web(query: String, config: SearchConfig) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::new();
    let response = if config.provider == "searxng" {
        let engines = if config.engines.is_empty() {
            default_search_engines()
        } else {
            config.engines.clone()
        };
        client
            .get(format!(
                "{}/search",
                config.endpoint.trim_end_matches('/')
            ))
            .query(&[("q", query.as_str()), ("format", "json")])
            .query(&[("engines", engines.join(","))])
            .send()
            .await
    } else {
        client
            .get(if config.endpoint.is_empty() {
                "https://api.search.brave.com/res/v1/web/search"
            } else {
                &config.endpoint
            })
            .query(&[("q", query.as_str())])
            .header("X-Subscription-Token", config.api_key)
            .send()
            .await
    }
    .map_err(|e| e.to_string())?;
    let json: Value = response.json().await.map_err(|e| e.to_string())?;
    if config.provider == "searxng"
        && json.get("results").and_then(Value::as_array).is_some_and(Vec::is_empty)
    {
        if let Some(failures) = json.get("unresponsive_engines").and_then(Value::as_array) {
            if !failures.is_empty() {
                let detail = failures
                    .iter()
                    .filter_map(|item| item.as_array())
                    .map(|item| {
                        format!(
                            "{}（{}）",
                            item.first().and_then(Value::as_str).unwrap_or("未知引擎"),
                            item.get(1).and_then(Value::as_str).unwrap_or("失败")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("、");
                return Err(format!("上游搜索失败：{detail}"));
            }
        }
    }
    let items = if config.provider == "searxng" {
        json.get("results")
    } else {
        json.pointer("/web/results")
    }
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
    Ok(items
        .into_iter()
        .take(8)
        .map(|item| SearchResult {
            title: item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            url: item
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            excerpt: item
                .get(if config.provider == "searxng" {
                    "content"
                } else {
                    "description"
                })
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
        })
        .collect())
}

#[tauri::command]
fn save_markdown(app: AppHandle, project_name: String, markdown: String) -> Result<String, String> {
    let exports = app_dir(&app)?.join("exports");
    fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    let safe = sanitize_filename(&project_name);
    let path = exports.join(format!("{}.md", safe));
    fs::write(&path, markdown).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

/// Save raw bytes via system save dialog (returns chosen path, or None if cancelled).
#[tauri::command]
fn save_binary_file(
    app: AppHandle,
    default_name: String,
    bytes: Vec<u8>,
    filters: Option<Vec<(String, Vec<String>)>>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(title.as_deref().unwrap_or("保存文件"))
        .set_file_name(&default_name);
    if let Some(list) = filters {
        for (name, exts) in list {
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(name, &refs);
        }
    }
    let chosen = dialog.blocking_save_file();
    let Some(file) = chosen else {
        return Ok(None);
    };
    let path = file.to_string();
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(Some(path))
}

/// Fallback: write DOCX under app data exports/ without a dialog.
#[tauri::command]
fn save_docx_export(app: AppHandle, project_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let exports = app_dir(&app)?.join("exports");
    fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    let safe = sanitize_filename(&project_name);
    let path = exports.join(format!("{safe}.docx"));
    fs::write(&path, &bytes).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path.to_string_lossy().into())
}

fn sanitize_filename(name: &str) -> String {
    let cleaned = Regex::new(r#"[<>:"/\\|?*]"#)
        .unwrap()
        .replace_all(name, "_")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "untitled".into()
    } else {
        cleaned
    }
}

fn file_updated_at(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            // Keep a stable sortable string; frontend can display as-is.
            format!("{}", d.as_secs())
        })
        .unwrap_or_else(|| "0".into())
}

fn collect_markdown_files(dir: &Path, max_depth: usize) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) -> Result<(), String> {
        if depth > max_depth {
            return Ok(());
        }
        let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {e}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let ft = entry.file_type().map_err(|e| e.to_string())?;
            if ft.is_dir() {
                walk(&path, depth + 1, max_depth, out)?;
            } else if ft.is_file() {
                if path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
                {
                    out.push(path);
                }
            }
        }
        Ok(())
    }
    if dir.is_dir() {
        walk(dir, 0, max_depth, &mut out)?;
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn default_workspace_root(app: AppHandle) -> Result<String, String> {
    let dir = app_dir(&app)?.join("workspace");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into())
}

#[tauri::command]
fn ensure_workspace(paths: WorkspacePaths) -> Result<WorkspacePaths, String> {
    if paths.root.trim().is_empty() {
        return Err("工作目录不能为空".into());
    }
    let root = PathBuf::from(&paths.root);
    let history = if paths.history_dir.trim().is_empty() {
        root.join("history")
    } else {
        PathBuf::from(&paths.history_dir)
    };
    fs::create_dir_all(&root).map_err(|e| format!("创建工作目录失败: {e}"))?;
    fs::create_dir_all(&history).map_err(|e| format!("创建历史资料目录失败: {e}"))?;
    let assets = root.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("创建资源目录失败: {e}"))?;
    // Convenience README for first-time users
    let readme = history.join("README.md");
    if !readme.exists() {
        let _ = fs::write(
            readme,
            "# 知识库原文\n\n把参考用 Markdown 放到此目录（可含子目录），可在「知识库」侧栏扫描并建立章节索引。\n\n当前正在编辑的方案 Markdown 放在工作目录根下，通过「打开 / 保存」操作。\n",
        );
    }
    Ok(WorkspacePaths {
        root: root.to_string_lossy().into(),
        history_dir: history.to_string_lossy().into(),
    })
}

#[tauri::command]
fn pick_directory(app: AppHandle, title: String) -> Result<Option<String>, String> {
    let folder = app
        .dialog()
        .file()
        .set_title(&title)
        .blocking_pick_folder();
    Ok(folder.map(|p| p.to_string()))
}

#[tauri::command]
fn pick_markdown_file(
    app: AppHandle,
    title: String,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(&title).add_filter("Markdown", &["md", "markdown"]);
    if let Some(path) = default_path.filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_directory(path);
    }
    let file = dialog.blocking_pick_file();
    Ok(file.map(|p| p.to_string()))
}

#[tauri::command]
fn list_workspace_markdown(root: String) -> Result<Vec<LibraryFile>, String> {
    if root.trim().is_empty() {
        return Ok(vec![]);
    }
    let dir = PathBuf::from(&root);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let history = dir.join("history");
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }
        // Skip files that live under history when history is nested path equality edge cases
        if path.starts_with(&history) {
            continue;
        }
        let content = fs::read_to_string(&path).unwrap_or_default();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string();
        let excerpt = content
            .chars()
            .filter(|c| *c != '\r')
            .take(280)
            .collect::<String>()
            .replace('#', "")
            .trim()
            .to_string();
        items.push(LibraryFile {
            title,
            path: path.to_string_lossy().into(),
            excerpt,
            updated_at: file_updated_at(&meta),
            size: meta.len(),
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let normalized = url.trim();
    let lowercase = normalized.to_ascii_lowercase();
    if normalized.chars().any(char::is_control)
        || !(lowercase.starts_with("https://") || lowercase.starts_with("http://"))
    {
        return Err("仅允许打开 http/https 来源链接".into());
    }
    open::that(normalized).map_err(|e| format!("无法打开来源链接: {e}"))
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Err("文件路径为空".into());
    }
    fs::read(&path).map_err(|e| format!("读取失败: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("文件路径为空".into());
    }
    let file_path = PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&file_path, content.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
    Ok(file_path.to_string_lossy().into())
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let new = PathBuf::from(&new_path);
    if !old.exists() {
        return Err("源文件不存在".into());
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&old, &new).map_err(|e| format!("重命名失败: {e}"))?;
    Ok(new.to_string_lossy().into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedImage {
    path: String,
    relative_path: String,
}

#[tauri::command]
fn save_image_to_workspace(
    root: String,
    bytes: Vec<u8>,
    preferred_name: Option<String>,
) -> Result<SavedImage, String> {
    if root.trim().is_empty() {
        return Err("请先配置工作目录".into());
    }
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    let assets = PathBuf::from(&root).join("assets");
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let ext = preferred_name
        .as_deref()
        .and_then(|n| Path::new(n).extension())
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"))
        .unwrap_or_else(|| "png".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file_name = format!("paste-{stamp}.{ext}");
    let path = assets.join(&file_name);
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(SavedImage {
        path: path.to_string_lossy().into(),
        relative_path: format!("assets/{file_name}"),
    })
}

#[tauri::command]
fn list_library_markdown(history_dir: String) -> Result<Vec<LibraryFile>, String> {
    if history_dir.trim().is_empty() {
        return Ok(vec![]);
    }
    let dir = PathBuf::from(&history_dir);
    let files = collect_markdown_files(&dir, 4)?;
    let mut items = Vec::new();
    for path in files {
        let content = fs::read_to_string(&path).unwrap_or_default();
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("未命名")
            .to_string();
        let excerpt = content
            .chars()
            .filter(|c| *c != '\r')
            .take(280)
            .collect::<String>()
            .replace('#', "")
            .trim()
            .to_string();
        items.push(LibraryFile {
            title,
            path: path.to_string_lossy().into(),
            excerpt,
            updated_at: file_updated_at(&meta),
            size: meta.len(),
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

#[tauri::command]
fn list_proposals(history_dir: String) -> Result<Vec<ProposalFile>, String> {
    if history_dir.trim().is_empty() {
        return Ok(vec![]);
    }
    let dir = PathBuf::from(&history_dir);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        items.push(ProposalFile {
            name: path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("未命名")
                .to_string(),
            path: path.to_string_lossy().into(),
            updated_at: file_updated_at(&meta),
            size: meta.len(),
        });
    }
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

#[tauri::command]
fn save_project_file(history_dir: String, mut project: Value) -> Result<String, String> {
    if history_dir.trim().is_empty() {
        return Err("请先配置历史资料目录".into());
    }
    fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;
    // Never persist secrets on disk.
    if let Some(model) = project.get_mut("model") {
        if let Some(obj) = model.as_object_mut() {
            obj.insert("apiKey".into(), Value::String(String::new()));
        }
    }
    if let Some(search) = project.get_mut("search") {
        if let Some(obj) = search.as_object_mut() {
            obj.insert("apiKey".into(), Value::String(String::new()));
        }
    }
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名技术方案");
    let file_path = project
        .get("filePath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&history_dir).join(format!("{}.json", sanitize_filename(name))));
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(obj) = project.as_object_mut() {
        obj.insert(
            "filePath".into(),
            Value::String(file_path.to_string_lossy().into()),
        );
        obj.insert(
            "updatedAt".into(),
            Value::String(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs().to_string())
                    .unwrap_or_else(|_| "0".into()),
            ),
        );
    }
    let text = serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?;
    fs::write(&file_path, text).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().into())
}

#[tauri::command]
fn load_project_file(path: String) -> Result<Value, String> {
    let text = fs::read_to_string(&path).map_err(|e| format!("读取方案失败: {e}"))?;
    let mut project: Value = serde_json::from_str(&text).map_err(|e| format!("解析方案失败: {e}"))?;
    if let Some(obj) = project.as_object_mut() {
        obj.insert("filePath".into(), Value::String(path));
    }
    Ok(project)
}

#[tauri::command]
fn write_library_markdown(
    history_dir: String,
    title: String,
    content: String,
) -> Result<LibraryFile, String> {
    if history_dir.trim().is_empty() {
        return Err("请先配置历史资料目录".into());
    }
    fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;
    let safe = sanitize_filename(if title.trim().is_empty() {
        "未命名资料"
    } else {
        title.trim()
    });
    let path = PathBuf::from(&history_dir).join(format!("{safe}.md"));
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let excerpt = content.chars().take(280).collect::<String>();
    Ok(LibraryFile {
        title: safe,
        path: path.to_string_lossy().into(),
        excerpt,
        updated_at: file_updated_at(&meta),
        size: meta.len(),
    })
}

fn redact(text: &str) -> String {
    Regex::new(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*\S+")
        .unwrap()
        .replace_all(text, "$1=[REDACTED]")
        .chars()
        .take(100_000)
        .collect()
}

/// Resolve process working directory.
/// Absolute paths (user workspace) are allowed; relative paths join the app cwd.
/// No longer forced under the app package directory — workspace can live anywhere.
fn resolve_workdir(cwd: &str) -> Result<PathBuf, String> {
    let requested = if cwd.trim().is_empty() { "." } else { cwd.trim() };
    let path = PathBuf::from(requested);
    let workdir = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    let workdir = workdir.canonicalize().map_err(|e| {
        format!(
            "工作目录无效: {} ({e})",
            workdir.to_string_lossy()
        )
    })?;
    if !workdir.is_dir() {
        return Err(format!("工作目录不存在: {}", workdir.to_string_lossy()));
    }
    Ok(workdir)
}

#[tauri::command]
async fn run_command(app: AppHandle, preset: CommandPreset) -> Result<CommandResult, String> {
    if preset.allow_shell {
        return Err("首版不允许 Shell 模式".into());
    }
    ensure_allowed(&preset.program)?;
    let resolved = resolve_executable(&preset.program)?;
    let cwd = resolve_workdir(&preset.cwd)?;

    let (exit_code, stdout, stderr, duration_ms) = spawn_and_wait(
        &resolved,
        &preset.args,
        &cwd,
        preset.timeout_ms.max(1_000),
        preset.stdin.as_deref(),
    )
    .await?;

    let result = CommandResult {
        exit_code,
        stdout: redact(&stdout),
        stderr: redact(&stderr),
        duration_ms,
    };
    let db = rusqlite::Connection::open(app_dir(&app)?.join("workspace.db"))
        .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO command_runs(program,exit_code,stdout,stderr,duration_ms) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![
            resolved.to_string_lossy().to_string(),
            result.exit_code,
            result.stdout,
            result.stderr,
            result.duration_ms as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
fn detect_tools() -> Result<HashMap<String, String>, String> {
    let mut found = HashMap::new();
    for name in ALLOWED_PROGRAMS {
        if let Ok(path) = resolve_executable(name) {
            found.insert((*name).to_string(), path.to_string_lossy().into());
        }
    }
    Ok(found)
}

#[tauri::command]
fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u64, String> {
    let (shell, shell_args) = resolve_shell()?;
    let workdir = resolve_workdir(cwd.as_deref().unwrap_or("."))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开终端失败: {e}"))?;

    let mut cmd = CommandBuilder::new(shell);
    for a in shell_args {
        cmd.arg(a);
    }
    cmd.cwd(workdir);
    if let Some(path) = child_path_env() {
        cmd.env("PATH", path);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;
    drop(pair.slave);

    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("克隆终端输出失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取终端写入端失败: {e}"))?;

    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(id, session.clone());
    }

    let app_out = app.clone();
    let session_for_exit = session.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_out.emit("terminal://data", TerminalOutputEvent { id, data });
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let code = session_for_exit
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok().flatten())
            .map(|status| status.exit_code());
        let _ = app_out.emit("terminal://exit", TerminalExitEvent { id, code });
    });

    Ok(id)
}

#[tauri::command]
fn terminal_write(state: State<'_, TerminalState>, id: u64, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入终端失败: {e}"))?;
    writer.flush().map_err(|e| format!("刷新终端失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(state: State<'_, TerminalState>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    let master = session.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(5),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整终端尺寸失败: {e}"))
}

#[tauri::command]
fn terminal_close(state: State<'_, TerminalState>, id: u64) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.remove(&id) {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalState::default())
        .setup(|app| {
            init_db(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            generate_text,
            store_secret,
            search_web,
            save_markdown,
            save_binary_file,
            save_docx_export,
            run_command,
            detect_tools,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            open_workspace_powershell,
            default_workspace_root,
            ensure_workspace,
            pick_directory,
            pick_markdown_file,
            list_workspace_markdown,
            list_library_markdown,
            list_proposals,
            save_project_file,
            load_project_file,
            read_text_file,
            open_external_url,
            read_binary_file,
            write_text_file,
            rename_file,
            write_library_markdown,
            save_image_to_workspace
            ,knowledge::knowledge_scan
            ,knowledge::knowledge_import_markdown
            ,knowledge::knowledge_index_pending
            ,knowledge::knowledge_list
            ,knowledge::knowledge_sections
            ,knowledge::knowledge_search
            ,knowledge::knowledge_section_scope
            ,knowledge::knowledge_chunk
            ,knowledge::knowledge_set_chunk_quality
            ,knowledge::knowledge_set_section_quality
            ,knowledge::knowledge_section_chunks
            ,knowledge::knowledge_remove
            ,knowledge::knowledge_delete_file
            ,knowledge::knowledge_import_web
            ,knowledge::knowledge_analyze_markdown
            ,knowledge::knowledge_apply_headings
            ,knowledge::knowledge_backups
            ,knowledge::knowledge_restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("failed to run application");
}
