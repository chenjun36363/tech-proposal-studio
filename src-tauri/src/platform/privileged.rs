use crate::{app_dir, child_path_env, resolve_shell};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tokio::{
    process::Command,
    time::{sleep, Duration},
};

#[derive(Default)]
pub struct PrivilegedProcessState(Mutex<HashMap<String, u32>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationRequest {
    operation: String,
    path: String,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    delete_mode: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    operation: String,
    path: String,
    destination: Option<String>,
    kind: Option<String>,
    size: Option<u64>,
    entries: Option<Vec<FileEntry>>,
    content: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerShellResult {
    run_id: String,
    exit_code: i32,
    log_path: String,
    output_tail: String,
}

fn require_path(value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        Err("路径不能为空".into())
    } else {
        Ok(PathBuf::from(value))
    }
}

fn copy_recursively(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(destination).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursively(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(source, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn recycle(path: &Path) -> Result<(), String> {
    let (shell, mut args) = resolve_shell()?;
    args.extend(["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(),
        "Add-Type -AssemblyName Microsoft.VisualBasic; $p=$env:GOUAN_DELETE_TARGET; $ui=[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs; $recycle=[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin; if ([IO.Directory]::Exists($p)) {[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,$ui,$recycle)} elseif ([IO.File]::Exists($p)) {[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,$ui,$recycle)} else {throw '目标不存在'}".into()]);
    let status = std::process::Command::new(shell)
        .args(args)
        .env("GOUAN_DELETE_TARGET", path)
        .env("PATH", child_path_env().unwrap_or_default())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "移入回收站失败，退出码：{}",
            status.code().unwrap_or(-1)
        ))
    }
}

#[tauri::command]
pub fn privileged_file_operation(
    request: FileOperationRequest,
) -> Result<FileOperationResult, String> {
    let path = require_path(&request.path)?;
    let mut result = FileOperationResult {
        operation: request.operation.clone(),
        path: path.to_string_lossy().into(),
        destination: request.destination.clone(),
        kind: None,
        size: None,
        entries: None,
        content: None,
    };
    match request.operation.as_str() {
        "stat" => {
            let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
            result.kind = Some(if meta.is_dir() { "directory" } else { "file" }.into());
            result.size = Some(meta.len());
        }
        "list" => {
            let mut rows = Vec::new();
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let meta = entry.metadata().map_err(|e| e.to_string())?;
                rows.push(FileEntry {
                    name: entry.file_name().to_string_lossy().into(),
                    path: entry.path().to_string_lossy().into(),
                    kind: if meta.is_dir() { "directory" } else { "file" }.into(),
                    size: meta.len(),
                });
            }
            result.entries = Some(rows);
        }
        "read_text" => result.content = Some(fs::read_to_string(&path).map_err(|e| e.to_string())?),
        "write_text" => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, request.content.unwrap_or_default()).map_err(|e| e.to_string())?;
        }
        "create_directory" => fs::create_dir_all(&path).map_err(|e| e.to_string())?,
        "copy" => copy_recursively(
            &path,
            &require_path(request.destination.as_deref().ok_or("缺少 destination")?)?,
        )?,
        "move" | "rename" => {
            let dest = require_path(request.destination.as_deref().ok_or("缺少 destination")?)?;
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(&path, &dest).map_err(|e| e.to_string())?;
        }
        "delete" => {
            if request.delete_mode.as_deref() == Some("trash") {
                recycle(&path)?
            } else if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|e| e.to_string())?
            } else {
                fs::remove_file(&path).map_err(|e| e.to_string())?
            }
        }
        _ => return Err(format!("未知文件操作：{}", request.operation)),
    }
    Ok(result)
}

fn tail(path: &Path, max: usize) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let start = bytes.len().saturating_sub(max);
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

#[tauri::command]
pub async fn privileged_run_powershell(
    app: AppHandle,
    state: State<'_, PrivilegedProcessState>,
    run_id: String,
    script: String,
    cwd: Option<String>,
) -> Result<PowerShellResult, String> {
    if run_id.trim().is_empty() || script.trim().is_empty() {
        return Err("runId 和 script 不能为空".into());
    }
    let dir = app_dir(&app)?.join("agent-command-logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_run_id = run_id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_");
    let log_path = dir.join(format!("{stamp}-{safe_run_id}.log"));
    let stdout = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
    let (shell, mut args) = resolve_shell()?;
    args.extend([
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        script,
    ]);
    let mut command = Command::new(shell);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .kill_on_drop(true);
    if let Some(path) = child_path_env() {
        command.env("PATH", path);
    }
    if let Some(cwd) = cwd.filter(|v| !v.trim().is_empty()) {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    let pid = child.id().ok_or("无法取得 PowerShell 进程 ID")?;
    state
        .0
        .lock()
        .map_err(|_| "进程状态锁已损坏")?
        .insert(run_id.clone(), pid);
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => sleep(Duration::from_millis(100)).await,
        }
    };
    state
        .0
        .lock()
        .map_err(|_| "进程状态锁已损坏")?
        .remove(&run_id);
    Ok(PowerShellResult {
        run_id,
        exit_code: status.code().unwrap_or(-1),
        log_path: log_path.to_string_lossy().into(),
        output_tail: tail(&log_path, 64 * 1024)?,
    })
}

#[tauri::command]
pub fn privileged_cancel_powershell(
    state: State<'_, PrivilegedProcessState>,
    run_id: String,
) -> Result<bool, String> {
    let pid = state
        .0
        .lock()
        .map_err(|_| "进程状态锁已损坏")?
        .remove(&run_id);
    let Some(pid) = pid else { return Ok(false) };
    let pid_text = pid.to_string();
    let status = std::process::Command::new("taskkill")
        .args(["/PID", pid_text.as_str(), "/T", "/F"])
        .status()
        .map_err(|e| e.to_string())?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str, path: &Path) -> FileOperationRequest {
        FileOperationRequest {
            operation: operation.into(),
            path: path.to_string_lossy().into(),
            destination: None,
            content: None,
            delete_mode: None,
        }
    }

    #[test]
    fn structured_file_operations_round_trip() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("gouan-privileged-{nonce}"));
        let file = root.join("a.txt");
        let mkdir = request("create_directory", &root);
        privileged_file_operation(mkdir).unwrap();
        let mut write = request("write_text", &file);
        write.content = Some("hello".into());
        privileged_file_operation(write).unwrap();
        let read = privileged_file_operation(request("read_text", &file)).unwrap();
        assert_eq!(read.content.as_deref(), Some("hello"));
        let copied = root.join("b.txt");
        let mut copy = request("copy", &file);
        copy.destination = Some(copied.to_string_lossy().into());
        privileged_file_operation(copy).unwrap();
        let list = privileged_file_operation(request("list", &root)).unwrap();
        assert_eq!(list.entries.unwrap().len(), 2);
        let mut delete = request("delete", &root);
        delete.delete_mode = Some("permanent".into());
        privileged_file_operation(delete).unwrap();
        assert!(!root.exists());
    }
}
