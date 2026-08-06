use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter};

const DB_VERSION: i64 = 4;
const CHANGE_EVENT: &str = "agent-conversations:changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversation {
    id: String,
    project_id: String,
    title: String,
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    summary: String,
    #[serde(default = "default_agent_mode")]
    mode: String,
    #[serde(default)]
    pinned_context_only: bool,
    #[serde(default)]
    web_search_enabled: bool,
    #[serde(default)]
    knowledge_search_enabled: bool,
    #[serde(default)]
    memory_search_enabled: bool,
    #[serde(default)]
    full_access_enabled: bool,
    #[serde(default)]
    full_access_acknowledged: bool,
    #[serde(default)]
    enabled_skills: Vec<Value>,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    revision: i64,
    #[serde(default = "default_true")]
    messages_loaded: bool,
    #[serde(default)]
    message_count: i64,
}

fn default_true() -> bool {
    true
}

fn default_agent_mode() -> String {
    "build".into()
}

fn normalize_agent_mode(mode: &str) -> String {
    if mode == "plan" {
        "plan".into()
    } else {
        "build".into()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPatch {
    id: String,
    project_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    pinned_context_only: Option<bool>,
    #[serde(default)]
    web_search_enabled: Option<bool>,
    #[serde(default)]
    knowledge_search_enabled: Option<bool>,
    #[serde(default)]
    memory_search_enabled: Option<bool>,
    #[serde(default)]
    full_access_enabled: Option<bool>,
    #[serde(default)]
    full_access_acknowledged: Option<bool>,
    #[serde(default)]
    enabled_skills: Option<Vec<Value>>,
    #[serde(default)]
    expected_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum ConversationChange {
    #[serde(rename = "saved")]
    Saved {
        project_id: String,
        conversation: AgentConversation,
    },
    #[serde(rename = "deleted")]
    Deleted {
        project_id: String,
        conversation_id: String,
    },
    #[serde(rename = "cleared")]
    Cleared { project_id: String },
}

fn db_path(workspace_root: &str) -> Result<PathBuf, String> {
    let root = workspace_root.trim();
    if root.is_empty() {
        return Err("工作目录不能为空".into());
    }
    let dir = PathBuf::from(root).join(".gouan");
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败: {e}"))?;
    Ok(dir.join("conversations.db"))
}

fn open_db(workspace_root: &str) -> Result<Connection, String> {
    let path = db_path(workspace_root)?;
    let mut conn = Connection::open(path).map_err(|e| format!("打开会话数据库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA foreign_keys=ON;
         PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS agent_conversation(
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           title TEXT NOT NULL,
           summary TEXT NOT NULL DEFAULT '',
           mode TEXT NOT NULL DEFAULT 'build',
           pinned_context_only INTEGER NOT NULL DEFAULT 0,
           web_search_enabled INTEGER NOT NULL DEFAULT 0,
           knowledge_search_enabled INTEGER NOT NULL DEFAULT 0,
           memory_search_enabled INTEGER NOT NULL DEFAULT 0,
           full_access_enabled INTEGER NOT NULL DEFAULT 0,
           full_access_acknowledged INTEGER NOT NULL DEFAULT 0,
           enabled_skills TEXT NOT NULL DEFAULT '[]',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           revision INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS agent_conversation_message(
           conversation_id TEXT NOT NULL,
           sequence INTEGER NOT NULL,
           role TEXT NOT NULL,
           message_json TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY(conversation_id, sequence),
           FOREIGN KEY(conversation_id) REFERENCES agent_conversation(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS agent_conversation_meta(
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_conversation_project_updated
           ON agent_conversation(project_id, updated_at DESC);
         CREATE INDEX IF NOT EXISTS idx_agent_message_conversation_sequence
           ON agent_conversation_message(conversation_id, sequence);",
    )
    .map_err(|e| format!("初始化会话数据库失败: {e}"))?;
    ensure_column(&conn, "full_access_enabled", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(
        &conn,
        "full_access_acknowledged",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(&conn, "memory_search_enabled", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "enabled_skills", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(&conn, "mode", "TEXT NOT NULL DEFAULT 'build'")?;
    conn.pragma_update(None, "user_version", DB_VERSION)
        .map_err(|e| e.to_string())?;
    migrate_json(&mut conn, workspace_root)?;
    Ok(conn)
}

fn ensure_column(conn: &Connection, name: &str, definition: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(agent_conversation)")
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !names.iter().any(|item| item == name) {
        conn.execute(
            &format!("ALTER TABLE agent_conversation ADD COLUMN {name} {definition}"),
            [],
        )
        .map_err(|e| format!("升级会话数据库失败: {e}"))?;
    }
    Ok(())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM agent_conversation_meta WHERE key=?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn migrate_json(conn: &mut Connection, workspace_root: &str) -> Result<(), String> {
    if meta_value(conn, "json_migration_v1")?.as_deref() == Some("done") {
        return Ok(());
    }
    let path = PathBuf::from(workspace_root)
        .join(".gouan")
        .join("agent-conversations.json");
    if !path.exists() {
        conn.execute("INSERT OR REPLACE INTO agent_conversation_meta(key,value) VALUES('json_migration_v1','done')", [])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取旧会话文件失败: {e}"))?;
    let conversations: Vec<AgentConversation> = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("旧会话 JSON 损坏，已保留原文件并跳过本次迁移: {error}");
            return Ok(());
        }
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for conversation in conversations {
        upsert_tx(&tx, &conversation, false)?;
    }
    tx.execute("INSERT OR REPLACE INTO agent_conversation_meta(key,value) VALUES('json_migration_v1','done')", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| format!("提交旧会话迁移失败: {e}"))
}

fn row_to_conversation(
    row: &rusqlite::Row<'_>,
    messages_loaded: bool,
) -> rusqlite::Result<AgentConversation> {
    Ok(AgentConversation {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        messages: Vec::new(),
        summary: row.get(3)?,
        mode: row.get(4)?,
        pinned_context_only: row.get::<_, i64>(5)? != 0,
        web_search_enabled: row.get::<_, i64>(6)? != 0,
        knowledge_search_enabled: row.get::<_, i64>(7)? != 0,
        full_access_enabled: row.get::<_, i64>(8)? != 0,
        full_access_acknowledged: row.get::<_, i64>(9)? != 0,
        memory_search_enabled: row.get::<_, i64>(10)? != 0,
        enabled_skills: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        revision: row.get(14)?,
        messages_loaded,
        message_count: row.get(15)?,
    })
}

fn get_sync(conn: &Connection, id: &str) -> Result<AgentConversation, String> {
    let mut conversation = conn.query_row(
        "SELECT id,project_id,title,summary,mode,pinned_context_only,web_search_enabled,knowledge_search_enabled,full_access_enabled,full_access_acknowledged,memory_search_enabled,enabled_skills,created_at,updated_at,revision,(SELECT COUNT(*) FROM agent_conversation_message m WHERE m.conversation_id=agent_conversation.id AND m.role IN ('user','assistant')) FROM agent_conversation WHERE id=?1",
        [id], |row| row_to_conversation(row, true)
    ).optional().map_err(|e| e.to_string())?.ok_or_else(|| "会话不存在".to_string())?;
    let mut stmt = conn.prepare("SELECT message_json FROM agent_conversation_message WHERE conversation_id=?1 ORDER BY sequence")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let raw = row.map_err(|e| e.to_string())?;
        conversation
            .messages
            .push(serde_json::from_str(&raw).map_err(|e| format!("解析会话消息失败: {e}"))?);
    }
    Ok(conversation)
}

fn upsert_tx(
    tx: &Transaction<'_>,
    input: &AgentConversation,
    check_revision: bool,
) -> Result<i64, String> {
    let existing: Option<i64> = tx
        .query_row(
            "SELECT revision FROM agent_conversation WHERE id=?1",
            [&input.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if check_revision && input.revision > 0 && existing.is_some_and(|value| value != input.revision)
    {
        return Err("会话已在其他位置更新，请重新加载该会话".into());
    }
    let revision = existing.unwrap_or(0) + 1;
    tx.execute(
        "INSERT INTO agent_conversation(id,project_id,title,summary,mode,pinned_context_only,web_search_enabled,knowledge_search_enabled,full_access_enabled,full_access_acknowledged,memory_search_enabled,enabled_skills,created_at,updated_at,revision)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,summary=excluded.summary,
           mode=excluded.mode,pinned_context_only=excluded.pinned_context_only,web_search_enabled=excluded.web_search_enabled,
           knowledge_search_enabled=excluded.knowledge_search_enabled,full_access_enabled=excluded.full_access_enabled,
           full_access_acknowledged=excluded.full_access_acknowledged,memory_search_enabled=excluded.memory_search_enabled,
           enabled_skills=excluded.enabled_skills,updated_at=excluded.updated_at,revision=excluded.revision",
        params![input.id,input.project_id,input.title,input.summary,input.mode,input.pinned_context_only as i64,input.web_search_enabled as i64,input.knowledge_search_enabled as i64,input.full_access_enabled as i64,input.full_access_acknowledged as i64,input.memory_search_enabled as i64,serde_json::to_string(&input.enabled_skills).map_err(|e|e.to_string())?,input.created_at,input.updated_at,revision]
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM agent_conversation_message WHERE conversation_id=?1",
        [&input.id],
    )
    .map_err(|e| e.to_string())?;
    for (sequence, message) in input.messages.iter().enumerate() {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let raw = serde_json::to_string(message).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO agent_conversation_message(conversation_id,sequence,role,message_json,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![input.id,sequence as i64,role,raw,input.updated_at]).map_err(|e| e.to_string())?;
    }
    Ok(revision)
}

#[tauri::command]
pub fn agent_conversation_list(
    workspace_root: String,
    project_id: String,
) -> Result<Vec<AgentConversation>, String> {
    let conn = open_db(&workspace_root)?;
    let mut stmt = conn.prepare("SELECT id,project_id,title,summary,mode,pinned_context_only,web_search_enabled,knowledge_search_enabled,full_access_enabled,full_access_acknowledged,memory_search_enabled,enabled_skills,created_at,updated_at,revision,(SELECT COUNT(*) FROM agent_conversation_message m WHERE m.conversation_id=agent_conversation.id AND m.role IN ('user','assistant')) FROM agent_conversation WHERE project_id=?1 ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id], |row| row_to_conversation(row, false))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_conversation_get(
    workspace_root: String,
    id: String,
) -> Result<AgentConversation, String> {
    get_sync(&open_db(&workspace_root)?, &id)
}

#[tauri::command]
pub fn agent_conversation_upsert(
    app: AppHandle,
    workspace_root: String,
    mut conversation: AgentConversation,
) -> Result<AgentConversation, String> {
    conversation.mode = normalize_agent_mode(&conversation.mode);
    let mut conn = open_db(&workspace_root)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    conversation.revision = upsert_tx(&tx, &conversation, true)?;
    conversation.messages_loaded = true;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = app.emit(
        CHANGE_EVENT,
        ConversationChange::Saved {
            project_id: conversation.project_id.clone(),
            conversation: conversation.clone(),
        },
    );
    Ok(conversation)
}

#[tauri::command]
pub fn agent_conversation_patch(
    app: AppHandle,
    workspace_root: String,
    patch: ConversationPatch,
) -> Result<AgentConversation, String> {
    let mut conn = open_db(&workspace_root)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current = get_sync(&tx, &patch.id)?;
    if patch
        .expected_revision
        .is_some_and(|revision| revision != current.revision)
    {
        return Err("会话已在其他位置更新，请重新加载该会话".into());
    }
    let revision = current.revision + 1;
    let mode = patch
        .mode
        .as_deref()
        .map(normalize_agent_mode)
        .unwrap_or(current.mode.clone());
    tx.execute("UPDATE agent_conversation SET title=?2,mode=?3,pinned_context_only=?4,web_search_enabled=?5,knowledge_search_enabled=?6,full_access_enabled=?7,full_access_acknowledged=?8,memory_search_enabled=?9,enabled_skills=?10,updated_at=?11,revision=?12 WHERE id=?1 AND project_id=?13",
        params![patch.id,patch.title.unwrap_or(current.title),mode,patch.pinned_context_only.unwrap_or(current.pinned_context_only) as i64,patch.web_search_enabled.unwrap_or(current.web_search_enabled) as i64,patch.knowledge_search_enabled.unwrap_or(current.knowledge_search_enabled) as i64,patch.full_access_enabled.unwrap_or(current.full_access_enabled) as i64,patch.full_access_acknowledged.unwrap_or(current.full_access_acknowledged) as i64,patch.memory_search_enabled.unwrap_or(current.memory_search_enabled) as i64,serde_json::to_string(&patch.enabled_skills.unwrap_or(current.enabled_skills)).map_err(|e|e.to_string())?,current.updated_at,revision,patch.project_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let updated = get_sync(&conn, &patch.id)?;
    let _ = app.emit(
        CHANGE_EVENT,
        ConversationChange::Saved {
            project_id: updated.project_id.clone(),
            conversation: updated.clone(),
        },
    );
    Ok(updated)
}

#[tauri::command]
pub fn agent_conversation_delete(
    app: AppHandle,
    workspace_root: String,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let conn = open_db(&workspace_root)?;
    conn.execute(
        "DELETE FROM agent_conversation WHERE id=?1 AND project_id=?2",
        params![id, project_id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        CHANGE_EVENT,
        ConversationChange::Deleted {
            project_id,
            conversation_id: id,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn agent_conversation_clear_project(
    app: AppHandle,
    workspace_root: String,
    project_id: String,
) -> Result<usize, String> {
    let conn = open_db(&workspace_root)?;
    let count = conn
        .execute(
            "DELETE FROM agent_conversation WHERE project_id=?1",
            [&project_id],
        )
        .map_err(|e| e.to_string())?;
    let _ = app.emit(CHANGE_EVENT, ConversationChange::Cleared { project_id });
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE agent_conversation(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL DEFAULT 'build',pinned_context_only INTEGER NOT NULL DEFAULT 0,web_search_enabled INTEGER NOT NULL DEFAULT 0,knowledge_search_enabled INTEGER NOT NULL DEFAULT 0,memory_search_enabled INTEGER NOT NULL DEFAULT 0,full_access_enabled INTEGER NOT NULL DEFAULT 0,full_access_acknowledged INTEGER NOT NULL DEFAULT 0,enabled_skills TEXT NOT NULL DEFAULT '[]',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1); CREATE TABLE agent_conversation_message(conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,role TEXT NOT NULL,message_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,sequence),FOREIGN KEY(conversation_id) REFERENCES agent_conversation(id) ON DELETE CASCADE);").unwrap();
        conn
    }

    fn sample() -> AgentConversation {
        AgentConversation {
            id: "c1".into(),
            project_id: "p1".into(),
            title: "T".into(),
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            summary: String::new(),
            mode: "build".into(),
            pinned_context_only: false,
            web_search_enabled: false,
            knowledge_search_enabled: true,
            memory_search_enabled: false,
            full_access_enabled: false,
            full_access_acknowledged: false,
            enabled_skills: Vec::new(),
            created_at: 1,
            updated_at: 2,
            revision: 0,
            messages_loaded: true,
            message_count: 1,
        }
    }

    #[test]
    fn upsert_get_and_revision_conflict() {
        let mut conn = setup();
        let mut item = sample();
        let tx = conn.transaction().unwrap();
        item.revision = upsert_tx(&tx, &item, true).unwrap();
        tx.commit().unwrap();
        assert_eq!(get_sync(&conn, "c1").unwrap().messages.len(), 1);
        let tx = conn.transaction().unwrap();
        let mut stale = item.clone();
        stale.revision = 99;
        assert!(upsert_tx(&tx, &stale, true).is_err());
    }

    #[test]
    fn delete_cascades_messages() {
        let mut conn = setup();
        let item = sample();
        let tx = conn.transaction().unwrap();
        upsert_tx(&tx, &item, true).unwrap();
        tx.commit().unwrap();
        conn.execute("DELETE FROM agent_conversation WHERE id='c1'", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_conversation_message", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn list_returns_correct_column_alignment() {
        // 回归：agent_conversation_list 的列顺序必须与 row_to_conversation 一致，
        // 否则会列偏移（enabled_skills 读到 created_at、revision 读到消息数、
        // message_count 越界），导致“历史会话加载失败”。
        let dir = std::env::temp_dir().join(format!("gouan_conv_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().to_string();
        let mut conn = open_db(&root).unwrap();
        let tx = conn.transaction().unwrap();
        let mut item = sample();
        upsert_tx(&tx, &item, false).unwrap();
        tx.commit().unwrap();

        let listed = agent_conversation_list(root.clone(), "p1".to_string())
            .expect("agent_conversation_list 不应失败");
        assert_eq!(listed.len(), 1);
        let conv = &listed[0];
        // enabled_skills 必须是空数组，而不是被列偏移塞进来的 created_at 整数。
        assert!(
            conv.enabled_skills.is_empty(),
            "enabled_skills 列偏移，得到 {:?}",
            conv.enabled_skills
        );
        assert_eq!(conv.memory_search_enabled, false);
        // revision 应为 1（自增），而不是被偏移成消息数。
        assert_eq!(conv.revision, 1, "revision 列偏移，得到 {}", conv.revision);
        assert_eq!(
            conv.message_count, 1,
            "message_count 列偏移，得到 {}",
            conv.message_count
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adds_full_access_columns_to_legacy_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE agent_conversation(id TEXT PRIMARY KEY);")
            .unwrap();
        ensure_column(&conn, "full_access_enabled", "INTEGER NOT NULL DEFAULT 0").unwrap();
        ensure_column(
            &conn,
            "full_access_acknowledged",
            "INTEGER NOT NULL DEFAULT 0",
        )
        .unwrap();
        ensure_column(&conn, "mode", "TEXT NOT NULL DEFAULT 'build'").unwrap();
        let mut stmt = conn
            .prepare("PRAGMA table_info(agent_conversation)")
            .unwrap();
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(names.contains(&"full_access_enabled".to_string()));
        assert!(names.contains(&"full_access_acknowledged".to_string()));
        assert!(names.contains(&"mode".to_string()));
    }
}
