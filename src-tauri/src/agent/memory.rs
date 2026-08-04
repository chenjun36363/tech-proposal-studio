use crate::WorkspacePaths;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MEMORY_VERSION: i64 = 1;
const VALID_TYPES: [&str; 5] = ["decision", "preference", "constraint", "fact", "reference"];
const VALID_STATUSES: [&str; 3] = ["active", "pending_review", "archived"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    id: String,
    memory_type: String,
    title: String,
    content: String,
    confidence: String,
    status: String,
    source_conversation_id: Option<String>,
    source_message_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryFileMeta {
    id: String,
    memory_type: String,
    title: String,
    confidence: String,
    status: String,
    source_conversation_id: Option<String>,
    source_message_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteInput {
    id: Option<String>,
    memory_type: String,
    title: String,
    content: String,
    confidence: Option<String>,
    status: Option<String>,
    source_conversation_id: Option<String>,
    source_message_id: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn memory_root(workspace: &WorkspacePaths) -> Result<PathBuf, String> {
    if workspace.root.trim().is_empty() {
        return Err("请先配置工作目录".into());
    }
    let root = PathBuf::from(&workspace.root).join(".gouan").join("memory");
    for kind in VALID_TYPES {
        fs::create_dir_all(root.join(kind)).map_err(|e| format!("创建记忆目录失败: {e}"))?;
    }
    fs::create_dir_all(root.join(".trash")).map_err(|e| format!("创建记忆回收站失败: {e}"))?;
    Ok(root)
}

fn memory_db(workspace: &WorkspacePaths) -> Result<Connection, String> {
    let gouan = PathBuf::from(&workspace.root).join(".gouan");
    fs::create_dir_all(&gouan).map_err(|e| format!("创建工作区配置目录失败: {e}"))?;
    let db = Connection::open(gouan.join("memory.db")).map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS agent_memory(
           id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
           confidence TEXT NOT NULL, status TEXT NOT NULL, source_conversation_id TEXT,
           source_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, path TEXT NOT NULL UNIQUE
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
           id UNINDEXED, title, content, tokenize='unicode61'
         );
         CREATE TABLE IF NOT EXISTS agent_memory_audit(
           id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, operation TEXT NOT NULL,
           actor TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS agent_memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT OR REPLACE INTO agent_memory_meta(key,value) VALUES('schema_version','1');"
    ).map_err(|e| format!("初始化记忆索引失败: {e}"))?;
    Ok(db)
}

fn validate_type(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if VALID_TYPES.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("不支持的记忆类型: {value}"))
    }
}

fn validate_status(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if VALID_STATUSES.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("不支持的记忆状态: {value}"))
    }
}

fn make_id(seed: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(format!("{}:{seed}", now_ms()));
    format!("mem-{}", &format!("{:x}", hash.finalize())[..16])
}

fn validate_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("记忆 ID 只能包含字母、数字、短横线和下划线".into());
    }
    Ok(value.to_string())
}

fn render_entry(entry: &MemoryEntry) -> Result<String, String> {
    let meta = serde_json::to_string(&MemoryFileMeta {
        id: entry.id.clone(),
        memory_type: entry.memory_type.clone(),
        title: entry.title.clone(),
        confidence: entry.confidence.clone(),
        status: entry.status.clone(),
        source_conversation_id: entry.source_conversation_id.clone(),
        source_message_id: entry.source_message_id.clone(),
        created_at: entry.created_at,
        updated_at: entry.updated_at,
    })
    .map_err(|e| e.to_string())?;
    Ok(format!(
        "<!-- gouan-memory-v{MEMORY_VERSION}: {meta} -->\n\n# {}\n\n{}\n",
        entry.title,
        entry.content.trim()
    ))
}

fn parse_entry(path: &Path) -> Result<MemoryEntry, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("读取记忆文件失败: {e}"))?;
    let first = raw.lines().next().unwrap_or_default();
    let prefix = format!("<!-- gouan-memory-v{MEMORY_VERSION}: ");
    let json = first
        .strip_prefix(&prefix)
        .and_then(|line| line.strip_suffix(" -->"))
        .ok_or_else(|| format!("无效的记忆文件: {}", path.display()))?;
    let meta: MemoryFileMeta =
        serde_json::from_str(json).map_err(|e| format!("解析记忆元数据失败: {e}"))?;
    let mut lines = raw.lines().skip(1);
    while lines.next().is_some_and(|line| line.trim().is_empty()) {}
    let content = lines
        .skip_while(|line| line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    Ok(MemoryEntry {
        id: meta.id,
        memory_type: meta.memory_type,
        title: meta.title,
        content,
        confidence: meta.confidence,
        status: meta.status,
        source_conversation_id: meta.source_conversation_id,
        source_message_id: meta.source_message_id,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
    })
}

fn collect_markdown(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for item in fs::read_dir(dir).map_err(|e| format!("扫描记忆目录失败: {e}"))? {
        let path = item.map_err(|e| e.to_string())?.path();
        if path.is_dir() {
            if path.file_name().and_then(|v| v.to_str()) != Some(".trash") {
                collect_markdown(&path, out)?;
            }
        } else if path.extension().and_then(|v| v.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn reconcile(workspace: &WorkspacePaths) -> Result<Vec<MemoryEntry>, String> {
    let root = memory_root(workspace)?;
    let mut paths = Vec::new();
    collect_markdown(&root, &mut paths)?;
    let mut entries = Vec::new();
    let db = memory_db(workspace)?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM agent_memory_fts", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM agent_memory", [])
        .map_err(|e| e.to_string())?;
    for path in paths {
        let Ok(entry) = parse_entry(&path) else {
            continue;
        };
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        tx.execute("INSERT INTO agent_memory(id,memory_type,title,content,confidence,status,source_conversation_id,source_message_id,created_at,updated_at,path) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", params![entry.id,entry.memory_type,entry.title,entry.content,entry.confidence,entry.status,entry.source_conversation_id,entry.source_message_id,entry.created_at,entry.updated_at,relative]).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO agent_memory_fts(id,title,content) VALUES(?1,?2,?3)",
            params![entry.id, entry.title, entry.content],
        )
        .map_err(|e| e.to_string())?;
        entries.push(entry);
    }
    tx.commit().map_err(|e| e.to_string())?;
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

fn find_entry(workspace: &WorkspacePaths, id: &str) -> Result<MemoryEntry, String> {
    reconcile(workspace)?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("找不到记忆: {id}"))
}

fn write_entry(
    workspace: &WorkspacePaths,
    input: MemoryWriteInput,
    actor: &str,
) -> Result<MemoryEntry, String> {
    let memory_type = validate_type(&input.memory_type)?;
    let title = input.title.trim();
    let content = input.content.trim();
    if title.is_empty() || content.is_empty() {
        return Err("记忆标题和内容不能为空".into());
    }
    if content.len() > 16 * 1024 {
        return Err("单条记忆不能超过 16KB".into());
    }
    let existing = input
        .id
        .as_deref()
        .and_then(|id| find_entry(workspace, id).ok());
    let now = now_ms();
    let entry = MemoryEntry {
        id: match input.id {
            Some(id) => validate_id(&id)?,
            None => make_id(&format!("{title}:{content}")),
        },
        memory_type: memory_type.clone(),
        title: title.to_string(),
        content: content.to_string(),
        confidence: input
            .confidence
            .filter(|v| v == "inferred")
            .unwrap_or_else(|| "confirmed".into()),
        status: validate_status(input.status.as_deref().unwrap_or("pending_review"))?,
        source_conversation_id: input.source_conversation_id,
        source_message_id: input.source_message_id,
        created_at: existing.as_ref().map(|v| v.created_at).unwrap_or(now),
        updated_at: now,
    };
    let root = memory_root(workspace)?;
    if let Some(old) = existing.as_ref() {
        for kind in VALID_TYPES {
            let old_path = root.join(kind).join(format!("{}.md", old.id));
            if old_path.exists() {
                let _ = fs::remove_file(old_path);
            }
        }
    }
    let path = root.join(&memory_type).join(format!("{}.md", entry.id));
    fs::write(&path, render_entry(&entry)?).map_err(|e| format!("写入记忆失败: {e}"))?;
    reconcile(workspace)?;
    let db = memory_db(workspace)?;
    db.execute("INSERT INTO agent_memory_audit(memory_id,operation,actor,detail,created_at) VALUES(?1,?2,?3,?4,?5)", params![entry.id, if existing.is_some(){"update"}else{"write"}, actor, entry.title, now]).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
pub fn memory_list(
    workspace: WorkspacePaths,
    include_pending: Option<bool>,
) -> Result<Vec<MemoryEntry>, String> {
    let include_pending = include_pending.unwrap_or(true);
    Ok(reconcile(&workspace)?
        .into_iter()
        .filter(|entry| entry.status != "archived" && (include_pending || entry.status == "active"))
        .collect())
}

#[tauri::command]
pub fn memory_read(workspace: WorkspacePaths, id: String) -> Result<MemoryEntry, String> {
    find_entry(&workspace, &id)
}

#[tauri::command]
pub fn memory_search(
    workspace: WorkspacePaths,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    reconcile(&workspace)?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let db = memory_db(&workspace)?;
    let fts = format!("\"{}\"", query.replace('"', "\"\""));
    let mut stmt = db.prepare("SELECT m.id,m.memory_type,m.title,m.content,m.confidence,m.status,m.source_conversation_id,m.source_message_id,m.created_at,m.updated_at FROM agent_memory_fts f JOIN agent_memory m ON m.id=f.id WHERE agent_memory_fts MATCH ?1 AND m.status='active' ORDER BY bm25(agent_memory_fts),m.updated_at DESC LIMIT ?2").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![fts, limit.unwrap_or(8).clamp(1, 32) as i64],
            |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    memory_type: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    confidence: row.get(4)?,
                    status: row.get(5)?,
                    source_conversation_id: row.get(6)?,
                    source_message_id: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let found = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if !found.is_empty() {
        return Ok(found);
    }
    let like = format!("%{query}%");
    let mut fallback = db.prepare("SELECT id,memory_type,title,content,confidence,status,source_conversation_id,source_message_id,created_at,updated_at FROM agent_memory WHERE status='active' AND (title LIKE ?1 OR content LIKE ?1) ORDER BY updated_at DESC LIMIT ?2").map_err(|e| e.to_string())?;
    let rows = fallback
        .query_map(
            params![like, limit.unwrap_or(8).clamp(1, 32) as i64],
            |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    memory_type: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    confidence: row.get(4)?,
                    status: row.get(5)?,
                    source_conversation_id: row.get(6)?,
                    source_message_id: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_write(
    workspace: WorkspacePaths,
    input: MemoryWriteInput,
) -> Result<MemoryEntry, String> {
    write_entry(&workspace, input, "user")
}

#[tauri::command]
pub fn memory_propose(
    workspace: WorkspacePaths,
    input: MemoryWriteInput,
) -> Result<MemoryEntry, String> {
    write_entry(
        &workspace,
        MemoryWriteInput {
            status: Some("pending_review".into()),
            confidence: Some("inferred".into()),
            ..input
        },
        "agent",
    )
}

#[tauri::command]
pub fn memory_accept(workspace: WorkspacePaths, id: String) -> Result<MemoryEntry, String> {
    let old = find_entry(&workspace, &id)?;
    write_entry(
        &workspace,
        MemoryWriteInput {
            id: Some(old.id),
            memory_type: old.memory_type,
            title: old.title,
            content: old.content,
            confidence: Some("confirmed".into()),
            status: Some("active".into()),
            source_conversation_id: old.source_conversation_id,
            source_message_id: old.source_message_id,
        },
        "user",
    )
}

#[tauri::command]
pub fn memory_delete(workspace: WorkspacePaths, id: String) -> Result<(), String> {
    let entry = find_entry(&workspace, &id)?;
    let root = memory_root(&workspace)?;
    let source = root
        .join(&entry.memory_type)
        .join(format!("{}.md", entry.id));
    if source.exists() {
        fs::rename(
            &source,
            root.join(".trash")
                .join(format!("{}-{}.md", now_ms(), entry.id)),
        )
        .map_err(|e| format!("归档记忆失败: {e}"))?;
    }
    reconcile(&workspace)?;
    memory_db(&workspace)?.execute("INSERT INTO agent_memory_audit(memory_id,operation,actor,detail,created_at) VALUES(?1,'delete','user',?2,?3)", params![entry.id,entry.title,now_ms()]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn memory_rebuild(workspace: WorkspacePaths) -> Result<Vec<MemoryEntry>, String> {
    reconcile(&workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> (WorkspacePaths, PathBuf) {
        let root = std::env::temp_dir().join(format!("gouan-memory-{}", now_ms()));
        fs::create_dir_all(&root).unwrap();
        (
            WorkspacePaths {
                root: root.to_string_lossy().into(),
                history_dir: String::new(),
            },
            root,
        )
    }
    #[test]
    fn persists_searches_and_archives_memory() {
        let (workspace, root) = workspace();
        let saved = memory_write(
            workspace.clone(),
            MemoryWriteInput {
                id: None,
                memory_type: "decision".into(),
                title: "部署平台".into(),
                content: "使用 Windows Server 2022".into(),
                confidence: None,
                status: Some("active".into()),
                source_conversation_id: None,
                source_message_id: None,
            },
        )
        .unwrap();
        assert_eq!(
            memory_search(workspace.clone(), "Windows Server".into(), None)
                .unwrap()
                .len(),
            1
        );
        let path = root
            .join(".gouan/memory/decision")
            .join(format!("{}.md", saved.id));
        assert!(path.exists());
        let raw = fs::read_to_string(&path)
            .unwrap()
            .replace("Windows Server 2022", "Windows Server 2025");
        fs::write(&path, raw).unwrap();
        assert_eq!(
            memory_rebuild(workspace.clone()).unwrap()[0].content,
            "使用 Windows Server 2025"
        );
        assert_eq!(
            memory_search(workspace.clone(), "Server 2025".into(), None)
                .unwrap()
                .len(),
            1
        );
        memory_delete(workspace.clone(), saved.id).unwrap();
        assert!(memory_list(workspace, false.into()).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
