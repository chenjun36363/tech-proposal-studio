use crate::{child_path_env, resolve_shell, resolve_workdir};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

struct TerminalSession {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn io::Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub(crate) struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, Arc<TerminalSession>>>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
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

#[tauri::command]
pub(crate) fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<u64, String> {
    let (shell, shell_args) = resolve_shell()?;
    let workdir = resolve_workdir(cwd.as_deref().unwrap_or("."))?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(10),
            cols: cols.max(40),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("打开终端失败: {error}"))?;
    let mut command = CommandBuilder::new(shell);
    for argument in shell_args {
        command.arg(argument);
    }
    command.cwd(workdir);
    if let Some(path) = child_path_env() {
        command.env("PATH", path);
    }
    command.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("启动 PowerShell 失败: {error}"))?;
    drop(pair.slave);
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("克隆终端输出失败: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("获取终端写入端失败: {error}"))?;
    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .insert(id, session.clone());

    let app_out = app.clone();
    let session_for_exit = session.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let _ = app_out.emit(
                        "terminal://data",
                        TerminalOutputEvent {
                            id,
                            data: String::from_utf8_lossy(&buffer[..size]).into_owned(),
                        },
                    );
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
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
pub(crate) fn terminal_write(
    state: State<'_, TerminalState>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|error| error.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    let mut writer = session.writer.lock().map_err(|error| error.to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("写入终端失败: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("刷新终端失败: {error}"))
}

#[tauri::command]
pub(crate) fn terminal_resize(
    state: State<'_, TerminalState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|error| error.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "终端会话不存在".to_string())?;
    let master = session.master.lock().map_err(|error| error.to_string())?;
    let result = master
        .resize(PtySize {
            rows: rows.max(5),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整终端尺寸失败: {error}"));
    result
}

#[tauri::command]
pub(crate) fn terminal_close(state: State<'_, TerminalState>, id: u64) -> Result<(), String> {
    if let Some(session) = state
        .sessions
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id)
    {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
