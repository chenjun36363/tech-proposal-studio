mod indexing;
pub(super) use indexing::index_document;
mod queries;
pub(super) use queries::*;

use super::parser::segmented;
use super::{stable_id, WorkspacePaths};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) fn normalized_location(value: &str) -> String {
    #[cfg(windows)]
    {
        let path = value.replace('/', "\\");
        let path = if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{rest}")
        } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
            rest.to_string()
        } else {
            path
        };
        path.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.to_string()
    }
}

pub(super) fn find_document_by_location(
    db: &Connection,
    location: &str,
) -> Result<Option<(String, String)>, String> {
    if let Some(found) = db
        .query_row(
            "SELECT id,fingerprint FROM knowledge_documents WHERE location=?1",
            [location],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(Some(found));
    }

    let wanted = normalized_location(location);
    let mut stmt = db
        .prepare("SELECT id,location,fingerprint FROM knowledge_documents")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, stored_location, fingerprint) = row.map_err(|e| e.to_string())?;
        if normalized_location(&stored_location) == wanted {
            return Ok(Some((id, fingerprint)));
        }
    }
    Ok(None)
}

pub(super) fn document_id_for_location(db: &Connection, location: &str) -> Result<String, String> {
    Ok(find_document_by_location(db, location)?
        .map(|(id, _)| id)
        .unwrap_or_else(|| stable_id("kd", &normalized_location(location))))
}

pub(super) fn knowledge_db(workspace: &WorkspacePaths) -> Result<Connection, String> {
    if workspace.root.trim().is_empty() {
        return Err("请先配置工作目录".into());
    }
    let dir = PathBuf::from(&workspace.root).join(".gouan");
    fs::create_dir_all(&dir).map_err(|e| format!("创建知识库目录失败: {e}"))?;
    let db = Connection::open(dir.join("knowledge.db")).map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS knowledge_documents(
           id TEXT PRIMARY KEY, source_type TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL UNIQUE,
           source_url TEXT, fingerprint TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
           section_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
           structure_status TEXT NOT NULL DEFAULT 'indexed', original_fingerprint TEXT, normalized_fingerprint TEXT,
           chunking_version INTEGER NOT NULL DEFAULT 1
         );
         CREATE TABLE IF NOT EXISTS knowledge_sections(
           id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
           parent_id TEXT, title TEXT NOT NULL, heading_path TEXT NOT NULL, level INTEGER NOT NULL,
           position INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '', chunk_count INTEGER NOT NULL DEFAULT 0,
           heading_source TEXT NOT NULL DEFAULT 'markdown', original_line INTEGER, confidence REAL NOT NULL DEFAULT 1.0
         );
         CREATE TABLE IF NOT EXISTS knowledge_chunks(
           id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
           section_id TEXT NOT NULL REFERENCES knowledge_sections(id) ON DELETE CASCADE,
           heading_path TEXT NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL,
           summary TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL,
           start_char INTEGER NOT NULL, end_char INTEGER NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
           quality TEXT NOT NULL DEFAULT 'normal'
         );
         CREATE TABLE IF NOT EXISTS knowledge_chunk_sections(
           chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
           section_id TEXT NOT NULL REFERENCES knowledge_sections(id) ON DELETE CASCADE,
           PRIMARY KEY(chunk_id, section_id)
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5(
           chunk_id UNINDEXED, document_title, title_path, body, tokenize='unicode61'
         );",
    )
    .map_err(|e| e.to_string())?;
    for migration in [
        "ALTER TABLE knowledge_documents ADD COLUMN structure_status TEXT NOT NULL DEFAULT 'indexed'",
        "ALTER TABLE knowledge_documents ADD COLUMN original_fingerprint TEXT",
        "ALTER TABLE knowledge_documents ADD COLUMN normalized_fingerprint TEXT",
        "ALTER TABLE knowledge_documents ADD COLUMN chunking_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE knowledge_sections ADD COLUMN heading_source TEXT NOT NULL DEFAULT 'markdown'",
        "ALTER TABLE knowledge_sections ADD COLUMN original_line INTEGER",
        "ALTER TABLE knowledge_sections ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0",
        "ALTER TABLE knowledge_chunks ADD COLUMN quality TEXT NOT NULL DEFAULT 'normal'",
    ] {
        let _ = db.execute(migration, []);
    }
    db.execute(
        "INSERT OR IGNORE INTO knowledge_chunk_sections(chunk_id,section_id) SELECT id,section_id FROM knowledge_chunks",
        [],
    )
    .map_err(|e| e.to_string())?;
    reconcile_knowledge_locations(&db, workspace)?;
    ensure_knowledge_fts(&db)?;
    db.execute(
        "UPDATE knowledge_documents SET status='ready',error=NULL WHERE status!='ready' OR error IS NOT NULL",
        [],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE knowledge_chunks SET status='ready' WHERE status!='ready'",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(db)
}

pub(super) fn resolve_workspace_path(workspace: &WorkspacePaths, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        value
            .split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .fold(PathBuf::from(&workspace.root), |path, part| path.join(part))
    }
}

pub(super) fn storage_location(workspace: &WorkspacePaths, value: &str) -> String {
    let path = resolve_workspace_path(workspace, value);
    workspace_relative_location(workspace, &path).unwrap_or_else(|| value.to_string())
}

fn workspace_relative_location(workspace: &WorkspacePaths, path: &Path) -> Option<String> {
    let root = fs::canonicalize(&workspace.root).ok()?;
    let target = fs::canonicalize(path).ok()?;
    let relative = target.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn reconcile_knowledge_locations(
    db: &Connection,
    workspace: &WorkspacePaths,
) -> Result<(), String> {
    let rows: Vec<(String, String)> = {
        let mut stmt = db
            .prepare("SELECT id,location FROM knowledge_documents")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        result
    };
    for (id, location) in rows {
        let resolved = resolve_workspace_path(workspace, &location);
        let candidate = if resolved.is_file() {
            resolved
        } else {
            let normalized = location.replace('/', "\\");
            let lower = normalized.to_lowercase();
            let relative = if let Some(relative) = lower.strip_prefix("history\\") {
                &normalized[normalized.len() - relative.len()..]
            } else if let Some(marker) = lower.rfind("\\history\\") {
                &normalized[marker + "\\history\\".len()..]
            } else {
                continue;
            };
            relative
                .split('\\')
                .filter(|part| !part.is_empty())
                .fold(PathBuf::from(&workspace.history_dir), |path, part| {
                    path.join(part)
                })
        };
        if !candidate.is_file() {
            continue;
        }
        let Some(current) = workspace_relative_location(workspace, &candidate) else {
            continue;
        };
        if current != location {
            db.execute(
                "UPDATE knowledge_documents SET location=?2 WHERE id=?1",
                params![id, current],
            )
            .map_err(|e| format!("迁移知识文档路径失败: {e}"))?;
        }
    }
    Ok(())
}

fn ensure_knowledge_fts(db: &Connection) -> Result<(), String> {
    let columns: Vec<String> = {
        let mut stmt = db
            .prepare("PRAGMA table_info(knowledge_chunk_fts)")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_map([], |row| row.get(1))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        result
    };
    let expected = ["chunk_id", "document_title", "title_path", "body"];
    if columns.iter().map(String::as_str).eq(expected) {
        return Ok(());
    }

    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = db
            .prepare(
                "SELECT c.id,d.title,c.heading_path,c.content
                 FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id",
            )
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        result
    };
    db.execute_batch(
        "DROP TABLE knowledge_chunk_fts;
         CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(
           chunk_id UNINDEXED, document_title, title_path, body, tokenize='unicode61'
         );",
    )
    .map_err(|e| e.to_string())?;
    for (id, document_title, title_path, body) in rows {
        db.execute(
            "INSERT INTO knowledge_chunk_fts(chunk_id,document_title,title_path,body) VALUES(?1,?2,?3,?4)",
            params![
                id,
                segmented(&document_title),
                segmented(&title_path),
                segmented(&body)
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
