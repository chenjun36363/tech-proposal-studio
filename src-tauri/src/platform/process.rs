use crate::{app_dir, StreamEvent};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

const ALLOWED_PROGRAMS: &[&str] = &[
    "node",
    "npm",
    "npx",
    "pnpm",
    "git",
    "claude",
    "codex",
    "opencode",
    "codebuddy",
    "pwsh",
    "powershell",
];

pub(crate) fn init_db(app: &AppHandle) -> Result<(), String> {
    let dir = app_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let db =
        rusqlite::Connection::open(dir.join("workspace.db")).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS command_runs(
            id INTEGER PRIMARY KEY,
            program TEXT NOT NULL,
            exit_code INTEGER NOT NULL,
            stdout TEXT NOT NULL,
            stderr TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .map_err(|error| error.to_string())?;
    crate::connections::initialize_schema(&db)?;
    crate::drafts::initialize_schema(&db)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandPreset {
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
pub(crate) struct CommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u128,
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

pub(crate) fn resolve_executable(program: &str) -> Result<PathBuf, String> {
    let direct = PathBuf::from(program);
    if direct.is_absolute() && direct.is_file() && is_windows_exec(&direct) {
        return Ok(direct);
    }

    // OpenCode's `run` command requires a positional message and does not consume
    // plain stdin as that message. Prefer its native binary so multiline prompts
    // bypass cmd.exe parsing when passed as an argument.
    if program.eq_ignore_ascii_case("opencode") {
        for dir in tool_search_dirs() {
            let candidate = dir
                .join("node_modules")
                .join("opencode-ai")
                .join("bin")
                .join("opencode.exe");
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

pub(crate) fn child_path_env() -> Option<std::ffi::OsString> {
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

pub(crate) fn quote_cmd_arg(arg: &str) -> String {
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

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动失败: {e}（程序：{}）", program.display()))?;
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

pub(crate) fn resolve_shell() -> Result<(PathBuf, Vec<String>), String> {
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
pub(crate) fn open_workspace_powershell(
    cwd: String,
    program: Option<String>,
) -> Result<(), String> {
    let workdir = resolve_workdir(&cwd)?;
    let (shell, mut args) = resolve_shell()?;

    if let Some(program) = program {
        if !["claude", "codex", "opencode", "codebuddy"].contains(&program.as_str()) {
            return Err("仅允许启动已配置的 Agent CLI".into());
        }
        let executable = resolve_executable(&program)?;
        let escaped = executable.to_string_lossy().replace('\'', "''");
        args.extend([
            "-NoExit".into(),
            "-Command".into(),
            format!("& '{escaped}'"),
        ]);
    }

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
pub(crate) fn resolve_workdir(cwd: &str) -> Result<PathBuf, String> {
    let requested = if cwd.trim().is_empty() {
        "."
    } else {
        cwd.trim()
    };
    let path = PathBuf::from(requested);
    let workdir = if path.is_absolute() {
        path
    } else {
        env::current_dir().map_err(|e| e.to_string())?.join(path)
    };
    let workdir = workdir
        .canonicalize()
        .map_err(|e| format!("工作目录无效: {} ({e})", workdir.to_string_lossy()))?;
    if !workdir.is_dir() {
        return Err(format!("工作目录不存在: {}", workdir.to_string_lossy()));
    }
    Ok(workdir)
}

#[tauri::command]
pub(crate) async fn run_command(
    app: AppHandle,
    preset: CommandPreset,
) -> Result<CommandResult, String> {
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
pub(crate) async fn run_command_stream(
    app: AppHandle,
    run_id: String,
    preset: CommandPreset,
) -> Result<CommandResult, String> {
    if preset.allow_shell {
        return Err("首版不允许 Shell 模式".into());
    }
    ensure_allowed(&preset.program)?;
    let resolved = resolve_executable(&preset.program)?;
    let cwd = resolve_workdir(&preset.cwd)?;
    let started = std::time::Instant::now();
    let use_cmd = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut command = if use_cmd {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/D").arg("/S").arg("/C");
        let mut line = quote_cmd_arg(&resolved.to_string_lossy());
        for arg in &preset.args {
            line.push(' ');
            line.push_str(&quote_cmd_arg(arg));
        }
        cmd.arg(line);
        cmd
    } else {
        let mut cmd = Command::new(&resolved);
        cmd.args(&preset.args);
        cmd
    };
    command
        .current_dir(&cwd)
        .stdin(if preset.stdin.is_some() {
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
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动失败: {e}（程序：{}）", resolved.display()))?;
    if let Some(data) = preset.stdin.as_deref() {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(data.as_bytes())
                .await
                .map_err(|e| format!("写入 stdin 失败: {e}"))?;
        }
    }
    let mut stdout = child.stdout.take().ok_or("无法读取标准输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取错误输出")?;
    let app_out = app.clone();
    let stdout_run = run_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut all = Vec::new();
        let mut buffer = [0u8; 2048];
        loop {
            let n = stdout.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buffer[..n]);
            let content = redact(&String::from_utf8_lossy(&buffer[..n]));
            let _ = app_out.emit(
                "session://command",
                StreamEvent {
                    run_id: stdout_run.clone(),
                    channel: "stdout".into(),
                    content,
                },
            );
        }
        Ok::<Vec<u8>, String>(all)
    });
    let app_err = app.clone();
    let stderr_run = run_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut all = Vec::new();
        let mut buffer = [0u8; 2048];
        loop {
            let n = stderr.read(&mut buffer).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            all.extend_from_slice(&buffer[..n]);
            let content = redact(&String::from_utf8_lossy(&buffer[..n]));
            let _ = app_err.emit(
                "session://command",
                StreamEvent {
                    run_id: stderr_run.clone(),
                    channel: "stderr".into(),
                    content,
                },
            );
        }
        Ok::<Vec<u8>, String>(all)
    });
    let status = match timeout(
        Duration::from_millis(preset.timeout_ms.max(1_000)),
        child.wait(),
    )
    .await
    {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = child.kill().await;
            return Err("命令执行超时".into());
        }
    };
    let stdout = stdout_task.await.map_err(|e| e.to_string())??;
    let stderr = stderr_task.await.map_err(|e| e.to_string())??;
    let result = CommandResult {
        exit_code: status.code().unwrap_or(-1),
        stdout: redact(&String::from_utf8_lossy(&stdout)),
        stderr: redact(&String::from_utf8_lossy(&stderr)),
        duration_ms: started.elapsed().as_millis(),
    };
    let db = rusqlite::Connection::open(app_dir(&app)?.join("workspace.db"))
        .map_err(|e| e.to_string())?;
    db.execute("INSERT INTO command_runs(program,exit_code,stdout,stderr,duration_ms) VALUES(?1,?2,?3,?4,?5)", rusqlite::params![resolved.to_string_lossy().to_string(), result.exit_code, result.stdout, result.stderr, result.duration_ms as i64]).map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn detect_tools() -> Result<HashMap<String, String>, String> {
    let mut found = HashMap::new();
    for name in ALLOWED_PROGRAMS {
        if let Ok(path) = resolve_executable(name) {
            found.insert((*name).to_string(), path.to_string_lossy().into());
        }
    }
    Ok(found)
}
