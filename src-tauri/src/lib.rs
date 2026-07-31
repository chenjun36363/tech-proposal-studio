use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

mod knowledge;
#[path = "integrations/mineru.rs"]
mod mineru;
#[path = "integrations/model.rs"]
mod model;
#[path = "agent/memory.rs"]
mod memory;
#[path = "platform/credentials.rs"]
mod credentials;
#[path = "platform/export.rs"]
mod export;
#[path = "integrations/search.rs"]
mod search;
#[path = "platform/system.rs"]
mod system;
#[path = "platform/terminal.rs"]
mod terminal;
#[path = "integrations/ccswitch.rs"]
mod ccswitch;
#[path = "platform/process.rs"]
mod process;
#[path = "agent/conversations.rs"]
mod agent_conversations;
#[path = "workspace/connections.rs"]
mod connections;
#[path = "workspace/git.rs"]
mod git;
#[path = "platform/privileged.rs"]
mod privileged;
#[path = "agent/skills.rs"]
mod skills;
#[path = "integrations/updater.rs"]
mod updater;
pub(crate) use process::{child_path_env, resolve_shell, resolve_workdir};
use process::{detect_tools, init_db, open_workspace_powershell, run_command, run_command_stream};

use terminal::{terminal_close, terminal_open, terminal_resize, terminal_write, TerminalState};
use git::{git_branches, git_commit, git_commit_diff, git_create_branch, git_diff, git_discard, git_fetch, git_init, git_log, git_pull, git_push, git_set_remote, git_stage, git_stage_all, git_staged_summary, git_stash_pop, git_stash_push, git_status, git_switch_branch, git_unstage, git_unstage_all};


pub(crate) use model::ModelConfig;
use model::{agent_completion, generate_text, generate_text_stream, list_models, model_proxy_cancel, model_proxy_json, model_proxy_stream, ModelProxyState};
pub(crate) use credentials::load_secret;
use credentials::store_secret;
use export::{save_binary_file, save_docx_export, save_markdown, sanitize_filename};
use search::search_web;
use system::open_external_url;

#[tauri::command]
fn open_workspace_directory(root: String) -> Result<(), String> {
    let path = PathBuf::from(root.trim());
    if !path.is_dir() {
        return Err("工作区目录不存在".into());
    }
    open::that(&path).map_err(|error| format!("无法在文件浏览器中打开工作区: {error}"))
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamEvent {
    run_id: String,
    channel: String,
    content: String,
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
    let legacy_history = root.join("history");
    let knowledge = root.join("knowledge");
    let requested_history = if paths.history_dir.trim().is_empty() {
        knowledge.clone()
    } else {
        PathBuf::from(&paths.history_dir)
    };
    fs::create_dir_all(&root).map_err(|e| format!("创建工作目录失败: {e}"))?;
    let history = if requested_history == legacy_history || requested_history == knowledge {
        if !knowledge.exists() && legacy_history.exists() {
            fs::rename(&legacy_history, &knowledge)
                .map_err(|e| format!("迁移知识库目录失败: {e}"))?;
        }
        knowledge
    } else {
        requested_history
    };
    fs::create_dir_all(&history).map_err(|e| format!("创建知识库目录失败: {e}"))?;
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
fn pick_document_file(
    app: AppHandle,
    title: String,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title(&title)
        .add_filter("Word / PDF", &["pdf", "doc", "docx"]);
    if let Some(path) = default_path.filter(|s| !s.trim().is_empty()) {
        dialog = dialog.set_directory(path);
    }
    let file = dialog.blocking_pick_file();
    Ok(file.map(|p| p.to_string()))
}

#[tauri::command]
async fn convert_document_with_mineru(
    request: mineru::ConvertDocumentRequest,
) -> Result<mineru::ConvertDocumentResult, String> {
    mineru::convert_document(request).await
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
    let knowledge = dir.join("knowledge");
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
        // Keep knowledge documents out of the proposal file list.
        if path.starts_with(&knowledge) {
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

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err("文件不存在".into());
    }
    fs::remove_file(&target).map_err(|e| format!("删除失败: {e}"))
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
        return Err("请先配置知识库目录".into());
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
        return Err("请先配置知识库目录".into());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(TerminalState::default())
        .manage(ModelProxyState::default())
        .manage(privileged::PrivilegedProcessState::default())
        .setup(|app| {
            init_db(&app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            git_status,
            git_branches,
            git_switch_branch,
            git_create_branch,
            git_stash_push,
            git_stash_pop,
            git_init,
            git_stage,
            git_unstage,
            git_commit,
            git_diff,
            git_set_remote,
            git_pull,
            git_push,
            git_fetch,
            git_log,
            git_commit_diff,
            git_stage_all,
            git_unstage_all,
            git_discard,
            git_staged_summary,
            list_models,
            generate_text,
            generate_text_stream,
            agent_completion,
            model_proxy_json,
            model_proxy_cancel,
            model_proxy_stream,
            store_secret,
            search_web,
            save_markdown,
            save_binary_file,
            save_docx_export,
            run_command,
            run_command_stream,
            detect_tools,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            open_workspace_powershell,
            open_workspace_directory,
            default_workspace_root,
            ensure_workspace,
            pick_directory,
            pick_markdown_file,
            pick_document_file,
            convert_document_with_mineru,
            list_workspace_markdown,
            list_library_markdown,
            list_proposals,
            save_project_file,
            load_project_file,
            read_text_file,
            open_external_url,
            read_binary_file,
            write_text_file,
            agent_conversations::agent_conversation_list,
            agent_conversations::agent_conversation_get,
            agent_conversations::agent_conversation_upsert,
            agent_conversations::agent_conversation_patch,
            agent_conversations::agent_conversation_delete,
            agent_conversations::agent_conversation_clear_project,
            rename_file,
            delete_file,
            write_library_markdown,
            save_image_to_workspace
            ,privileged::privileged_file_operation
            ,privileged::privileged_run_powershell
            ,privileged::privileged_cancel_powershell
            ,connections::load_workspace_connections
            ,connections::save_workspace_connections
            ,ccswitch::list_ccswitch_providers
            ,knowledge::knowledge_scan
            ,knowledge::knowledge_import_markdown
            ,updater::app_update_check
            ,updater::app_update_install
            ,knowledge::knowledge_move_workspace_markdown
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
            ,knowledge::knowledge_fetch_web_page
            ,knowledge::knowledge_analyze_markdown
            ,knowledge::knowledge_apply_headings
            ,knowledge::knowledge_backups
            ,knowledge::knowledge_restore_backup
            ,memory::memory_list
            ,memory::memory_read
            ,memory::memory_search
            ,memory::memory_write
            ,memory::memory_propose
            ,memory::memory_accept
            ,memory::memory_delete
            ,memory::memory_rebuild
            ,skills::skill_discover
            ,skills::skill_read
            ,skills::skill_read_resource
            ,skills::skill_validate
            ,skills::skill_create
            ,skills::skill_install
            ,skills::skill_delete
            ,skills::skill_package
            ,skills::skill_market_search
            ,skills::skill_market_detail
            ,skills::skill_check_updates
            ,skills::skill_update
            ,skills::skill_runtime_status
            ,skills::skill_run_command
        ])
        .run(tauri::generate_context!())
        .expect("failed to run application");
}
