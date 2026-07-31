use crate::app_dir;
use regex::Regex;
use std::{fs, path::Path};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub(crate) fn save_markdown(
    app: AppHandle,
    project_name: String,
    markdown: String,
) -> Result<String, String> {
    let exports = app_dir(&app)?.join("exports");
    fs::create_dir_all(&exports).map_err(|error| error.to_string())?;
    let path = exports.join(format!("{}.md", sanitize_filename(&project_name)));
    fs::write(&path, markdown).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into())
}

#[tauri::command]
pub(crate) fn save_binary_file(
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
        for (name, extensions) in list {
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(name, &refs);
        }
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file.to_string();
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, &bytes).map_err(|error| format!("写入失败: {error}"))?;
    Ok(Some(path))
}

#[tauri::command]
pub(crate) fn save_docx_export(
    app: AppHandle,
    project_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let exports = app_dir(&app)?.join("exports");
    fs::create_dir_all(&exports).map_err(|error| error.to_string())?;
    let path = exports.join(format!("{}.docx", sanitize_filename(&project_name)));
    fs::write(&path, &bytes).map_err(|error| format!("写入失败: {error}"))?;
    Ok(path.to_string_lossy().into())
}

pub(crate) fn sanitize_filename(name: &str) -> String {
    let cleaned = Regex::new(r#"[<>:"/\\|?*]"#)
        .expect("filename regex is valid")
        .replace_all(name, "_")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "untitled".into()
    } else {
        cleaned
    }
}
