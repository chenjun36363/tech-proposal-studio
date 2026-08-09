use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::fs::File;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const DB_FILENAME: &str = "workspace.db";
const TASK_MODES: &[&str] = &["modify", "create"];
const LEGACY_MODIFY_TASK_MODES: &[&str] = &["fill", "rewrite", "targeted"];
const TASK_STATUSES: &[&str] = &[
    "preparing",
    "awaiting_outline",
    "running",
    "paused",
    "checking",
    "awaiting_repairs",
    "completed",
    "cancelled",
    "restored",
    "failed",
    "conflict",
];
const CHAPTER_STATUSES: &[&str] = &[
    "queued",
    "running",
    "analyzing",
    "awaiting_write",
    "writing",
    "validating",
    "committing",
    "completed",
    "retryable",
    "failed",
    "cancelled",
];
const BACKUP_KINDS: &[&str] = &["original", "consistency", "pre-restore", "manual"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateProposalBackupRequest {
    pub workspace_root: String,
    pub file_path: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposalBackup {
    pub path: String,
    pub file_path: String,
    pub sha256: String,
    pub created_at: String,
    pub kind: String,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListProposalBackupsRequest {
    pub workspace_root: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreProposalBackupRequest {
    pub workspace_root: String,
    pub file_path: String,
    pub backup_path: String,
    #[serde(default)]
    pub expected_document_hash: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreProposalBackupResult {
    pub file_path: String,
    pub content: String,
    pub sha256: String,
    pub restored_from: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitLongTaskChapterRequest {
    pub workspace_root: String,
    pub task_id: String,
    pub chapter_id: String,
    pub file_path: String,
    pub expected_document_hash: String,
    pub expected_chapter_hash: String,
    pub replacement_markdown: String,
    pub target_document_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub(crate) enum CommitLongTaskChapterResult {
    #[serde(rename = "committed")]
    Committed {
        file_path: String,
        document_hash: String,
        chapter_hash: String,
        content: String,
    },
    #[serde(rename = "conflict")]
    Conflict {
        file_path: String,
        document_hash: Option<String>,
        chapter_hash: Option<String>,
        reason: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommittingRecoveryResult {
    pub task_id: String,
    pub chapter_id: String,
    pub action: String,
    pub document_hash: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LongWritingRecoveryResult {
    pub task: Value,
    pub chapters: Vec<Value>,
    pub disk_hash: String,
    pub recovery: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHeading {
    id: String,
    stable_key: String,
    level: u8,
    title: String,
    start: usize,
    line_end: usize,
    end: usize,
    parent_id: Option<String>,
    path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedChapter {
    id: String,
    order: usize,
    start: usize,
    end: usize,
    markdown_hash: String,
    headings: Vec<ParsedHeading>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hash_text(text: &str) -> String {
    hash_bytes(text.as_bytes())
}

fn path_string(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

fn required(value: &str, name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{name}不能为空"))
    } else {
        Ok(())
    }
}

fn valid_hash(value: &str, name: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{name}必须是 64 位 SHA-256 十六进制字符串"))
    }
}

fn value_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("{key}不能为空"))
}

fn value_i64(value: &Value, key: &str, default: i64) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(default)
}

fn normalized_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn reject_secrets(value: &Value, context: &str) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if matches!(
                    normalized_key(key).as_str(),
                    "apikey"
                        | "accesskey"
                        | "secretkey"
                        | "accesstoken"
                        | "refreshtoken"
                        | "authorizationtoken"
                        | "credential"
                        | "credentials"
                ) {
                    return Err(format!("{context}不能包含 API Key 或凭据字段 {key}"));
                }
                reject_secrets(child, context)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_secrets(item, context)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    required(root, "workspaceRoot")?;
    let root = fs::canonicalize(root).map_err(|error| format!("工作区根目录不可访问: {error}"))?;
    if !root.is_dir() {
        return Err("workspaceRoot 必须是目录".into());
    }
    Ok(root)
}

fn canonical_workspace_file(root: &str, file: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root)?;
    required(file, "filePath")?;
    let file = fs::canonicalize(file).map_err(|error| format!("方案文件不可访问: {error}"))?;
    if !file.is_file() || !file.starts_with(&root) {
        return Err("filePath 必须是 workspaceRoot 内的文件".into());
    }
    Ok((root, file))
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败: {error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建应用数据目录失败: {error}"))?;
    Ok(directory.join(DB_FILENAME))
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db = Connection::open(database_path(app)?)
        .map_err(|error| format!("打开数据库失败: {error}"))?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    initialize_schema(&db)?;
    Ok(db)
}

fn column_exists(db: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(names.iter().any(|name| name == column))
}

const OPENCODE_HTTP_MIGRATION: &str = "opencode_http_v1";

fn collect_backup_manifests(base: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if !base.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(base).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_backup_manifests(&path, output)?;
        } else if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.to_ascii_lowercase().ends_with(".md.json"))
        {
            output.push(path);
        }
    }
    Ok(())
}

fn cleanup_legacy_task_backups(root: &Path, task_ids: &HashSet<String>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let root = fs::canonicalize(root).map_err(|error| format!("旧任务工作区不可访问: {error}"))?;
    let base = root.join(".gouan").join("backups").join("proposals");
    if !base.exists() {
        return Ok(());
    }
    let base =
        fs::canonicalize(&base).map_err(|error| format!("旧任务备份目录不可访问: {error}"))?;
    let mut manifests = Vec::new();
    collect_backup_manifests(&base, &mut manifests)?;
    for manifest_path in manifests {
        let manifest = match fs::canonicalize(&manifest_path) {
            Ok(path) if path.starts_with(&base) => path,
            _ => continue,
        };
        let value = match fs::read_to_string(&manifest)
            .ok()
            .and_then(|text| serde_json::from_str::<ProposalBackup>(&text).ok())
        {
            Some(value) => value,
            None => continue,
        };
        let Some(task_id) = value.task_id.as_ref() else {
            continue;
        };
        if value.kind == "manual" || !task_ids.contains(task_id) {
            continue;
        }
        let Some(manifest_name) = manifest.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(backup_name) = manifest_name.strip_suffix(".json") else {
            continue;
        };
        let backup = manifest.with_file_name(backup_name);
        if !backup.starts_with(&base) || value.path != path_string(&backup) {
            continue;
        }
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| {
                format!("删除旧长任务备份 {} 失败: {error}", path_string(&backup))
            })?;
        }
        fs::remove_file(&manifest).map_err(|error| {
            format!(
                "删除旧长任务备份清单 {} 失败: {error}",
                path_string(&manifest)
            )
        })?;
    }
    Ok(())
}

fn migrate_legacy_long_tasks(db: &Connection) -> Result<(), String> {
    let completed = db
        .query_row(
            "SELECT value FROM proposal_long_task_meta WHERE key=?1",
            params![OPENCODE_HTTP_MIGRATION],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if completed.as_deref() == Some("done") {
        return Ok(());
    }

    let mut statement = db
        .prepare("SELECT id,workspace_root,payload_json FROM proposal_long_task")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut legacy_by_root: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    for row in rows {
        let (task_id, workspace_root, payload) = row.map_err(|error| error.to_string())?;
        let is_opencode_http = payload
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| {
                value
                    .get("backend")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .as_deref()
            == Some("opencode-http");
        if !is_opencode_http {
            legacy_by_root
                .entry(PathBuf::from(workspace_root))
                .or_default()
                .insert(task_id);
        }
    }
    drop(statement);

    for (root, task_ids) in &legacy_by_root {
        cleanup_legacy_task_backups(root, task_ids)?;
    }

    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for task_ids in legacy_by_root.values() {
        for task_id in task_ids {
            transaction
                .execute(
                    "DELETE FROM proposal_long_task WHERE id=?1",
                    params![task_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO proposal_long_task_meta(key,value) VALUES(?1,'done')",
            params![OPENCODE_HTTP_MIGRATION],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub(crate) fn initialize_schema(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS proposal_long_task_meta(
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS proposal_long_task(
           id TEXT PRIMARY KEY,
           workspace_root TEXT NOT NULL,
           file_path TEXT NOT NULL,
           mode TEXT NOT NULL,
           status TEXT NOT NULL,
           model_provider TEXT,
           model_id TEXT,
           concurrency INTEGER NOT NULL DEFAULT 2,
           instruction TEXT NOT NULL DEFAULT '',
           selected_chapter_ids_json TEXT NOT NULL DEFAULT '[]',
           source_refs_json TEXT NOT NULL DEFAULT '[]',
           backup_path TEXT,
           plan_json TEXT,
           base_hash TEXT NOT NULL DEFAULT '',
           current_hash TEXT NOT NULL DEFAULT '',
           error TEXT,
           payload_json TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           completed_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS proposal_long_task_chapter(
           task_id TEXT NOT NULL,
           chapter_id TEXT NOT NULL,
           order_index INTEGER NOT NULL,
           title_path_json TEXT NOT NULL DEFAULT '[]',
           occurrence INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL,
           original_hash TEXT NOT NULL DEFAULT '',
           current_hash TEXT NOT NULL DEFAULT '',
           attempt_count INTEGER NOT NULL DEFAULT 0,
           draft_markdown TEXT,
           draft_summary TEXT,
           facts_json TEXT NOT NULL DEFAULT '[]',
           terms_json TEXT NOT NULL DEFAULT '[]',
           questions_json TEXT NOT NULL DEFAULT '[]',
           commit_expected_full_hash TEXT,
           commit_expected_chapter_hash TEXT,
           commit_target_full_hash TEXT,
           commit_target_chapter_hash TEXT,
           error TEXT,
           payload_json TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           completed_at INTEGER,
           PRIMARY KEY(task_id, chapter_id),
           FOREIGN KEY(task_id) REFERENCES proposal_long_task(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_proposal_long_task_root_file
           ON proposal_long_task(workspace_root, file_path, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_proposal_long_task_chapter_status
           ON proposal_long_task_chapter(task_id, status, order_index);",
    )
    .map_err(|error| format!("初始化长任务 schema 失败: {error}"))?;

    if !column_exists(db, "proposal_long_task", "payload_json")? {
        db.execute(
            "ALTER TABLE proposal_long_task ADD COLUMN payload_json TEXT",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    if !column_exists(db, "proposal_long_task_chapter", "payload_json")? {
        db.execute(
            "ALTER TABLE proposal_long_task_chapter ADD COLUMN payload_json TEXT",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    migrate_legacy_long_tasks(db)?;
    Ok(())
}

fn normalize_task_mode(task: &mut Value) -> Result<String, String> {
    let mode = value_string(task, "mode")?.to_string();
    let normalized = if TASK_MODES.contains(&mode.as_str()) {
        mode.clone()
    } else if LEGACY_MODIFY_TASK_MODES.contains(&mode.as_str()) {
        "modify".to_string()
    } else {
        return Err(format!("无效任务模式: {mode}"));
    };
    if normalized != mode {
        set_json_field(task, "mode", Value::String(normalized.clone()));
    }
    Ok(normalized)
}

fn task_payload(db: &Connection, task_id: &str) -> Result<Option<Value>, String> {
    required(task_id, "taskId")?;
    let raw = db
        .query_row(
            "SELECT payload_json FROM proposal_long_task WHERE id=?1",
            params![task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    raw.map(|text| {
        let mut task: Value =
            serde_json::from_str(&text).map_err(|error| format!("任务 JSON 损坏: {error}"))?;
        normalize_task_mode(&mut task)?;
        Ok(task)
    })
    .transpose()
}

fn chapter_payload(
    db: &Connection,
    task_id: &str,
    chapter_id: &str,
) -> Result<Option<Value>, String> {
    let raw = db
        .query_row(
            "SELECT payload_json FROM proposal_long_task_chapter WHERE task_id=?1 AND chapter_id=?2",
            params![task_id, chapter_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    raw.map(|text| serde_json::from_str(&text).map_err(|error| format!("章节 JSON 损坏: {error}")))
        .transpose()
}

fn save_task_sync(db: &Connection, workspace_root: &str, mut task: Value) -> Result<Value, String> {
    reject_secrets(&task, "长任务")?;
    let id = value_string(&task, "id")?.to_string();
    let payload_root = value_string(&task, "workspaceRoot")?;
    let payload_file = value_string(&task, "filePath")?;
    let (root, file) = canonical_workspace_file(workspace_root, payload_file)?;
    if canonical_root(payload_root)? != root {
        return Err("task.workspaceRoot 与 workspaceRoot 参数不一致".into());
    }
    let mode = normalize_task_mode(&mut task)?;
    let status = value_string(&task, "status")?;
    if !TASK_STATUSES.contains(&status) {
        return Err(format!("无效任务状态: {status}"));
    }
    let concurrency = value_i64(&task, "concurrency", 2);
    if !(1..=3).contains(&concurrency) {
        return Err("concurrency 必须在 1 到 3 之间".into());
    }
    let base_hash = task
        .get("initialDocumentHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    let current_hash = task
        .get("currentDocumentHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !base_hash.is_empty() {
        valid_hash(base_hash, "initialDocumentHash")?;
    }
    if !current_hash.is_empty() {
        valid_hash(current_hash, "currentDocumentHash")?;
    }
    let ts = now_ms();
    let payload = serde_json::to_string(&task).map_err(|error| error.to_string())?;
    let model = task.get("model").and_then(Value::as_str);
    let instruction = task
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or("");
    let selected = task
        .get("selectedChapterIds")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let sources = task.get("sourceRefs").cloned().unwrap_or_else(|| json!([]));
    let plan = task
        .get("plan")
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    let backup = task.pointer("/initialBackup/path").and_then(Value::as_str);
    let error = task.get("error").and_then(Value::as_str);
    db.execute(
        "INSERT INTO proposal_long_task(
           id,workspace_root,file_path,mode,status,model_id,concurrency,instruction,
           selected_chapter_ids_json,source_refs_json,backup_path,plan_json,base_hash,current_hash,
           error,payload_json,created_at,updated_at,completed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17,NULL)
         ON CONFLICT(id) DO UPDATE SET
           workspace_root=excluded.workspace_root,file_path=excluded.file_path,mode=excluded.mode,
           status=excluded.status,model_id=excluded.model_id,concurrency=excluded.concurrency,
           instruction=excluded.instruction,selected_chapter_ids_json=excluded.selected_chapter_ids_json,
           source_refs_json=excluded.source_refs_json,backup_path=excluded.backup_path,
           plan_json=excluded.plan_json,base_hash=excluded.base_hash,current_hash=excluded.current_hash,
           error=excluded.error,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
        params![
            id,
            path_string(&root),
            path_string(&file),
            mode,
            status,
            model,
            concurrency,
            instruction,
            selected.to_string(),
            sources.to_string(),
            backup,
            plan,
            base_hash,
            current_hash,
            error,
            payload,
            ts,
        ],
    )
    .map_err(|error| format!("保存长任务失败: {error}"))?;
    Ok(task)
}

fn list_task_payloads(
    db: &Connection,
    root: &Path,
    file: Option<&Path>,
) -> Result<Vec<Value>, String> {
    let mut statement = db
        .prepare(
            "SELECT payload_json FROM proposal_long_task
             WHERE workspace_root=?1 AND (?2 IS NULL OR file_path=?2)
             ORDER BY updated_at DESC,id DESC",
        )
        .map_err(|error| error.to_string())?;
    let file_text = file.map(path_string);
    let rows = statement
        .query_map(params![path_string(root), file_text], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for raw in rows {
        if let Some(raw) = raw.map_err(|error| error.to_string())? {
            let mut task: Value =
                serde_json::from_str(&raw).map_err(|error| format!("任务 JSON 损坏: {error}"))?;
            normalize_task_mode(&mut task)?;
            result.push(task);
        }
    }
    Ok(result)
}

fn save_chapter_sync(
    db: &Connection,
    workspace_root: &str,
    task_id: &str,
    chapter: Value,
) -> Result<Value, String> {
    canonical_root(workspace_root)?;
    reject_secrets(&chapter, "长任务章节")?;
    required(task_id, "taskId")?;
    if task_payload(db, task_id)?.is_none() {
        return Err("长任务不存在".into());
    }
    if value_string(&chapter, "taskId")? != task_id {
        return Err("chapter.taskId 与 taskId 参数不一致".into());
    }
    let chapter_id = value_string(&chapter, "chapterId")?;
    let status = value_string(&chapter, "status")?;
    if !CHAPTER_STATUSES.contains(&status) {
        return Err(format!("无效章节状态: {status}"));
    }
    let original_hash = chapter
        .get("originalHash")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !original_hash.is_empty() {
        valid_hash(original_hash, "originalHash")?;
    }
    let current_hash = chapter
        .get("committedChapterHash")
        .and_then(Value::as_str)
        .unwrap_or(original_hash);
    let replacement = chapter.pointer("/draft/markdown").and_then(Value::as_str);
    let summary = chapter.get("summary").and_then(Value::as_str);
    let payload = serde_json::to_string(&chapter).map_err(|error| error.to_string())?;
    let ts = now_ms();
    db.execute(
        "INSERT INTO proposal_long_task_chapter(
           task_id,chapter_id,order_index,title_path_json,status,original_hash,current_hash,
           attempt_count,draft_markdown,draft_summary,payload_json,error,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
         ON CONFLICT(task_id,chapter_id) DO UPDATE SET
           order_index=excluded.order_index,title_path_json=excluded.title_path_json,
           status=excluded.status,original_hash=excluded.original_hash,current_hash=excluded.current_hash,
           attempt_count=excluded.attempt_count,draft_markdown=excluded.draft_markdown,
           draft_summary=excluded.draft_summary,payload_json=excluded.payload_json,
           error=excluded.error,updated_at=excluded.updated_at",
        params![
            task_id,
            chapter_id,
            value_i64(&chapter, "order", 0),
            chapter.get("titlePath").cloned().unwrap_or_else(|| json!([])).to_string(),
            status,
            original_hash,
            current_hash,
            value_i64(&chapter, "attempts", 0),
            replacement,
            summary,
            payload,
            chapter.get("error").and_then(Value::as_str),
            ts,
        ],
    )
    .map_err(|error| format!("保存长任务章节失败: {error}"))?;
    Ok(chapter)
}

fn list_chapter_payloads(db: &Connection, task_id: &str) -> Result<Vec<Value>, String> {
    required(task_id, "taskId")?;
    let mut statement = db
        .prepare(
            "SELECT payload_json FROM proposal_long_task_chapter
             WHERE task_id=?1 ORDER BY order_index,chapter_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![task_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for raw in rows {
        if let Some(raw) = raw.map_err(|error| error.to_string())? {
            result.push(
                serde_json::from_str(&raw).map_err(|error| format!("章节 JSON 损坏: {error}"))?,
            );
        }
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn save_proposal_long_task(
    app: AppHandle,
    workspace_root: String,
    task: Value,
) -> Result<Value, String> {
    save_task_sync(&open_db(&app)?, &workspace_root, task)
}

#[tauri::command]
pub(crate) fn get_proposal_long_task(
    app: AppHandle,
    workspace_root: String,
    task_id: String,
) -> Result<Option<Value>, String> {
    canonical_root(&workspace_root)?;
    let db = open_db(&app)?;
    let task = task_payload(&db, &task_id)?;
    if let Some(value) = &task {
        let stored_root = value_string(value, "workspaceRoot")?;
        if canonical_root(stored_root)? != canonical_root(&workspace_root)? {
            return Ok(None);
        }
    }
    Ok(task)
}

#[tauri::command]
pub(crate) fn list_proposal_long_tasks(
    app: AppHandle,
    workspace_root: String,
    file_path: Option<String>,
) -> Result<Vec<Value>, String> {
    let root = canonical_root(&workspace_root)?;
    let file = file_path
        .as_deref()
        .map(|path| canonical_workspace_file(&workspace_root, path).map(|(_, file)| file))
        .transpose()?;
    list_task_payloads(&open_db(&app)?, &root, file.as_deref())
}

#[tauri::command]
pub(crate) fn delete_proposal_long_task(
    app: AppHandle,
    workspace_root: String,
    task_id: String,
) -> Result<(), String> {
    canonical_root(&workspace_root)?;
    required(&task_id, "taskId")?;
    open_db(&app)?
        .execute(
            "DELETE FROM proposal_long_task WHERE id=?1",
            params![task_id],
        )
        .map_err(|error| format!("删除长任务失败: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_proposal_long_task_chapter(
    app: AppHandle,
    workspace_root: String,
    task_id: String,
    chapter: Value,
) -> Result<Value, String> {
    save_chapter_sync(&open_db(&app)?, &workspace_root, &task_id, chapter)
}

#[tauri::command]
pub(crate) fn list_proposal_long_task_chapters(
    app: AppHandle,
    workspace_root: String,
    task_id: String,
) -> Result<Vec<Value>, String> {
    canonical_root(&workspace_root)?;
    list_chapter_payloads(&open_db(&app)?, &task_id)
}

#[derive(Debug)]
struct SourceLine<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}

fn source_lines(markdown: &str) -> Vec<SourceLine<'_>> {
    let bytes = markdown.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    while start < bytes.len() {
        let mut cursor = start;
        while cursor < bytes.len() && bytes[cursor] != b'\r' && bytes[cursor] != b'\n' {
            cursor += 1;
        }
        let mut end = cursor;
        if cursor < bytes.len() {
            if bytes[cursor] == b'\r' && bytes.get(cursor + 1) == Some(&b'\n') {
                end += 2;
            } else {
                end += 1;
            }
        }
        lines.push(SourceLine {
            text: &markdown[start..cursor],
            start,
            end,
        });
        start = end;
    }
    lines
}

fn parse_atx_heading(line: &str) -> Option<(u8, String)> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let level = rest.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !after.is_empty() && !after.starts_with([' ', '\t']) {
        return None;
    }
    let mut title = after.trim().to_string();
    let bytes = title.as_bytes();
    let mut hashes_start = bytes.len();
    while hashes_start > 0 && bytes[hashes_start - 1] == b'#' {
        hashes_start -= 1;
    }
    if hashes_start < bytes.len() {
        let mut whitespace_start = hashes_start;
        while whitespace_start > 0 && matches!(bytes[whitespace_start - 1], b' ' | b'\t') {
            whitespace_start -= 1;
        }
        if whitespace_start < hashes_start {
            title.truncate(whitespace_start);
            title = title.trim().to_string();
        }
    }
    Some((level as u8, title))
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let marker = rest.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = rest
        .chars()
        .take_while(|character| *character == marker)
        .count();
    if length < 3 {
        return None;
    }
    let info = &rest[length..];
    if marker == '`' && info.contains('`') {
        return None;
    }
    Some((marker, length))
}

fn fence_close(line: &str, marker: char, opening_length: usize) -> bool {
    let indent = line.bytes().take_while(|byte| *byte == b' ').count();
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let length = rest
        .chars()
        .take_while(|character| *character == marker)
        .count();
    length >= opening_length
        && rest[length..]
            .chars()
            .all(|character| matches!(character, ' ' | '\t'))
}

#[cfg(windows)]
fn nfkc(value: &str) -> String {
    #[link(name = "Normaliz")]
    extern "system" {
        fn NormalizeString(
            norm_form: i32,
            source: *const u16,
            source_length: i32,
            destination: *mut u16,
            destination_length: i32,
        ) -> i32;
    }
    const NORMALIZATION_KC: i32 = 5;
    let source: Vec<u16> = value.encode_utf16().collect();
    if source.is_empty() {
        return String::new();
    }
    let needed = unsafe {
        NormalizeString(
            NORMALIZATION_KC,
            source.as_ptr(),
            source.len() as i32,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return value.to_string();
    }
    let mut destination = vec![0_u16; needed as usize];
    let written = unsafe {
        NormalizeString(
            NORMALIZATION_KC,
            source.as_ptr(),
            source.len() as i32,
            destination.as_mut_ptr(),
            destination.len() as i32,
        )
    };
    if written <= 0 {
        value.to_string()
    } else {
        String::from_utf16_lossy(&destination[..written as usize])
    }
}

#[cfg(not(windows))]
fn nfkc(value: &str) -> String {
    // The product target is Windows, where NormalizeString performs full NFKC.
    // This dependency-free fallback covers the compatibility forms commonly used in proposal titles.
    value
        .chars()
        .map(|character| match character {
            '\u{3000}' => ' ',
            '\u{ff01}'..='\u{ff5e}' => {
                char::from_u32(character as u32 - 0xfee0).unwrap_or(character)
            }
            _ => character,
        })
        .collect()
}

fn js_whitespace(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

fn normalize_identity_title(title: &str) -> String {
    let normalized = nfkc(title);
    let mut result = String::new();
    let mut pending_space = false;
    for character in normalized.trim_matches(js_whitespace).chars() {
        if js_whitespace(character) {
            pending_space = !result.is_empty();
        } else {
            if pending_space {
                result.push(' ');
                pending_space = false;
            }
            result.extend(character.to_lowercase());
        }
    }
    result
}

fn base36(mut value: u32) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("base36 is ASCII")
}

fn hash_stable_key(value: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for code_unit in value.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    base36(hash)
}

fn collect_heading_starts(markdown: &str) -> Vec<ParsedHeading> {
    let mut starts: Vec<ParsedHeading> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut sibling_occurrences: HashMap<String, u32> = HashMap::new();
    let mut fence: Option<(char, usize)> = None;

    for source_line in source_lines(markdown) {
        if let Some((marker, length)) = fence {
            if fence_close(source_line.text, marker, length) {
                fence = None;
            }
            continue;
        }
        if let Some(opening) = fence_open(source_line.text) {
            fence = Some(opening);
            continue;
        }
        let Some((level, title)) = parse_atx_heading(source_line.text) else {
            continue;
        };
        while stack
            .last()
            .is_some_and(|index| starts[*index].level >= level)
        {
            stack.pop();
        }
        let parent = stack.last().copied();
        let parent_key = parent
            .map(|index| starts[index].stable_key.as_str())
            .unwrap_or("root");
        let sibling_key = format!(
            "{parent_key}\0{level}\0{}",
            normalize_identity_title(&title)
        );
        let occurrence = sibling_occurrences.entry(sibling_key.clone()).or_insert(0);
        let stable_key = format!("{sibling_key}\0{occurrence}");
        *occurrence += 1;
        let id = format!("h{level}-{}", hash_stable_key(&stable_key));
        let path = parent
            .map(|index| {
                let mut path = starts[index].path.clone();
                path.push(title.clone());
                path
            })
            .unwrap_or_else(|| vec![title.clone()]);
        let heading = ParsedHeading {
            id,
            stable_key,
            level,
            title,
            start: source_line.start,
            line_end: source_line.end,
            end: markdown.len(),
            parent_id: parent.map(|index| starts[index].id.clone()),
            path,
        };
        starts.push(heading);
        stack.push(starts.len() - 1);
    }

    for index in 0..starts.len() {
        starts[index].end = starts[index + 1..]
            .iter()
            .find(|candidate| candidate.level <= starts[index].level)
            .map(|candidate| candidate.start)
            .unwrap_or(markdown.len());
    }
    starts
}

fn parse_chapters(markdown: &str) -> Vec<ParsedChapter> {
    let headings = collect_heading_starts(markdown);
    headings
        .iter()
        .filter(|heading| heading.level == 2)
        .enumerate()
        .map(|(order, heading)| {
            let chapter_headings = headings
                .iter()
                .filter(|candidate| {
                    candidate.start >= heading.start && candidate.start < heading.end
                })
                .cloned()
                .collect::<Vec<_>>();
            let hash = heading.id.strip_prefix("h2-").unwrap_or(&heading.id);
            ParsedChapter {
                id: format!("chapter-{hash}"),
                order,
                start: heading.start,
                end: heading.end,
                markdown_hash: hash_text(&markdown[heading.start..heading.end]),
                headings: chapter_headings,
            }
        })
        .collect()
}

fn heading_signature(chapter: &ParsedChapter) -> Vec<(u8, String, Option<usize>)> {
    let indexes = chapter
        .headings
        .iter()
        .enumerate()
        .map(|(index, heading)| (heading.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    chapter
        .headings
        .iter()
        .map(|heading| {
            (
                heading.level,
                heading.title.clone(),
                heading
                    .parent_id
                    .as_deref()
                    .and_then(|parent| indexes.get(parent).copied()),
            )
        })
        .collect()
}

fn detect_line_ending(markdown: &str) -> &'static str {
    let bytes = markdown.as_bytes();
    for index in 0..bytes.len() {
        match bytes[index] {
            b'\r' if bytes.get(index + 1) == Some(&b'\n') => return "\r\n",
            b'\r' => return "\r",
            b'\n' => return "\n",
            _ => {}
        }
    }
    "\n"
}

fn normalize_line_endings(value: &str, line_ending: &str) -> String {
    let bytes = value.as_bytes();
    let mut normalized = String::with_capacity(value.len());
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\r' || bytes[index] == b'\n' {
            normalized.push_str(&value[start..index]);
            normalized.push_str(line_ending);
            if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            index += 1;
            start = index;
        } else {
            index += 1;
        }
    }
    normalized.push_str(&value[start..]);
    normalized
}

fn trailing_line_whitespace_start(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut run_start = bytes.len();
    while run_start > 0 && matches!(bytes[run_start - 1], b' ' | b'\t' | b'\r' | b'\n') {
        run_start -= 1;
    }
    (run_start..bytes.len()).find(|index| matches!(bytes[*index], b'\r' | b'\n'))
}

fn build_replacement(
    markdown: &str,
    chapter_id: &str,
    expected_chapter_hash: &str,
    replacement_markdown: &str,
) -> Result<(String, String), CommitLongTaskChapterResult> {
    let document_hash = hash_text(markdown);
    let chapters = parse_chapters(markdown);
    let Some(target) = chapters.iter().find(|chapter| chapter.id == chapter_id) else {
        return Err(CommitLongTaskChapterResult::Conflict {
            file_path: String::new(),
            document_hash: Some(document_hash),
            chapter_hash: None,
            reason: "missing_chapter".into(),
            content: Some(markdown.into()),
        });
    };
    if !target
        .markdown_hash
        .eq_ignore_ascii_case(expected_chapter_hash)
    {
        return Err(CommitLongTaskChapterResult::Conflict {
            file_path: String::new(),
            document_hash: Some(document_hash),
            chapter_hash: Some(target.markdown_hash.clone()),
            reason: "chapter_hash".into(),
            content: Some(markdown.into()),
        });
    }

    let normalized = normalize_line_endings(replacement_markdown, detect_line_ending(markdown));
    let replacement_chapters = parse_chapters(&normalized);
    if replacement_chapters.len() != 1 {
        return Err(CommitLongTaskChapterResult::Conflict {
            file_path: String::new(),
            document_hash: Some(document_hash),
            chapter_hash: Some(target.markdown_hash.clone()),
            reason: "chapter_hash".into(),
            content: Some(markdown.into()),
        });
    }
    let replacement = &replacement_chapters[0];
    if !normalized[..replacement.start].trim().is_empty()
        || !normalized[replacement.end..].trim().is_empty()
        || heading_signature(target) != heading_signature(replacement)
    {
        return Err(CommitLongTaskChapterResult::Conflict {
            file_path: String::new(),
            document_hash: Some(document_hash),
            chapter_hash: Some(target.markdown_hash.clone()),
            reason: "chapter_hash".into(),
            content: Some(markdown.into()),
        });
    }

    let original_markdown = &markdown[target.start..target.end];
    let original_tail = trailing_line_whitespace_start(original_markdown)
        .map(|index| &original_markdown[index..])
        .unwrap_or("");
    let replacement_section = &normalized[replacement.start..replacement.end];
    let replacement_core_end =
        trailing_line_whitespace_start(replacement_section).unwrap_or(replacement_section.len());
    let next_section = format!(
        "{}{original_tail}",
        &replacement_section[..replacement_core_end]
    );
    let next_document = format!(
        "{}{}{}",
        &markdown[..target.start],
        next_section,
        &markdown[target.end..]
    );
    let next_chapter = parse_chapters(&next_document)
        .into_iter()
        .find(|chapter| chapter.id == chapter_id)
        .expect("frozen heading tree preserves chapter id");
    Ok((next_document, next_chapter.markdown_hash))
}

fn safe_component(value: &str, fallback: &str, max: usize) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            output.push(character);
        } else if !output.ends_with('-') {
            output.push('-');
        }
        if output.chars().count() >= max {
            break;
        }
    }
    let output = output.trim_matches(['-', '.']).to_string();
    if output.is_empty() {
        fallback.into()
    } else {
        output
    }
}

fn backup_dir(root: &Path, file: &Path) -> PathBuf {
    let relative = file.strip_prefix(root).unwrap_or(file).to_string_lossy();
    let stem = file
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("proposal");
    root.join(".gouan")
        .join("backups")
        .join("proposals")
        .join(format!(
            "{}-{}",
            safe_component(stem, "proposal", 40),
            &hash_text(&relative)[..16]
        ))
}

fn backup_manifest_path(backup: &Path) -> PathBuf {
    let name = backup
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("backup.md");
    backup.with_file_name(format!("{name}.json"))
}

fn create_backup_sync(request: &CreateProposalBackupRequest) -> Result<ProposalBackup, String> {
    let (root, file) = canonical_workspace_file(&request.workspace_root, &request.file_path)?;
    let kind = request.kind.as_deref().unwrap_or("original");
    if !BACKUP_KINDS.contains(&kind) {
        return Err(format!("无效备份类型: {kind}"));
    }
    if let Some(task_id) = &request.task_id {
        required(task_id, "taskId")?;
    }
    let bytes = fs::read(&file).map_err(|error| format!("读取待备份文件失败: {error}"))?;
    let sha256 = hash_bytes(&bytes);
    let directory = backup_dir(&root, &file);
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let created_at = now_ms().to_string();
    let task_part = request
        .task_id
        .as_deref()
        .map(|value| safe_component(value, "task", 48))
        .unwrap_or_else(|| "no-task".into());
    let path = directory.join(format!(
        "{}-{}-{}-{}-{}.md",
        created_at,
        safe_component(kind, "original", 24),
        task_part,
        &sha256[..12],
        now_nanos()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("创建不可变备份失败: {error}"))?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("写入备份失败: {error}"))?;
    let backup = ProposalBackup {
        path: path_string(&path),
        file_path: path_string(&file),
        sha256,
        created_at,
        kind: kind.into(),
        task_id: request.task_id.clone(),
    };
    let manifest_path = backup_manifest_path(&path);
    let manifest_result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&manifest_path)
        .and_then(|mut manifest| {
            manifest.write_all(serde_json::to_string_pretty(&backup).unwrap().as_bytes())?;
            manifest.sync_all()
        });
    if let Err(error) = manifest_result {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&manifest_path);
        return Err(format!("写入备份清单失败: {error}"));
    }
    Ok(backup)
}

fn collect_backup_files(base: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if !base.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(base).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            collect_backup_files(&path, output)?;
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("md"))
        {
            output.push(path);
        }
    }
    Ok(())
}

fn backup_from_path(path: &Path) -> Result<Option<ProposalBackup>, String> {
    let manifest = backup_manifest_path(path);
    if manifest.is_file() {
        let value = fs::read_to_string(&manifest).map_err(|error| error.to_string())?;
        return serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| format!("备份清单损坏: {error}"));
    }
    Ok(None)
}

fn list_backups_sync(request: &ListProposalBackupsRequest) -> Result<Vec<ProposalBackup>, String> {
    let root = canonical_root(&request.workspace_root)?;
    let requested_file = request
        .file_path
        .as_deref()
        .map(|path| canonical_workspace_file(&request.workspace_root, path).map(|(_, file)| file))
        .transpose()?;
    let base = requested_file
        .as_deref()
        .map(|file| backup_dir(&root, file))
        .unwrap_or_else(|| root.join(".gouan").join("backups").join("proposals"));
    let mut paths = Vec::new();
    collect_backup_files(&base, &mut paths)?;
    let mut backups = Vec::new();
    for path in paths {
        let Some(backup) = backup_from_path(&path)? else {
            continue;
        };
        if requested_file
            .as_ref()
            .is_some_and(|file| PathBuf::from(&backup.file_path) != *file)
        {
            continue;
        }
        if request
            .task_id
            .as_ref()
            .is_some_and(|task_id| backup.task_id.as_ref() != Some(task_id))
        {
            continue;
        }
        backups.push(backup);
    }
    backups.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.path.cmp(&left.path))
    });
    Ok(backups)
}

#[tauri::command]
pub(crate) fn create_proposal_backup(
    request: CreateProposalBackupRequest,
) -> Result<ProposalBackup, String> {
    create_backup_sync(&request)
}

#[tauri::command]
pub(crate) fn list_proposal_backups(
    request: ListProposalBackupsRequest,
) -> Result<Vec<ProposalBackup>, String> {
    list_backups_sync(&request)
}

fn temp_path(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or("目标文件没有父目录")?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("proposal.md");
    for attempt in 0..64 {
        let path = parent.join(format!(
            ".{name}.long-writing-{}-{attempt}.tmp",
            now_nanos()
        ));
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法分配同目录临时文件".into())
}

#[cfg(windows)]
fn atomic_move(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }
    let target_wide = wide(target);
    let temp_wide = wide(temp);
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temp_wide.as_ptr(),
            std::ptr::null(),
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced != 0 {
        return Ok(());
    }
    let replace_error = std::io::Error::last_os_error();
    let moved = unsafe { MoveFileExW(temp_wide.as_ptr(), target_wide.as_ptr(), 0x1 | 0x8) };
    if moved != 0 {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "ReplaceFileW 失败: {replace_error}; MoveFileExW 失败: {}",
            std::io::Error::last_os_error()
        )))
    }
}

#[cfg(not(windows))]
fn atomic_move(temp: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temp, target)?;
    if let Some(parent) = target.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn atomic_replace(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = temp_path(target)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("创建同目录临时文件失败: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入临时文件失败: {error}"))?;
        drop(file);
        atomic_move(&temp, target).map_err(|error| format!("原子替换文件失败: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn checked_backup_path(root: &Path, file: &Path, backup: &str) -> Result<PathBuf, String> {
    let directory = fs::canonicalize(backup_dir(root, file))
        .map_err(|error| format!("备份目录不可访问: {error}"))?;
    let backup = fs::canonicalize(backup).map_err(|error| format!("备份文件不可访问: {error}"))?;
    if !backup.is_file() || !backup.starts_with(&directory) {
        Err("备份文件不属于当前方案的备份目录".into())
    } else {
        Ok(backup)
    }
}

fn set_json_field(value: &mut Value, key: &str, field_value: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.into(), field_value);
    }
}

fn update_task_payload(
    db: &Connection,
    task_id: &str,
    status: Option<&str>,
    current_hash: Option<&str>,
    error: Option<Option<&str>>,
) -> Result<(), String> {
    let Some(mut payload) = task_payload(db, task_id)? else {
        return Err("长任务不存在".into());
    };
    if let Some(status) = status {
        set_json_field(&mut payload, "status", json!(status));
    }
    if let Some(hash) = current_hash {
        set_json_field(&mut payload, "currentDocumentHash", json!(hash));
    }
    if let Some(error) = error {
        set_json_field(
            &mut payload,
            "error",
            error.map_or(Value::Null, |value| json!(value)),
        );
    }
    let ts = now_ms();
    db.execute(
        "UPDATE proposal_long_task SET status=COALESCE(?2,status),current_hash=COALESCE(?3,current_hash),
         error=?4,payload_json=?5,updated_at=?6 WHERE id=?1",
        params![
            task_id,
            status,
            current_hash,
            error.flatten(),
            serde_json::to_string(&payload).map_err(|error| error.to_string())?,
            ts,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn update_chapter_payload_status(
    db: &Connection,
    task_id: &str,
    chapter_id: &str,
    status: &str,
    error: Option<&str>,
    document_hash: Option<&str>,
    chapter_hash: Option<&str>,
) -> Result<(), String> {
    let Some(mut payload) = chapter_payload(db, task_id, chapter_id)? else {
        return Err("长任务章节不存在".into());
    };
    set_json_field(&mut payload, "status", json!(status));
    set_json_field(
        &mut payload,
        "error",
        error.map_or(Value::Null, |value| json!(value)),
    );
    if let Some(hash) = document_hash {
        set_json_field(&mut payload, "commitTargetDocumentHash", json!(hash));
    }
    if let Some(hash) = chapter_hash {
        set_json_field(&mut payload, "committedChapterHash", json!(hash));
    }
    db.execute(
        "UPDATE proposal_long_task_chapter SET status=?3,error=?4,
         current_hash=COALESCE(?5,current_hash),payload_json=?6,updated_at=?7,
         completed_at=CASE WHEN ?3='completed' THEN ?7 ELSE completed_at END
         WHERE task_id=?1 AND chapter_id=?2",
        params![
            task_id,
            chapter_id,
            status,
            error,
            chapter_hash,
            serde_json::to_string(&payload).map_err(|error| error.to_string())?,
            now_ms(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_sync(
    db: Option<&Connection>,
    request: &RestoreProposalBackupRequest,
) -> Result<RestoreProposalBackupResult, String> {
    let (root, file) = canonical_workspace_file(&request.workspace_root, &request.file_path)?;
    let current = fs::read(&file).map_err(|error| format!("读取当前方案失败: {error}"))?;
    let current_hash = hash_bytes(&current);
    if let Some(expected) = &request.expected_document_hash {
        valid_hash(expected, "expectedDocumentHash")?;
        if !expected.eq_ignore_ascii_case(&current_hash) {
            return Err(format!(
                "恢复前全文 hash 不匹配，预期 {expected}，实际 {current_hash}"
            ));
        }
    }
    if let (Some(db), Some(task_id)) = (db, request.task_id.as_deref()) {
        let task = task_payload(db, task_id)?.ok_or("长任务不存在")?;
        if canonical_root(value_string(&task, "workspaceRoot")?)? != root
            || fs::canonicalize(value_string(&task, "filePath")?)
                .map_err(|error| error.to_string())?
                != file
        {
            return Err("恢复请求与长任务文件不匹配".into());
        }
    }
    let backup = checked_backup_path(&root, &file, &request.backup_path)?;
    let bytes = fs::read(&backup).map_err(|error| format!("读取备份失败: {error}"))?;
    let content =
        String::from_utf8(bytes.clone()).map_err(|error| format!("备份不是有效 UTF-8: {error}"))?;
    atomic_replace(&file, &bytes)?;
    let sha256 = hash_bytes(&bytes);
    if let (Some(db), Some(task_id)) = (db, request.task_id.as_deref()) {
        update_task_payload(db, task_id, Some("restored"), Some(&sha256), Some(None))?;
    }
    Ok(RestoreProposalBackupResult {
        file_path: path_string(&file),
        content,
        sha256,
        restored_from: path_string(&backup),
    })
}

#[tauri::command]
pub(crate) fn restore_proposal_backup(
    app: AppHandle,
    request: RestoreProposalBackupRequest,
) -> Result<RestoreProposalBackupResult, String> {
    let db = open_db(&app)?;
    restore_sync(Some(&db), &request)
}

fn mark_conflict(
    db: &Connection,
    task_id: &str,
    chapter_id: &str,
    reason: &str,
) -> Result<(), String> {
    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    update_chapter_payload_status(
        &transaction,
        task_id,
        chapter_id,
        "retryable",
        Some(reason),
        None,
        None,
    )?;
    update_task_payload(
        &transaction,
        task_id,
        Some("conflict"),
        None,
        Some(Some(reason)),
    )?;
    transaction.commit().map_err(|error| error.to_string())
}

fn mark_committing(
    db: &Connection,
    request: &CommitLongTaskChapterRequest,
    target_chapter_hash: &str,
) -> Result<(), String> {
    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    update_chapter_payload_status(
        &transaction,
        &request.task_id,
        &request.chapter_id,
        "committing",
        None,
        Some(&request.target_document_hash),
        Some(target_chapter_hash),
    )?;
    transaction
        .execute(
            "UPDATE proposal_long_task_chapter SET
             commit_expected_full_hash=?3,commit_expected_chapter_hash=?4,
             commit_target_full_hash=?5,commit_target_chapter_hash=?6,
             draft_markdown=?7,updated_at=?8
             WHERE task_id=?1 AND chapter_id=?2",
            params![
                request.task_id,
                request.chapter_id,
                request.expected_document_hash,
                request.expected_chapter_hash,
                request.target_document_hash,
                target_chapter_hash,
                request.replacement_markdown,
                now_ms(),
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn finalize_commit(
    db: &Connection,
    task_id: &str,
    chapter_id: &str,
    document_hash: &str,
    chapter_hash: &str,
) -> Result<(), String> {
    let transaction = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    update_chapter_payload_status(
        &transaction,
        task_id,
        chapter_id,
        "completed",
        None,
        Some(document_hash),
        Some(chapter_hash),
    )?;
    update_task_payload(&transaction, task_id, None, Some(document_hash), Some(None))?;
    transaction.commit().map_err(|error| error.to_string())
}

fn conflict_result(
    file: &Path,
    reason: &str,
    content: Option<String>,
    document_hash: Option<String>,
    chapter_hash: Option<String>,
) -> CommitLongTaskChapterResult {
    CommitLongTaskChapterResult::Conflict {
        file_path: path_string(file),
        document_hash,
        chapter_hash,
        reason: reason.into(),
        content,
    }
}

fn commit_sync(
    db: &Connection,
    request: &CommitLongTaskChapterRequest,
) -> Result<CommitLongTaskChapterResult, String> {
    required(&request.task_id, "taskId")?;
    required(&request.chapter_id, "chapterId")?;
    required(&request.replacement_markdown, "replacementMarkdown")?;
    valid_hash(&request.expected_document_hash, "expectedDocumentHash")?;
    valid_hash(&request.expected_chapter_hash, "expectedChapterHash")?;
    valid_hash(&request.target_document_hash, "targetDocumentHash")?;

    let task = task_payload(db, &request.task_id)?.ok_or("长任务不存在")?;
    if chapter_payload(db, &request.task_id, &request.chapter_id)?.is_none() {
        return Err("长任务章节不存在".into());
    }
    let (request_root, request_file) =
        canonical_workspace_file(&request.workspace_root, &request.file_path)?;
    let task_root = canonical_root(value_string(&task, "workspaceRoot")?)?;
    let task_file = fs::canonicalize(value_string(&task, "filePath")?)
        .map_err(|error| format!("长任务方案文件不可访问: {error}"))?;
    if request_root != task_root || request_file != task_file {
        return Err("提交请求与长任务 workspaceRoot/filePath 不匹配".into());
    }

    let stored_commit = db
        .query_row(
            "SELECT status,commit_target_full_hash,current_hash
             FROM proposal_long_task_chapter WHERE task_id=?1 AND chapter_id=?2",
            params![request.task_id, request.chapter_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    if stored_commit.0 == "completed"
        && stored_commit
            .1
            .as_deref()
            .is_some_and(|hash| hash.eq_ignore_ascii_case(&request.target_document_hash))
    {
        let bytes = fs::read(&request_file).map_err(|error| error.to_string())?;
        if hash_bytes(&bytes).eq_ignore_ascii_case(&request.target_document_hash) {
            let content =
                String::from_utf8(bytes).map_err(|error| format!("方案不是有效 UTF-8: {error}"))?;
            return Ok(CommitLongTaskChapterResult::Committed {
                file_path: path_string(&request_file),
                document_hash: request.target_document_hash.clone(),
                chapter_hash: stored_commit.2,
                content,
            });
        }
    }

    let bytes = fs::read(&request_file).map_err(|error| format!("读取方案失败: {error}"))?;
    let actual_document_hash = hash_bytes(&bytes);
    let content =
        String::from_utf8(bytes).map_err(|error| format!("方案不是有效 UTF-8: {error}"))?;
    if !actual_document_hash.eq_ignore_ascii_case(&request.expected_document_hash) {
        mark_conflict(db, &request.task_id, &request.chapter_id, "document_hash")?;
        return Ok(conflict_result(
            &request_file,
            "document_hash",
            Some(content),
            Some(actual_document_hash),
            None,
        ));
    }

    let (target_content, target_chapter_hash) = match build_replacement(
        &content,
        &request.chapter_id,
        &request.expected_chapter_hash,
        &request.replacement_markdown,
    ) {
        Ok(result) => result,
        Err(CommitLongTaskChapterResult::Conflict {
            document_hash,
            chapter_hash,
            reason,
            content,
            ..
        }) => {
            mark_conflict(db, &request.task_id, &request.chapter_id, &reason)?;
            return Ok(conflict_result(
                &request_file,
                &reason,
                content,
                document_hash,
                chapter_hash,
            ));
        }
        Err(_) => unreachable!(),
    };
    let calculated_target_hash = hash_text(&target_content);
    if !calculated_target_hash.eq_ignore_ascii_case(&request.target_document_hash) {
        return Err(format!(
            "targetDocumentHash 与精确章节替换结果不一致，计算值为 {calculated_target_hash}"
        ));
    }

    mark_committing(db, request, &target_chapter_hash)?;
    let latest =
        fs::read(&request_file).map_err(|error| format!("提交前重新读取方案失败: {error}"))?;
    let latest_hash = hash_bytes(&latest);
    if !latest_hash.eq_ignore_ascii_case(&request.expected_document_hash) {
        let latest_content = String::from_utf8(latest).ok();
        mark_conflict(db, &request.task_id, &request.chapter_id, "document_hash")?;
        return Ok(conflict_result(
            &request_file,
            "document_hash",
            latest_content,
            Some(latest_hash),
            None,
        ));
    }
    atomic_replace(&request_file, target_content.as_bytes())?;
    finalize_commit(
        db,
        &request.task_id,
        &request.chapter_id,
        &calculated_target_hash,
        &target_chapter_hash,
    )?;
    Ok(CommitLongTaskChapterResult::Committed {
        file_path: path_string(&request_file),
        document_hash: calculated_target_hash,
        chapter_hash: target_chapter_hash,
        content: target_content,
    })
}

#[tauri::command]
pub(crate) fn commit_long_task_chapter(
    app: AppHandle,
    request: CommitLongTaskChapterRequest,
) -> Result<CommitLongTaskChapterResult, String> {
    commit_sync(&open_db(&app)?, &request)
}

#[derive(Debug)]
struct CommittingRecord {
    chapter_id: String,
    expected_document_hash: String,
    expected_chapter_hash: String,
    target_document_hash: String,
    target_chapter_hash: String,
    replacement_markdown: String,
}

fn committing_records(db: &Connection, task_id: &str) -> Result<Vec<CommittingRecord>, String> {
    let mut statement = db
        .prepare(
            "SELECT chapter_id,commit_expected_full_hash,commit_expected_chapter_hash,
             commit_target_full_hash,commit_target_chapter_hash,draft_markdown
             FROM proposal_long_task_chapter WHERE task_id=?1 AND status='committing'
             ORDER BY order_index,chapter_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![task_id], |row| {
            Ok(CommittingRecord {
                chapter_id: row.get(0)?,
                expected_document_hash: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                expected_chapter_hash: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                target_document_hash: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                target_chapter_hash: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                replacement_markdown: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|error| error.to_string())?;
    let result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn reconcile_task_committing(
    db: &Connection,
    workspace_root: &str,
    task_id: &str,
) -> Result<Vec<CommittingRecoveryResult>, String> {
    let task = task_payload(db, task_id)?.ok_or("长任务不存在")?;
    let (_, file) = canonical_workspace_file(workspace_root, value_string(&task, "filePath")?)?;
    let mut results = Vec::new();
    for record in committing_records(db, task_id)? {
        let outcome = (|| -> Result<CommittingRecoveryResult, String> {
            for (hash, name) in [
                (
                    &record.expected_document_hash,
                    "committing expectedDocumentHash",
                ),
                (
                    &record.expected_chapter_hash,
                    "committing expectedChapterHash",
                ),
                (
                    &record.target_document_hash,
                    "committing targetDocumentHash",
                ),
                (&record.target_chapter_hash, "committing targetChapterHash"),
            ] {
                valid_hash(hash, name)?;
            }
            let bytes = fs::read(&file).map_err(|error| format!("读取方案失败: {error}"))?;
            let disk_hash = hash_bytes(&bytes);
            if disk_hash.eq_ignore_ascii_case(&record.target_document_hash) {
                finalize_commit(
                    db,
                    task_id,
                    &record.chapter_id,
                    &record.target_document_hash,
                    &record.target_chapter_hash,
                )?;
                return Ok(CommittingRecoveryResult {
                    task_id: task_id.into(),
                    chapter_id: record.chapter_id.clone(),
                    action: "finalized".into(),
                    document_hash: Some(disk_hash),
                    reason: None,
                });
            }
            if !disk_hash.eq_ignore_ascii_case(&record.expected_document_hash) {
                mark_conflict(db, task_id, &record.chapter_id, "unexpected_disk_state")?;
                return Ok(CommittingRecoveryResult {
                    task_id: task_id.into(),
                    chapter_id: record.chapter_id.clone(),
                    action: "conflict".into(),
                    document_hash: Some(disk_hash),
                    reason: Some("unexpected_disk_state".into()),
                });
            }
            let content =
                String::from_utf8(bytes).map_err(|error| format!("方案不是有效 UTF-8: {error}"))?;
            let (target, chapter_hash) = build_replacement(
                &content,
                &record.chapter_id,
                &record.expected_chapter_hash,
                &record.replacement_markdown,
            )
            .map_err(|_| "无法从 committing 记录重建章节替换".to_string())?;
            if !hash_text(&target).eq_ignore_ascii_case(&record.target_document_hash)
                || !chapter_hash.eq_ignore_ascii_case(&record.target_chapter_hash)
            {
                mark_conflict(db, task_id, &record.chapter_id, "unexpected_disk_state")?;
                return Ok(CommittingRecoveryResult {
                    task_id: task_id.into(),
                    chapter_id: record.chapter_id.clone(),
                    action: "conflict".into(),
                    document_hash: Some(disk_hash),
                    reason: Some("unexpected_disk_state".into()),
                });
            }
            atomic_replace(&file, target.as_bytes())?;
            finalize_commit(
                db,
                task_id,
                &record.chapter_id,
                &record.target_document_hash,
                &record.target_chapter_hash,
            )?;
            Ok(CommittingRecoveryResult {
                task_id: task_id.into(),
                chapter_id: record.chapter_id.clone(),
                action: "retried".into(),
                document_hash: Some(record.target_document_hash),
                reason: None,
            })
        })();
        match outcome {
            Ok(result) => results.push(result),
            Err(error) => {
                let _ = mark_conflict(db, task_id, &record.chapter_id, "unexpected_disk_state");
                results.push(CommittingRecoveryResult {
                    task_id: task_id.into(),
                    chapter_id: record.chapter_id.clone(),
                    action: "conflict".into(),
                    document_hash: None,
                    reason: Some(error),
                });
            }
        }
    }
    Ok(results)
}

fn reset_running_chapters(db: &Connection, task_id: &str) -> Result<usize, String> {
    let chapters = list_chapter_payloads(db, task_id)?;
    let mut reset = 0;
    for chapter in chapters {
        if chapter.get("status").and_then(Value::as_str) == Some("running") {
            let chapter_id = value_string(&chapter, "chapterId")?.to_string();
            update_chapter_payload_status(db, task_id, &chapter_id, "queued", None, None, None)?;
            reset += 1;
        }
    }
    Ok(reset)
}

fn recover_task_sync(
    db: &Connection,
    workspace_root: &str,
    task_id: &str,
) -> Result<LongWritingRecoveryResult, String> {
    let root = canonical_root(workspace_root)?;
    let task_before = task_payload(db, task_id)?.ok_or("长任务不存在")?;
    if canonical_root(value_string(&task_before, "workspaceRoot")?)? != root {
        return Err("长任务不属于指定 workspaceRoot".into());
    }
    let reconciled = reconcile_task_committing(db, workspace_root, task_id)?;
    let reset = reset_running_chapters(db, task_id)?;
    let chapters = list_chapter_payloads(db, task_id)?;
    let mut task = task_payload(db, task_id)?.ok_or("长任务不存在")?;
    set_json_field(&mut task, "chapters", Value::Array(chapters.clone()));
    let file = fs::canonicalize(value_string(&task, "filePath")?)
        .map_err(|error| format!("方案文件不可访问: {error}"))?;
    let disk_hash = hash_bytes(&fs::read(file).map_err(|error| error.to_string())?);
    let recovery = if reconciled.iter().any(|item| item.action == "conflict") {
        "conflict"
    } else if !reconciled.is_empty() {
        "finalized_commits"
    } else if reset > 0 {
        "requeued"
    } else {
        "ready"
    };
    Ok(LongWritingRecoveryResult {
        task,
        chapters,
        disk_hash,
        recovery: recovery.into(),
    })
}

#[tauri::command]
pub(crate) fn recover_proposal_long_task(
    app: AppHandle,
    workspace_root: String,
    task_id: String,
) -> Result<LongWritingRecoveryResult, String> {
    recover_task_sync(&open_db(&app)?, &workspace_root, &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    struct Workspace {
        root: PathBuf,
        file: PathBuf,
    }

    impl Workspace {
        fn new(markdown: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "tech-proposal-long-writing-{}-{}-{}",
                std::process::id(),
                now_nanos(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let file = root.join("proposal.md");
            fs::write(&file, markdown).unwrap();
            Self { root, file }
        }

        fn task(&self, id: &str, status: &str) -> Value {
            json!({
                "id": id,
                "filePath": path_string(&self.file),
                "workspaceRoot": path_string(&self.root),
                "mode": "modify",
                "status": status,
                "instruction": "modify",
                "model": "test-model",
                "concurrency": 2,
                "selectedChapterIds": [],
                "sourceRefs": [],
                "initialDocumentHash": hash_bytes(&fs::read(&self.file).unwrap()),
                "currentDocumentHash": hash_bytes(&fs::read(&self.file).unwrap()),
                "initialBackup": {
                    "path": "placeholder",
                    "sourceFilePath": path_string(&self.file),
                    "sourceHash": hash_bytes(&fs::read(&self.file).unwrap()),
                    "kind": "initial",
                    "createdAt": "2026-07-31T00:00:00Z"
                },
                "chapters": [],
                "consistencyIssues": [],
                "createdAt": "2026-07-31T00:00:00Z",
                "updatedAt": "2026-07-31T00:00:00Z"
            })
        }

        fn chapter(&self, task_id: &str, chapter: &ParsedChapter, status: &str) -> Value {
            json!({
                "id": format!("job-{}", chapter.id),
                "taskId": task_id,
                "chapterId": chapter.id,
                "order": chapter.order,
                "titlePath": [],
                "status": status,
                "originalMarkdown": fs::read_to_string(&self.file).unwrap()[chapter.start..chapter.end].to_string(),
                "originalHash": chapter.markdown_hash,
                "frozenHeadingSignature": "sig",
                "attempts": 0,
                "maxAttempts": 3
            })
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        initialize_schema(&db).unwrap();
        db
    }

    fn save_fixture(
        db: &Connection,
        workspace: &Workspace,
        task_id: &str,
        status: &str,
    ) -> ParsedChapter {
        save_task_sync(
            db,
            &path_string(&workspace.root),
            workspace.task(
                task_id,
                if TASK_STATUSES.contains(&status) {
                    status
                } else {
                    "running"
                },
            ),
        )
        .unwrap();
        let chapter = parse_chapters(&fs::read_to_string(&workspace.file).unwrap()).remove(0);
        save_chapter_sync(
            db,
            &path_string(&workspace.root),
            task_id,
            workspace.chapter(task_id, &chapter, status),
        )
        .unwrap();
        chapter
    }

    fn commit_request(
        workspace: &Workspace,
        task_id: &str,
        chapter: &ParsedChapter,
        before: &str,
        replacement: &str,
    ) -> CommitLongTaskChapterRequest {
        let (target, _) =
            build_replacement(before, &chapter.id, &chapter.markdown_hash, replacement).unwrap();
        CommitLongTaskChapterRequest {
            workspace_root: path_string(&workspace.root),
            task_id: task_id.into(),
            chapter_id: chapter.id.clone(),
            file_path: path_string(&workspace.file),
            expected_document_hash: hash_text(before),
            expected_chapter_hash: chapter.markdown_hash.clone(),
            replacement_markdown: replacement.into(),
            target_document_hash: hash_text(&target),
        }
    }

    #[test]
    fn schema_has_required_tables_and_no_api_key_columns() {
        let db = db();
        for table in ["proposal_long_task", "proposal_long_task_chapter"] {
            let mut statement = db.prepare(&format!("PRAGMA table_info({table})")).unwrap();
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(columns.iter().any(|column| column == "payload_json"));
            assert!(!columns
                .iter()
                .any(|column| normalized_key(column).contains("apikey")));
        }
    }

    #[test]
    fn legacy_task_modes_are_normalized_to_modify() {
        for legacy in LEGACY_MODIFY_TASK_MODES {
            let mut task = json!({ "mode": legacy });
            assert_eq!(normalize_task_mode(&mut task).unwrap(), "modify");
            assert_eq!(task.get("mode").and_then(Value::as_str), Some("modify"));
        }
        let mut current = json!({ "mode": "create" });
        assert_eq!(normalize_task_mode(&mut current).unwrap(), "create");
    }

    #[test]
    fn persistence_rejects_nested_api_keys_and_round_trips_json() {
        let db = db();
        let workspace = Workspace::new("# P\n## A\ntext\n");
        let task = workspace.task("t", "preparing");
        assert_eq!(
            save_task_sync(&db, &path_string(&workspace.root), task.clone()).unwrap(),
            task
        );
        assert_eq!(task_payload(&db, "t").unwrap(), Some(task));
        let mut invalid = workspace.task("bad", "preparing");
        invalid["sourceRefs"] = json!([{ "apiKey": "secret" }]);
        assert!(save_task_sync(&db, &path_string(&workspace.root), invalid).is_err());
    }

    #[test]
    fn opencode_migration_removes_only_attributable_legacy_backups() {
        let db = db();
        let workspace = Workspace::new("# P\n## A\ntext\n");
        save_fixture(&db, &workspace, "legacy-task", "running");
        let mut current = workspace.task("http-task", "preparing");
        current["backend"] = Value::String("opencode-http".into());
        save_task_sync(&db, &path_string(&workspace.root), current).unwrap();

        let legacy = create_backup_sync(&CreateProposalBackupRequest {
            workspace_root: path_string(&workspace.root),
            file_path: path_string(&workspace.file),
            task_id: Some("legacy-task".into()),
            kind: Some("original".into()),
        })
        .unwrap();
        let manual = create_backup_sync(&CreateProposalBackupRequest {
            workspace_root: path_string(&workspace.root),
            file_path: path_string(&workspace.file),
            task_id: Some("legacy-task".into()),
            kind: Some("manual".into()),
        })
        .unwrap();
        let unrelated = create_backup_sync(&CreateProposalBackupRequest {
            workspace_root: path_string(&workspace.root),
            file_path: path_string(&workspace.file),
            task_id: Some("unrelated-task".into()),
            kind: Some("original".into()),
        })
        .unwrap();

        db.execute(
            "DELETE FROM proposal_long_task_meta WHERE key=?1",
            params![OPENCODE_HTTP_MIGRATION],
        )
        .unwrap();
        migrate_legacy_long_tasks(&db).unwrap();

        assert!(task_payload(&db, "legacy-task").unwrap().is_none());
        assert!(list_chapter_payloads(&db, "legacy-task")
            .unwrap()
            .is_empty());
        assert!(task_payload(&db, "http-task").unwrap().is_some());
        assert!(!Path::new(&legacy.path).exists());
        assert!(!backup_manifest_path(Path::new(&legacy.path)).exists());
        assert!(Path::new(&manual.path).exists());
        assert!(backup_manifest_path(Path::new(&manual.path)).exists());
        assert!(Path::new(&unrelated.path).exists());
        assert!(backup_manifest_path(Path::new(&unrelated.path)).exists());
        assert_eq!(
            db.query_row(
                "SELECT value FROM proposal_long_task_meta WHERE key=?1",
                params![OPENCODE_HTTP_MIGRATION],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "done"
        );
    }

    #[test]
    fn stable_ids_match_typescript_fnv_parent_and_occurrence_algorithm() {
        let markdown = "# 方案\n## 概述\n### 目标\n## 概述\n## Ａ  B\n";
        let chapters = parse_chapters(markdown);
        assert_eq!(
            chapters
                .iter()
                .map(|chapter| chapter.id.as_str())
                .collect::<Vec<_>>(),
            vec!["chapter-vvo885", "chapter-vlomj6", "chapter-1pl3rh8"]
        );
        assert_eq!(chapters[0].headings[1].id, "h3-13sbhkr");
    }

    #[test]
    fn parser_ignores_fenced_headings_and_honors_exact_closing_rules() {
        let markdown = "# P\r\n```rust\r\n## fake\r\n```` text\r\n## still fake\r\n```\r\n## A\r\n~~~\r\n## fake 2\r\n~~~\r\n## B\r\n";
        let chapters = parse_chapters(markdown);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].headings[0].title, "A");
        assert_eq!(chapters[1].headings[0].title, "B");
    }

    #[test]
    fn replacement_matches_frontend_tail_and_line_ending_behavior() {
        let before = "# P\r\n## A\r\n### S\r\nold\r\n\r\n## B\r\nkeep\r\n";
        let chapter = parse_chapters(before).remove(0);
        let (next, _) = build_replacement(
            before,
            &chapter.id,
            &chapter.markdown_hash,
            "## A\n### S\nnew\n",
        )
        .unwrap();
        assert_eq!(next, "# P\r\n## A\r\n### S\r\nnew\r\n\r\n## B\r\nkeep\r\n");
        assert!(build_replacement(
            before,
            &chapter.id,
            &chapter.markdown_hash,
            "## A\n### Changed\nnew\n"
        )
        .is_err());
    }

    #[test]
    fn backup_list_and_restore_match_service_contract() {
        let workspace = Workspace::new("## A\noriginal\n");
        let backup = create_backup_sync(&CreateProposalBackupRequest {
            workspace_root: path_string(&workspace.root),
            file_path: path_string(&workspace.file),
            task_id: Some("t".into()),
            kind: Some("original".into()),
        })
        .unwrap();
        assert_eq!(
            backup.file_path,
            path_string(&fs::canonicalize(&workspace.file).unwrap())
        );
        assert_eq!(backup.task_id.as_deref(), Some("t"));
        let listed = list_backups_sync(&ListProposalBackupsRequest {
            workspace_root: path_string(&workspace.root),
            file_path: None,
            task_id: Some("t".into()),
        })
        .unwrap();
        assert_eq!(listed, vec![backup.clone()]);
        fs::write(&workspace.file, "## A\nchanged\n").unwrap();
        let result = restore_sync(
            None,
            &RestoreProposalBackupRequest {
                workspace_root: path_string(&workspace.root),
                file_path: path_string(&workspace.file),
                backup_path: backup.path,
                expected_document_hash: Some(hash_text("## A\nchanged\n")),
                task_id: None,
            },
        )
        .unwrap();
        assert_eq!(
            result.file_path,
            path_string(&fs::canonicalize(&workspace.file).unwrap())
        );
        assert_eq!(result.content, "## A\noriginal\n");
        assert_eq!(result.sha256, hash_text(&result.content));
    }

    #[test]
    fn restore_rejects_backup_from_another_proposal() {
        let first = Workspace::new("## A\none\n");
        let second_file = first.root.join("second.md");
        fs::write(&second_file, "## B\ntwo\n").unwrap();
        let backup = create_backup_sync(&CreateProposalBackupRequest {
            workspace_root: path_string(&first.root),
            file_path: path_string(&first.file),
            task_id: None,
            kind: Some("manual".into()),
        })
        .unwrap();
        assert!(restore_sync(
            None,
            &RestoreProposalBackupRequest {
                workspace_root: path_string(&first.root),
                file_path: path_string(&second_file),
                backup_path: backup.path,
                expected_document_hash: None,
                task_id: None,
            }
        )
        .is_err());
    }

    #[test]
    fn cas_commit_returns_exact_committed_shape_and_persists_completed() {
        let before = "# P\n## A\n### S\nold\n## B\nkeep\n";
        let workspace = Workspace::new(before);
        let db = db();
        let chapter = save_fixture(&db, &workspace, "t", "queued");
        let request = commit_request(&workspace, "t", &chapter, before, "## A\n### S\nnew\n");
        let result = commit_sync(&db, &request).unwrap();
        match result {
            CommitLongTaskChapterResult::Committed {
                file_path,
                document_hash,
                chapter_hash,
                content,
            } => {
                assert_eq!(
                    file_path,
                    path_string(&fs::canonicalize(&workspace.file).unwrap())
                );
                assert_eq!(document_hash, hash_text(&content));
                assert_eq!(chapter_hash, parse_chapters(&content)[0].markdown_hash);
                assert_eq!(content, "# P\n## A\n### S\nnew\n## B\nkeep\n");
            }
            other => panic!("unexpected result: {other:?}"),
        }
        assert_eq!(
            chapter_payload(&db, "t", &chapter.id).unwrap().unwrap()["status"],
            "completed"
        );
    }

    #[test]
    fn cas_conflicts_use_frontend_reason_enums() {
        let before = "## A\nold\n";
        let workspace = Workspace::new(before);
        let db = db();
        let chapter = save_fixture(&db, &workspace, "t", "queued");
        let request = commit_request(&workspace, "t", &chapter, before, "## A\nnew\n");
        fs::write(&workspace.file, "## A\nexternal\n").unwrap();
        assert!(matches!(
            commit_sync(&db, &request).unwrap(),
            CommitLongTaskChapterResult::Conflict { reason, .. } if reason == "document_hash"
        ));

        let missing = build_replacement(
            before,
            "chapter-missing",
            &chapter.markdown_hash,
            "## A\nnew\n",
        );
        assert!(matches!(
            missing,
            Err(CommitLongTaskChapterResult::Conflict { reason, .. }) if reason == "missing_chapter"
        ));
        let wrong_hash = build_replacement(before, &chapter.id, &hash_text("wrong"), "## A\nnew\n");
        assert!(matches!(
            wrong_hash,
            Err(CommitLongTaskChapterResult::Conflict { reason, .. }) if reason == "chapter_hash"
        ));
    }

    #[test]
    fn recovery_finalizes_target_retries_old_and_detects_third_state() {
        let before = "## A\nold\n";

        let target_workspace = Workspace::new(before);
        let target_db = db();
        let target_chapter = save_fixture(&target_db, &target_workspace, "target", "queued");
        let target_request = commit_request(
            &target_workspace,
            "target",
            &target_chapter,
            before,
            "## A\nnew\n",
        );
        let (target_content, target_chapter_hash) = build_replacement(
            before,
            &target_chapter.id,
            &target_chapter.markdown_hash,
            &target_request.replacement_markdown,
        )
        .unwrap();
        mark_committing(&target_db, &target_request, &target_chapter_hash).unwrap();
        fs::write(&target_workspace.file, &target_content).unwrap();
        assert_eq!(
            reconcile_task_committing(&target_db, &path_string(&target_workspace.root), "target")
                .unwrap()[0]
                .action,
            "finalized"
        );

        let old_workspace = Workspace::new(before);
        let old_db = db();
        let old_chapter = save_fixture(&old_db, &old_workspace, "old", "queued");
        let old_request =
            commit_request(&old_workspace, "old", &old_chapter, before, "## A\nnew\n");
        let (_, old_target_chapter_hash) = build_replacement(
            before,
            &old_chapter.id,
            &old_chapter.markdown_hash,
            &old_request.replacement_markdown,
        )
        .unwrap();
        mark_committing(&old_db, &old_request, &old_target_chapter_hash).unwrap();
        assert_eq!(
            reconcile_task_committing(&old_db, &path_string(&old_workspace.root), "old").unwrap()
                [0]
            .action,
            "retried"
        );

        let third_workspace = Workspace::new(before);
        let third_db = db();
        let third_chapter = save_fixture(&third_db, &third_workspace, "third", "queued");
        let third_request = commit_request(
            &third_workspace,
            "third",
            &third_chapter,
            before,
            "## A\nnew\n",
        );
        let (_, third_target_chapter_hash) = build_replacement(
            before,
            &third_chapter.id,
            &third_chapter.markdown_hash,
            &third_request.replacement_markdown,
        )
        .unwrap();
        mark_committing(&third_db, &third_request, &third_target_chapter_hash).unwrap();
        fs::write(&third_workspace.file, "## A\nthird\n").unwrap();
        let result =
            reconcile_task_committing(&third_db, &path_string(&third_workspace.root), "third")
                .unwrap();
        assert_eq!(result[0].action, "conflict");
        assert_eq!(result[0].reason.as_deref(), Some("unexpected_disk_state"));
    }

    #[test]
    fn recover_requeues_running_workers_and_returns_service_shape() {
        let workspace = Workspace::new("## A\nold\n");
        let db = db();
        save_fixture(&db, &workspace, "t", "running");
        let result = recover_task_sync(&db, &path_string(&workspace.root), "t").unwrap();
        assert_eq!(result.recovery, "requeued");
        assert_eq!(result.chapters[0]["status"], "queued");
        assert_eq!(result.task["chapters"][0]["status"], "queued");
        assert_eq!(result.disk_hash, hash_text("## A\nold\n"));
    }

    #[test]
    fn delete_task_cascades_chapters() {
        let workspace = Workspace::new("## A\nold\n");
        let db = db();
        save_fixture(&db, &workspace, "t", "queued");
        db.execute("DELETE FROM proposal_long_task WHERE id=?1", params!["t"])
            .unwrap();
        assert!(task_payload(&db, "t").unwrap().is_none());
        assert!(list_chapter_payloads(&db, "t").unwrap().is_empty());
    }
}
