use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFileSnapshot {
    path: String,
    content: String,
    sha256: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub(crate) enum CheckedWriteResult {
    #[serde(rename = "saved")]
    Saved { snapshot: TextFileSnapshot },
    #[serde(rename = "conflict")]
    Conflict { snapshot: Option<TextFileSnapshot> },
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn updated_at(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|| "0".into())
}

fn read_snapshot(path: &Path) -> Result<TextFileSnapshot, String> {
    let bytes = fs::read(path).map_err(|error| format!("读取失败: {error}"))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|error| format!("文件不是有效 UTF-8 文本: {error}"))?;
    let metadata = fs::metadata(path).map_err(|error| format!("读取文件信息失败: {error}"))?;
    Ok(TextFileSnapshot {
        path: path.to_string_lossy().into_owned(),
        content,
        sha256: hash_bytes(&bytes),
        updated_at: updated_at(&metadata),
    })
}

fn write_checked(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
    force: bool,
) -> Result<CheckedWriteResult, String> {
    let current = if path.exists() {
        Some(read_snapshot(path)?)
    } else {
        None
    };
    if !force {
        let matches = match (expected_sha256, current.as_ref()) {
            (Some(expected), Some(snapshot)) => snapshot.sha256 == expected,
            (None, None) => true,
            (None, Some(_)) | (Some(_), None) => false,
        };
        if !matches {
            return Ok(CheckedWriteResult::Conflict { snapshot: current });
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(path, content.as_bytes()).map_err(|error| format!("写入失败: {error}"))?;
    Ok(CheckedWriteResult::Saved {
        snapshot: read_snapshot(path)?,
    })
}

#[tauri::command]
pub(crate) fn read_text_file_snapshot(path: String) -> Result<TextFileSnapshot, String> {
    if path.trim().is_empty() {
        return Err("文件路径为空".into());
    }
    read_snapshot(Path::new(&path))
}

#[tauri::command]
pub(crate) fn write_text_file_checked(
    path: String,
    content: String,
    expected_sha256: Option<String>,
    force: bool,
) -> Result<CheckedWriteResult, String> {
    if path.trim().is_empty() {
        return Err("文件路径为空".into());
    }
    write_checked(
        Path::new(&path),
        &content,
        expected_sha256.as_deref(),
        force,
    )
}

#[tauri::command]
pub(crate) fn save_text_file_as(
    app: AppHandle,
    default_name: String,
    content: String,
    default_directory: Option<String>,
) -> Result<Option<TextFileSnapshot>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("另存 Markdown")
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md", "markdown"]);
    if let Some(directory) = default_directory.filter(|value| !value.trim().is_empty()) {
        dialog = dialog.set_directory(directory);
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = PathBuf::from(file.to_string());
    let result = write_checked(&path, &content, None, false)?;
    match result {
        CheckedWriteResult::Saved { snapshot } => Ok(Some(snapshot)),
        CheckedWriteResult::Conflict { .. } => Err("所选文件已存在，请选择其他文件名".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("tech-proposal-studio-{name}-{nonce}.md"))
    }

    #[test]
    fn snapshot_hash_is_stable() {
        let path = test_path("snapshot");
        fs::write(&path, "hello").unwrap();
        let first = read_snapshot(&path).unwrap();
        let second = read_snapshot(&path).unwrap();
        assert_eq!(first.sha256, second.sha256);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn checked_write_detects_conflict_and_force_overwrites() {
        let path = test_path("checked");
        fs::write(&path, "base").unwrap();
        let base = read_snapshot(&path).unwrap();
        fs::write(&path, "external").unwrap();
        let result = write_checked(&path, "editor", Some(&base.sha256), false).unwrap();
        assert!(matches!(result, CheckedWriteResult::Conflict { .. }));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        let forced = write_checked(&path, "editor", Some(&base.sha256), true).unwrap();
        assert!(matches!(forced, CheckedWriteResult::Saved { .. }));
        assert_eq!(fs::read_to_string(&path).unwrap(), "editor");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn checked_write_creates_new_file_without_expected_hash() {
        let path = test_path("new");
        let result = write_checked(&path, "new", None, false).unwrap();
        assert!(matches!(result, CheckedWriteResult::Saved { .. }));
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let _ = fs::remove_file(path);
    }
}
