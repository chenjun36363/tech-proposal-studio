use crate::app_dir;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

const DB_FILENAME: &str = "workspace.db";

pub(crate) fn initialize_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_connections(
            workspace_root TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )
    .map_err(|error| format!("初始化连接配置表失败: {error}"))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(DB_FILENAME))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db = Connection::open(database_path(app)?)
        .map_err(|error| format!("打开配置数据库失败: {error}"))?;
    initialize_schema(&db)?;
    Ok(db)
}

fn workspace_key(root: &str) -> Result<String, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("工作区根目录不能为空".into());
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

fn legacy_connections_path(root: &str) -> PathBuf {
    Path::new(root).join(".gouan").join("connections.json")
}

fn save_payload(db: &Connection, key: &str, payload: &Value) -> Result<(), String> {
    let json =
        serde_json::to_string(payload).map_err(|error| format!("序列化连接配置失败: {error}"))?;
    db.execute(
        "INSERT INTO workspace_connections(workspace_root, payload_json, updated_at)
         VALUES(?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(workspace_root) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = CURRENT_TIMESTAMP",
        params![key, json],
    )
    .map_err(|error| format!("保存连接配置失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn load_workspace_connections(
    app: AppHandle,
    root: String,
) -> Result<Option<Value>, String> {
    let key = workspace_key(&root)?;
    let db = open_db(&app)?;
    let stored = db
        .query_row(
            "SELECT payload_json FROM workspace_connections WHERE workspace_root = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("读取连接配置失败: {error}"))?;

    if let Some(raw) = stored {
        return serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| format!("解析数据库连接配置失败: {error}"));
    }

    let legacy_path = legacy_connections_path(&root);
    if !legacy_path.is_file() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&legacy_path)
        .map_err(|error| format!("读取旧连接配置失败 {}: {error}", legacy_path.display()))?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("解析旧连接配置失败 {}: {error}", legacy_path.display()))?;
    save_payload(&db, &key, &payload)?;
    Ok(Some(payload))
}

#[tauri::command]
pub(crate) fn save_workspace_connections(
    app: AppHandle,
    root: String,
    payload: Value,
) -> Result<String, String> {
    let key = workspace_key(&root)?;
    let db = open_db(&app)?;
    save_payload(&db, &key, &payload)?;
    Ok(database_path(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_payload_round_trips() {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        let payload = serde_json::json!({"version": 2, "providers": [{"id": "p1"}]});
        save_payload(&db, "c:\\workspace", &payload).unwrap();
        let raw: String = db
            .query_row(
                "SELECT payload_json FROM workspace_connections WHERE workspace_root = ?1",
                ["c:\\workspace"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), payload);
    }
}
