use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const DB_VERSION: i64 = 4;
const CHANGE_EVENT: &str = "agent-conversations:changed";
const JSON_FILE_NAME: &str = "agent-conversations.json";

static JSON_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn json_write_lock() -> &'static Mutex<()> {
    JSON_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

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
    let conn = Connection::open(path).map_err(|e| format!("打开会话数据库失败: {e}"))?;
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

fn conversation_message_count(messages: &[Value]) -> i64 {
    messages
        .iter()
        .filter(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("user" | "assistant")
            )
        })
        .count() as i64
}

fn normalize_conversation(mut conversation: AgentConversation) -> AgentConversation {
    conversation.mode = normalize_agent_mode(&conversation.mode);
    conversation.messages_loaded = true;
    conversation.message_count = conversation_message_count(&conversation.messages);
    conversation
}

fn json_path(workspace_root: &str) -> Result<PathBuf, String> {
    let root = workspace_root.trim();
    if root.is_empty() {
        return Err("工作目录不能为空".into());
    }
    let dir = PathBuf::from(root).join(".gouan");
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败: {e}"))?;
    Ok(dir.join(JSON_FILE_NAME))
}

fn json_temp_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.tmp", JSON_FILE_NAME))
}

fn parse_json_state(raw: &str) -> Result<Vec<AgentConversation>, String> {
    let values: Vec<Value> =
        serde_json::from_str(raw).map_err(|e| format!("会话 JSON 损坏: {e}"))?;
    let mut conversations = Vec::with_capacity(values.len());
    for (index, value) in values.into_iter().enumerate() {
        match serde_json::from_value::<AgentConversation>(value) {
            Ok(conversation) => conversations.push(normalize_conversation(conversation)),
            Err(error) => eprintln!("跳过非法会话记录 #{index}: {error}"),
        }
    }
    Ok(conversations)
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let temp = wide(temp);
    let target = wide(target);
    let replaced =
        unsafe { MoveFileExW(temp.as_ptr(), target.as_ptr(), 0x0000_0001 | 0x0000_0008) };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(temp, target)
}

fn write_json_state(path: &Path, conversations: &[AgentConversation]) -> Result<(), String> {
    let raw =
        serde_json::to_vec_pretty(conversations).map_err(|e| format!("序列化会话失败: {e}"))?;
    let temp = json_temp_path(path);
    let mut file = fs::File::create(&temp).map_err(|e| format!("创建会话临时文件失败: {e}"))?;
    file.write_all(&raw)
        .map_err(|e| format!("写入会话临时文件失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("刷新会话临时文件失败: {e}"))?;
    drop(file);
    replace_file(&temp, path).map_err(|e| format!("替换会话文件失败: {e}"))
}

fn load_legacy_sqlite_state(workspace_root: &str) -> Result<Vec<AgentConversation>, String> {
    let conn = open_db(workspace_root)?;
    let mut statement = conn
        .prepare("SELECT id FROM agent_conversation ORDER BY updated_at DESC")
        .map_err(|e| format!("读取旧会话数据库失败: {e}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("读取旧会话索引失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取旧会话索引失败: {e}"))?;
    drop(statement);
    ids.into_iter()
        .map(|id| get_sync(&conn, &id))
        .collect::<Result<Vec<_>, _>>()
}

fn load_json_state(workspace_root: &str) -> Result<Vec<AgentConversation>, String> {
    let path = json_path(workspace_root)?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("读取会话文件失败: {e}"))?;
        return parse_json_state(&raw);
    }

    let temp = json_temp_path(&path);
    if temp.exists() {
        let raw = fs::read_to_string(&temp).map_err(|e| format!("读取会话临时文件失败: {e}"))?;
        if let Ok(conversations) = parse_json_state(&raw) {
            write_json_state(&path, &conversations)?;
            return Ok(conversations);
        }
    }

    let legacy_db = PathBuf::from(workspace_root.trim())
        .join(".gouan")
        .join("conversations.db");
    let conversations = if legacy_db.exists() {
        load_legacy_sqlite_state(workspace_root)?
    } else {
        Vec::new()
    };
    write_json_state(&path, &conversations)?;
    Ok(conversations)
}

fn save_json_state(
    workspace_root: &str,
    conversations: &[AgentConversation],
) -> Result<(), String> {
    let path = json_path(workspace_root)?;
    write_json_state(&path, conversations)
}

fn summary_conversation(conversation: &AgentConversation) -> AgentConversation {
    let mut summary = conversation.clone();
    summary.messages.clear();
    summary.messages_loaded = false;
    summary.message_count = conversation_message_count(&conversation.messages);
    summary
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
    let conversations = load_json_state(&workspace_root)?;
    let mut listed: Vec<_> = conversations
        .iter()
        .filter(|conversation| conversation.project_id == project_id)
        .map(summary_conversation)
        .collect();
    listed.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(listed)
}

#[tauri::command]
pub fn agent_conversation_get(
    workspace_root: String,
    id: String,
) -> Result<AgentConversation, String> {
    load_json_state(&workspace_root)?
        .into_iter()
        .find(|conversation| conversation.id == id)
        .map(normalize_conversation)
        .ok_or_else(|| "会话不存在".into())
}

#[tauri::command]
pub fn agent_conversation_upsert(
    app: AppHandle,
    workspace_root: String,
    conversation: AgentConversation,
) -> Result<AgentConversation, String> {
    let _guard = json_write_lock()
        .lock()
        .map_err(|_| "保存会话失败：写入锁已损坏".to_string())?;
    let mut conversations = load_json_state(&workspace_root)?;
    let mut conversation = normalize_conversation(conversation);
    let existing = conversations.iter().find(|item| item.id == conversation.id);
    if conversation.revision > 0
        && existing.is_some_and(|item| item.revision != conversation.revision)
    {
        return Err("会话已在其他位置更新，请重新加载该会话".into());
    }
    conversation.revision = existing.map_or(1, |item| item.revision + 1);
    if let Some(index) = conversations
        .iter()
        .position(|item| item.id == conversation.id)
    {
        conversations[index] = conversation.clone();
    } else {
        conversations.push(conversation.clone());
    }
    save_json_state(&workspace_root, &conversations)?;
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
    let _guard = json_write_lock()
        .lock()
        .map_err(|_| "保存会话失败：写入锁已损坏".to_string())?;
    let mut conversations = load_json_state(&workspace_root)?;
    let index = conversations
        .iter()
        .position(|conversation| {
            conversation.id == patch.id && conversation.project_id == patch.project_id
        })
        .ok_or_else(|| "会话不存在".to_string())?;
    let current = &conversations[index];
    if patch
        .expected_revision
        .is_some_and(|revision| revision != current.revision)
    {
        return Err("会话已在其他位置更新，请重新加载该会话".into());
    }
    let mut updated = current.clone();
    if let Some(title) = patch.title {
        updated.title = title;
    }
    if let Some(mode) = patch.mode {
        updated.mode = normalize_agent_mode(&mode);
    }
    if let Some(value) = patch.pinned_context_only {
        updated.pinned_context_only = value;
    }
    if let Some(value) = patch.web_search_enabled {
        updated.web_search_enabled = value;
    }
    if let Some(value) = patch.knowledge_search_enabled {
        updated.knowledge_search_enabled = value;
    }
    if let Some(value) = patch.memory_search_enabled {
        updated.memory_search_enabled = value;
    }
    if let Some(value) = patch.full_access_enabled {
        updated.full_access_enabled = value;
    }
    if let Some(value) = patch.full_access_acknowledged {
        updated.full_access_acknowledged = value;
    }
    if let Some(value) = patch.enabled_skills {
        updated.enabled_skills = value;
    }
    updated.updated_at = chrono_like_now();
    updated.revision += 1;
    conversations[index] = updated.clone();
    save_json_state(&workspace_root, &conversations)?;
    let _ = app.emit(
        CHANGE_EVENT,
        ConversationChange::Saved {
            project_id: updated.project_id.clone(),
            conversation: updated.clone(),
        },
    );
    Ok(updated)
}

fn chrono_like_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

#[tauri::command]
pub fn agent_conversation_delete(
    app: AppHandle,
    workspace_root: String,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let _guard = json_write_lock()
        .lock()
        .map_err(|_| "删除会话失败：写入锁已损坏".to_string())?;
    let mut conversations = load_json_state(&workspace_root)?;
    conversations
        .retain(|conversation| !(conversation.id == id && conversation.project_id == project_id));
    save_json_state(&workspace_root, &conversations)?;
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
    let _guard = json_write_lock()
        .lock()
        .map_err(|_| "清空会话失败：写入锁已损坏".to_string())?;
    let mut conversations = load_json_state(&workspace_root)?;
    let before = conversations.len();
    conversations.retain(|conversation| conversation.project_id != project_id);
    save_json_state(&workspace_root, &conversations)?;
    let _ = app.emit(CHANGE_EVENT, ConversationChange::Cleared { project_id });
    Ok(before - conversations.len())
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
        let item = sample();
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
    fn json_round_trip_preserves_complete_messages() {
        let root = std::env::temp_dir().join(format!(
            "gouan_json_test_{}_{}",
            std::process::id(),
            chrono_like_now()
        ));
        let _ = fs::remove_dir_all(&root);
        let root_string = root.to_string_lossy().to_string();
        let conversation = sample();
        let path = json_path(&root_string).unwrap();
        write_json_state(&path, std::slice::from_ref(&conversation)).unwrap();

        let loaded = load_json_state(&root_string).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].messages, conversation.messages);
        assert_eq!(loaded[0].message_count, 1);
        assert!(path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_json_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!(
            "gouan_json_corrupt_test_{}_{}",
            std::process::id(),
            chrono_like_now()
        ));
        let _ = fs::remove_dir_all(&root);
        let root_string = root.to_string_lossy().to_string();
        let path = json_path(&root_string).unwrap();
        fs::write(&path, b"{not valid json").unwrap();

        let result = load_json_state(&root_string);
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not valid json");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exports_legacy_sqlite_to_json_once() {
        let root = std::env::temp_dir().join(format!(
            "gouan_json_migration_test_{}_{}",
            std::process::id(),
            chrono_like_now()
        ));
        let _ = fs::remove_dir_all(&root);
        let root_string = root.to_string_lossy().to_string();
        let mut conn = open_db(&root_string).unwrap();
        let conversation = sample();
        let tx = conn.transaction().unwrap();
        upsert_tx(&tx, &conversation, false).unwrap();
        tx.commit().unwrap();
        drop(conn);

        let loaded = load_json_state(&root_string).unwrap();
        assert_eq!(loaded[0].id, conversation.id);
        assert_eq!(loaded[0].messages, conversation.messages);
        assert!(json_path(&root_string).unwrap().exists());
        let _ = fs::remove_dir_all(root);
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
