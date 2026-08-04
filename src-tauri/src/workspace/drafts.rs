use crate::app_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::AppHandle;

const DB_FILENAME: &str = "workspace.db";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceDocumentDraft {
    draft_id: String,
    workspace_root: String,
    file_path: Option<String>,
    project_id: String,
    project_name: String,
    markdown: String,
    base_hash: Option<String>,
    runtime_label: String,
    updated_at: String,
}

pub(crate) fn initialize_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_document_drafts(
            draft_id TEXT PRIMARY KEY,
            workspace_root TEXT NOT NULL,
            file_path TEXT,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL,
            markdown TEXT NOT NULL,
            base_hash TEXT,
            runtime_label TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_document_drafts_root_file
          ON workspace_document_drafts(workspace_root, file_path, updated_at DESC);",
    )
    .map_err(|error| format!("初始化文档草稿表失败: {error}"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(DB_FILENAME))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db = Connection::open(database_path(app)?)
        .map_err(|error| format!("打开草稿数据库失败: {error}"))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("配置草稿数据库等待时间失败: {error}"))?;
    initialize_schema(&db)?;
    Ok(db)
}

fn path_key(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field}不能为空"));
    }
    let path = PathBuf::from(trimmed);
    let normalized = fs::canonicalize(&path).unwrap_or(path);
    let key = normalized
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    #[cfg(windows)]
    return Ok(key.to_lowercase());
    #[cfg(not(windows))]
    Ok(key)
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let path = PathBuf::from(trimmed);
        let normalized = fs::canonicalize(&path).unwrap_or(path);
        let result = normalized.to_string_lossy().to_string();
        #[cfg(windows)]
        return Some(result.to_lowercase());
        #[cfg(not(windows))]
        Some(result)
    })
}

fn upsert(db: &Connection, mut draft: WorkspaceDocumentDraft) -> Result<(), String> {
    draft.workspace_root = path_key(&draft.workspace_root, "工作区根目录")?;
    draft.file_path = normalize_optional_path(draft.file_path);
    if draft.draft_id.trim().is_empty() || draft.project_id.trim().is_empty() {
        return Err("草稿 ID 和项目 ID 不能为空".into());
    }
    if draft.updated_at.trim().is_empty() {
        return Err("草稿更新时间不能为空".into());
    }
    db.execute(
        "INSERT INTO workspace_document_drafts(
           draft_id, workspace_root, file_path, project_id, project_name,
           markdown, base_hash, runtime_label, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(draft_id) DO UPDATE SET
           workspace_root = excluded.workspace_root,
           file_path = excluded.file_path,
           project_id = excluded.project_id,
           project_name = excluded.project_name,
           markdown = excluded.markdown,
           base_hash = excluded.base_hash,
           runtime_label = excluded.runtime_label,
           updated_at = excluded.updated_at",
        params![
            draft.draft_id,
            draft.workspace_root,
            draft.file_path,
            draft.project_id,
            draft.project_name,
            draft.markdown,
            draft.base_hash,
            draft.runtime_label,
            draft.updated_at,
        ],
    )
    .map_err(|error| format!("保存文档草稿失败: {error}"))?;
    Ok(())
}

fn list(db: &Connection, workspace_root: &str) -> Result<Vec<WorkspaceDocumentDraft>, String> {
    let key = path_key(workspace_root, "工作区根目录")?;
    let mut statement = db
        .prepare(
            "SELECT draft_id, workspace_root, file_path, project_id, project_name,
                    markdown, base_hash, runtime_label, updated_at
             FROM workspace_document_drafts
             WHERE workspace_root = ?1
             ORDER BY updated_at DESC, draft_id DESC",
        )
        .map_err(|error| format!("准备读取草稿失败: {error}"))?;
    let rows = statement
        .query_map(params![key], |row| {
            Ok(WorkspaceDocumentDraft {
                draft_id: row.get(0)?,
                workspace_root: row.get(1)?,
                file_path: row.get(2)?,
                project_id: row.get(3)?,
                project_name: row.get(4)?,
                markdown: row.get(5)?,
                base_hash: row.get(6)?,
                runtime_label: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("读取文档草稿失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("解析文档草稿失败: {error}"))
}

#[tauri::command]
pub(crate) fn save_workspace_document_draft(
    app: AppHandle,
    draft: WorkspaceDocumentDraft,
) -> Result<(), String> {
    upsert(&open_db(&app)?, draft)
}

#[tauri::command]
pub(crate) fn list_workspace_document_drafts(
    app: AppHandle,
    workspace_root: String,
) -> Result<Vec<WorkspaceDocumentDraft>, String> {
    list(&open_db(&app)?, &workspace_root)
}

#[tauri::command]
pub(crate) fn delete_workspace_document_draft(
    app: AppHandle,
    draft_id: String,
) -> Result<(), String> {
    if draft_id.trim().is_empty() {
        return Err("草稿 ID 不能为空".into());
    }
    open_db(&app)?
        .execute(
            "DELETE FROM workspace_document_drafts WHERE draft_id = ?1",
            params![draft_id],
        )
        .map_err(|error| format!("删除文档草稿失败: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(id: &str, markdown: &str) -> WorkspaceDocumentDraft {
        WorkspaceDocumentDraft {
            draft_id: id.into(),
            workspace_root: std::env::temp_dir().to_string_lossy().into_owned(),
            file_path: Some(
                std::env::temp_dir()
                    .join("proposal.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
            project_id: "project-1".into(),
            project_name: "方案".into(),
            markdown: markdown.into(),
            base_hash: Some("base".into()),
            runtime_label: "dev".into(),
            updated_at: "2026-07-31T12:00:00.000Z".into(),
        }
    }

    #[test]
    fn drafts_round_trip_without_secret_fields() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        upsert(&db, draft("draft-a", "# A")).unwrap();
        let rows = list(&db, &std::env::temp_dir().to_string_lossy()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].markdown, "# A");
        let columns: Vec<String> = db
            .prepare("PRAGMA table_info(workspace_document_drafts)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(!columns
            .iter()
            .any(|name| name.to_ascii_lowercase().contains("key")));
    }

    #[test]
    fn separate_runtime_draft_ids_do_not_overwrite_each_other() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        upsert(&db, draft("dev-draft", "dev text")).unwrap();
        let mut production = draft("production-draft", "production text");
        production.runtime_label = "production".into();
        production.updated_at = "2026-07-31T12:00:01.000Z".into();
        upsert(&db, production).unwrap();
        let rows = list(&db, &std::env::temp_dir().to_string_lossy()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].draft_id, "production-draft");
    }
    #[test]
    fn draft_payload_rejects_secret_fields() {
        let payload = serde_json::json!({
            "draftId": "draft-a",
            "workspaceRoot": "c:\\workspace",
            "filePath": null,
            "projectId": "project-1",
            "projectName": "方案",
            "markdown": "# 正文",
            "baseHash": null,
            "runtimeLabel": "dev",
            "updatedAt": "2026-07-31T12:00:00.000Z",
            "apiKey": "must-not-be-accepted"
        });
        assert!(serde_json::from_value::<WorkspaceDocumentDraft>(payload).is_err());
    }
}
