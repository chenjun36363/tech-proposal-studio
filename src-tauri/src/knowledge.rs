use crate::{load_secret, ModelConfig, WorkspacePaths};
use jieba_rs::Jieba;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, sync::OnceLock, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};

const MAX_CHUNK_CHARS: usize = 6000;
const CHUNKING_VERSION: i64 = 3;
const MAX_WEB_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    id: String,
    source_type: String,
    title: String,
    location: String,
    source_url: Option<String>,
    fingerprint: String,
    status: String,
    error: Option<String>,
    section_count: i64,
    chunk_count: i64,
    updated_at: String,
    structure_status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSection {
    id: String,
    document_id: String,
    parent_id: Option<String>,
    title: String,
    heading_path: String,
    level: i64,
    position: i64,
    chunk_count: i64,
    heading_source: String,
    original_line: Option<i64>,
    confidence: f64,
    quality: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingCandidate {
    id: String,
    line: usize,
    text: String,
    original: String,
    level: usize,
    selected: bool,
    confidence: f64,
    source: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingDetectionResult {
    document_id: String,
    title: String,
    path: String,
    candidates: Vec<HeadingCandidate>,
    toc_start: Option<usize>,
    toc_end: Option<usize>,
    model_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingReviewDecision {
    id: String,
    line: usize,
    selected: bool,
    level: usize,
    source: String,
    confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBackup {
    name: String,
    path: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    id: String,
    document_id: String,
    section_id: String,
    document_title: String,
    heading_path: String,
    content: String,
    position: i64,
    start_char: i64,
    end_char: i64,
    status: String,
    quality: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    chunk: KnowledgeChunk,
    excerpt: String,
    score: f64,
    matched_section_id: String,
    scope_section_id: String,
    level: i64,
    parent_id: Option<String>,
    can_move_up: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSectionScope {
    id: String,
    document_id: String,
    document_title: String,
    section_id: String,
    parent_id: Option<String>,
    title: String,
    heading_path: String,
    level: i64,
    content: String,
    section_count: i64,
    quality: String,
    can_move_up: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeScanItem {
    path: String,
    title: String,
    state: String,
    document_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeProgress {
    document_id: String,
    stage: String,
    current: usize,
    total: usize,
    message: String,
}

#[derive(Debug, Clone)]
struct ParsedSection {
    id: String,
    parent_id: Option<String>,
    title: String,
    path: String,
    level: usize,
    position: usize,
    body: String,
}

#[derive(Debug, Clone)]
struct ParsedChunk {
    id: String,
    section_id: String,
    heading_path: String,
    content: String,
    position: usize,
    start_char: usize,
    end_char: usize,
    section_ids: Vec<String>,
}

fn now_string() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string()
}

fn hash_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn stable_id(prefix: &str, value: &str) -> String {
    format!("{prefix}-{}", &hash_text(value)[..24])
}

fn normalized_location(value: &str) -> String {
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

fn find_document_by_location(db: &Connection, location: &str) -> Result<Option<(String, String)>, String> {
    if let Some(found) = db.query_row(
        "SELECT id,fingerprint FROM knowledge_documents WHERE location=?1",
        [location],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| e.to_string())? {
        return Ok(Some(found));
    }
    let wanted = normalized_location(location);
    let mut stmt = db.prepare("SELECT id,location,fingerprint FROM knowledge_documents").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
    for row in rows {
        let (id, stored_location, fingerprint) = row.map_err(|e| e.to_string())?;
        if normalized_location(&stored_location) == wanted { return Ok(Some((id, fingerprint))); }
    }
    Ok(None)
}

fn document_id_for_location(db: &Connection, location: &str) -> Result<String, String> {
    Ok(find_document_by_location(db, location)?
        .map(|(id, _)| id)
        .unwrap_or_else(|| stable_id("kd", &normalized_location(location))))
}

fn knowledge_db(workspace: &WorkspacePaths) -> Result<Connection, String> {
    if workspace.root.trim().is_empty() { return Err("请先配置工作目录".into()); }
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
         );"
    ).map_err(|e| e.to_string())?;
    for migration in [
        "ALTER TABLE knowledge_documents ADD COLUMN structure_status TEXT NOT NULL DEFAULT 'indexed'",
        "ALTER TABLE knowledge_documents ADD COLUMN original_fingerprint TEXT",
        "ALTER TABLE knowledge_documents ADD COLUMN normalized_fingerprint TEXT",
        "ALTER TABLE knowledge_documents ADD COLUMN chunking_version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE knowledge_sections ADD COLUMN heading_source TEXT NOT NULL DEFAULT 'markdown'",
        "ALTER TABLE knowledge_sections ADD COLUMN original_line INTEGER",
        "ALTER TABLE knowledge_sections ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0",
        "ALTER TABLE knowledge_chunks ADD COLUMN quality TEXT NOT NULL DEFAULT 'normal'",
    ] { let _ = db.execute(migration, []); }
    db.execute("INSERT OR IGNORE INTO knowledge_chunk_sections(chunk_id,section_id) SELECT id,section_id FROM knowledge_chunks",[]).map_err(|e|e.to_string())?;
    reconcile_knowledge_locations(&db, workspace)?;
    ensure_knowledge_fts(&db)?;
    db.execute("UPDATE knowledge_documents SET status='ready',error=NULL WHERE status!='ready' OR error IS NOT NULL",[]).map_err(|e|e.to_string())?;
    db.execute("UPDATE knowledge_chunks SET status='ready' WHERE status!='ready'",[]).map_err(|e|e.to_string())?;
    Ok(db)
}

fn resolve_workspace_path(workspace: &WorkspacePaths, value: &str) -> PathBuf {
    let path=PathBuf::from(value);
    if path.is_absolute() { path } else {
        value.split(['/', '\\']).filter(|part|!part.is_empty()).fold(PathBuf::from(&workspace.root),|path,part|path.join(part))
    }
}

fn workspace_relative_location(workspace: &WorkspacePaths, path: &Path) -> Option<String> {
    let root=fs::canonicalize(&workspace.root).ok()?;
    let target=fs::canonicalize(path).ok()?;
    let relative=target.strip_prefix(root).ok()?;
    Some(relative.components().map(|part|part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"))
}

fn storage_location(workspace: &WorkspacePaths, value: &str) -> String {
    let path=resolve_workspace_path(workspace,value);
    workspace_relative_location(workspace,&path).unwrap_or_else(||value.to_string())
}

fn reconcile_knowledge_locations(db: &Connection, workspace: &WorkspacePaths) -> Result<(), String> {
    let rows: Vec<(String, String)> = {
        let mut stmt=db.prepare("SELECT id,location FROM knowledge_documents").map_err(|e|e.to_string())?;
        let result=stmt.query_map([],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
        result
    };
    for (id, location) in rows {
        let resolved=resolve_workspace_path(workspace,&location);
        let candidate=if resolved.is_file(){resolved}else{
            let normalized=location.replace('/', "\\");let lower=normalized.to_lowercase();
            let Some(marker)=lower.rfind("\\history\\") else { continue };
            let relative=&normalized[marker + "\\history\\".len()..];
            relative.split('\\').filter(|part|!part.is_empty()).fold(PathBuf::from(&workspace.history_dir),|path,part|path.join(part))
        };
        if !candidate.is_file() { continue; }
        let Some(current)=workspace_relative_location(workspace,&candidate) else { continue };
        if current!=location { db.execute("UPDATE knowledge_documents SET location=?2 WHERE id=?1",params![id,current]).map_err(|e|format!("迁移知识文档路径失败: {e}"))?; }
    }
    Ok(())
}

fn ensure_knowledge_fts(db: &Connection) -> Result<(), String> {
    let columns: Vec<String> = {
        let mut stmt = db.prepare("PRAGMA table_info(knowledge_chunk_fts)").map_err(|e| e.to_string())?;
        let result=stmt.query_map([], |row| row.get(1)).map_err(|e| e.to_string())?
            .collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        result
    };
    let expected = ["chunk_id", "document_title", "title_path", "body"];
    if columns.iter().map(String::as_str).eq(expected) { return Ok(()); }

    let rows: Vec<(String, String, String, String)> = {
        let mut stmt = db.prepare(
            "SELECT c.id,d.title,c.heading_path,c.content
             FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id"
        ).map_err(|e| e.to_string())?;
        let result=stmt.query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
            .map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        result
    };
    db.execute_batch(
        "DROP TABLE knowledge_chunk_fts;
         CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(
           chunk_id UNINDEXED, document_title, title_path, body, tokenize='unicode61'
         );"
    ).map_err(|e| e.to_string())?;
    for (id, document_title, title_path, body) in rows {
        db.execute(
            "INSERT INTO knowledge_chunk_fts(chunk_id,document_title,title_path,body) VALUES(?1,?2,?3,?4)",
            params![id,segmented(&document_title),segmented(&title_path),segmented(&body)]
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn markdown_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let count = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&count) { return None; }
    let rest = &trimmed[count..];
    if !rest.starts_with(char::is_whitespace) { return None; }
    Some((count, rest.trim().trim_end_matches('#').trim().to_string()))
}

fn parse_sections(document_id: &str, title: &str, markdown: &str) -> Vec<ParsedSection> {
    let mut sections = Vec::new();
    let mut stack: Vec<(usize, String, String)> = Vec::new();
    let mut current_title = title.to_string();
    let mut current_level = 0usize;
    let mut current_parent = None;
    let mut current_path = title.to_string();
    let mut body = String::new();
    let mut in_fence = false;
    let mut in_toc = false;
    let flush = |sections: &mut Vec<ParsedSection>, body: &mut String, current_title: &str, current_path: &str, current_level: usize, current_parent: &Option<String>| {
        if !body.trim().is_empty() || current_level > 0 {
            let position = sections.len();
            let id = stable_id("ks", &format!("{document_id}:{position}:{current_path}"));
            sections.push(ParsedSection { id, parent_id: current_parent.clone(), title: current_title.to_string(), path: current_path.to_string(), level: current_level, position, body: body.trim().to_string() });
        }
        body.clear();
    };
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed == "<!-- knowledge-toc:start -->" { in_toc = true; continue; }
        if trimmed == "<!-- knowledge-toc:end -->" { in_toc = false; continue; }
        if in_toc { continue; }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") { in_fence = !in_fence; }
        if !in_fence {
            if let Some((level, heading)) = markdown_heading(line) {
                flush(&mut sections, &mut body, &current_title, &current_path, current_level, &current_parent);
                while stack.last().is_some_and(|(old, _, _)| *old >= level) { stack.pop(); }
                current_parent = stack.last().map(|(_, id, _)| id.clone());
                let mut paths: Vec<String> = stack.iter().map(|(_, _, name)| name.clone()).collect();
                paths.push(heading.clone());
                current_path = paths.join(" > ");
                current_title = heading;
                current_level = level;
                let future_id = stable_id("ks", &format!("{document_id}:{}:{current_path}", sections.len()));
                stack.push((level, future_id, current_title.clone()));
                continue;
            }
        }
        body.push_str(line);
        body.push('\n');
    }
    flush(&mut sections, &mut body, &current_title, &current_path, current_level, &current_parent);
    if sections.is_empty() {
        sections.push(ParsedSection { id: stable_id("ks", &format!("{document_id}:0:{title}")), parent_id: None, title: title.to_string(), path: title.to_string(), level: 0, position: 0, body: String::new() });
    }
    sections
}

fn build_document_chunks(document_id:&str,sections:&[ParsedSection])->Vec<ParsedChunk>{
    let mut start_char=0usize;
    sections.iter().enumerate().map(|(position,section)|{
        let content=section.body.trim().to_string();
        let end_char=start_char+content.chars().count();
        let chunk=ParsedChunk{id:stable_id("kc",&format!("{document_id}:{}",section.id)),section_id:section.id.clone(),heading_path:section.path.clone(),content,position,start_char,end_char,section_ids:vec![section.id.clone()]};
        start_char=end_char;
        chunk
    }).collect()
}

fn segmented(value: &str) -> String {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    JIEBA.get_or_init(Jieba::new).cut(value, false).join(" ")
}

fn emit_progress(app: &AppHandle, document_id: &str, stage: &str, current: usize, total: usize, message: &str) {
    let _ = app.emit("knowledge://progress", KnowledgeProgress { document_id: document_id.into(), stage: stage.into(), current, total, message: message.into() });
}

fn store_document(workspace: &WorkspacePaths, source_type: &str, location: &str, source_url: Option<&str>, title: &str, markdown: &str) -> Result<KnowledgeDocument, String> {
    store_document_with_progress(workspace,source_type,location,source_url,title,markdown,None)
}

fn store_document_with_progress(workspace: &WorkspacePaths, source_type: &str, location: &str, source_url: Option<&str>, title: &str, markdown: &str, app: Option<&AppHandle>) -> Result<KnowledgeDocument, String> {
    let mut db = knowledge_db(workspace)?;
    let fingerprint = hash_text(markdown);
    let location=storage_location(workspace,location);
    let id = document_id_for_location(&db, &location)?;
    if let Some(existing) = load_document(&db, &id)? {
        let version:i64=db.query_row("SELECT chunking_version FROM knowledge_documents WHERE id=?1",[&id],|r|r.get(0)).unwrap_or(1);
        if existing.fingerprint == fingerprint && version >= CHUNKING_VERSION { if let Some(app)=app{emit_progress(app,&id,"index_unchanged",1,1,"内容没有变化，现有索引仍然有效");}return Ok(existing); }
    }
    if let Some(app)=app{emit_progress(app,&id,"index_parsing",0,0,"正在解析 Markdown 章节…");}
    let sections = parse_sections(&id, title, markdown);
    if let Some(app)=app{emit_progress(app,&id,"index_chunking",0,0,&format!("正在根据 {} 个章节生成知识切片…",sections.len()));}
    let chunks = build_document_chunks(&id, &sections);
    let existing_quality: BTreeMap<String, String> = {
        let mut stmt = db.prepare("SELECT id,quality FROM knowledge_chunks WHERE document_id=?1").map_err(|e|e.to_string())?;
        let result=stmt.query_map([&id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
        result
    };
    if let Some(app)=app{emit_progress(app,&id,"index_writing",0,chunks.len(),&format!("正在写入 {} 个知识切片…",chunks.len()));}
    let segmented_title = segmented(title);
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_chunk_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?1)", [&id]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO knowledge_documents(id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,chunking_version)
      VALUES(?1,?2,?3,?4,?5,?6,'ready',NULL,?7,?8,?9,?10)
      ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,title=excluded.title,location=excluded.location,source_url=excluded.source_url,fingerprint=excluded.fingerprint,status=excluded.status,error=NULL,section_count=excluded.section_count,chunk_count=excluded.chunk_count,updated_at=excluded.updated_at,chunking_version=excluded.chunking_version",
      params![id, source_type, title, location, source_url, fingerprint, sections.len() as i64, chunks.len() as i64, now_string(),CHUNKING_VERSION]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_sections WHERE document_id=?1", [&id]).map_err(|e| e.to_string())?;
    for section in &sections {
        let count = chunks.iter().filter(|c| c.section_ids.contains(&section.id)).count();
        tx.execute("INSERT INTO knowledge_sections(id,document_id,parent_id,title,heading_path,level,position,summary,chunk_count) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8)", params![section.id,id,section.parent_id,section.title,section.path,section.level as i64,section.position as i64,count as i64]).map_err(|e| e.to_string())?;
    }
    for (chunk_index,chunk) in chunks.iter().enumerate() {
        let search_text = segmented(&format!("{} {}", chunk.heading_path, chunk.content));
        let quality=existing_quality.get(&chunk.id).map(String::as_str).unwrap_or("normal");
        tx.execute("INSERT INTO knowledge_chunks(id,document_id,section_id,heading_path,content,search_text,position,start_char,end_char,fingerprint,status,quality) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'ready',?11)", params![chunk.id,id,chunk.section_id,chunk.heading_path,chunk.content,search_text,chunk.position as i64,chunk.start_char as i64,chunk.end_char as i64,hash_text(&chunk.content),quality]).map_err(|e| e.to_string())?;
        for section_id in &chunk.section_ids { tx.execute("INSERT INTO knowledge_chunk_sections(chunk_id,section_id) VALUES(?1,?2)",params![chunk.id,section_id]).map_err(|e|e.to_string())?; }
        tx.execute("INSERT INTO knowledge_chunk_fts(chunk_id,document_title,title_path,body) VALUES(?1,?2,?3,?4)", params![chunk.id,segmented_title,segmented(&chunk.heading_path),segmented(&chunk.content)]).map_err(|e| e.to_string())?;
        if let Some(app)=app{if chunk_index%10==9||chunk_index+1==chunks.len(){emit_progress(app,&id,"index_writing",chunk_index+1,chunks.len(),&format!("正在写入知识切片 {}/{}…",chunk_index+1,chunks.len()));}}
    }
    tx.commit().map_err(|e| e.to_string())?;
    if source_type == "markdown" && sections.len() <= 1 && markdown.chars().count() > MAX_CHUNK_CHARS {
        db.execute("UPDATE knowledge_documents SET structure_status='review_recommended' WHERE id=?1 AND structure_status!='confirmed'", [&id]).map_err(|e|e.to_string())?;
    }
    load_document(&db, &id)?.ok_or_else(|| "知识文档写入失败".into())
}

fn load_document(db: &Connection, id: &str) -> Result<Option<KnowledgeDocument>, String> {
    db.query_row("SELECT id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,structure_status FROM knowledge_documents WHERE id=?1", [id], |r| Ok(KnowledgeDocument { id:r.get(0)?, source_type:r.get(1)?, title:r.get(2)?, location:r.get(3)?, source_url:r.get(4)?, fingerprint:r.get(5)?, status:r.get(6)?, error:r.get(7)?, section_count:r.get(8)?, chunk_count:r.get(9)?, updated_at:r.get(10)?, structure_status:r.get(11)? })).optional().map_err(|e| e.to_string())
}

fn safe_markdown_name(title:&str)->String{
    let invalid=['<','>',':','\"','/','\\','|','?','*'];
    let cleaned:String=title.chars().map(|c|if invalid.contains(&c){'_'}else{c}).collect();
    let stem=cleaned.trim().trim_end_matches(".markdown").trim_end_matches(".md");
    format!("{}.md",if stem.is_empty(){"知识文档"}else{stem})
}

fn unique_destination(dir:&Path,file_name:&str)->PathBuf{
    let initial=dir.join(file_name); if !initial.exists(){return initial;}
    let stem=Path::new(file_name).file_stem().and_then(|x|x.to_str()).unwrap_or("知识文档");
    for n in 1.. { let p=dir.join(format!("{stem} ({n}).md"));if !p.exists(){return p;} }
    unreachable!()
}

fn normalized_heading_text(value: &str) -> String {
    let mut text = value.replace(['\u{00a0}', '\u{3000}', '\u{200b}', '\u{feff}'], " ");
    text = text.trim().trim_start_matches('#').trim().to_string();
    text = text.replace("**", "").replace("__", "");
    if let Some(caps) = Regex::new(r"^\[([^]]+)\]\(#_Toc[^)]*\)$").unwrap().captures(text.trim()) {
        text = caps[1].to_string();
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ").trim_matches(|c: char| c == '#' || c.is_whitespace()).to_string()
}

fn inferred_level(text: &str) -> Option<usize> {
    let cleaned = normalized_heading_text(text);
    let chapter = Regex::new(r"^第(?:[0-9]+|[一二三四五六七八九十百零〇两]+)章").unwrap();
    if chapter.is_match(&cleaned) { return Some(1); }
    let decimal = Regex::new(r"^(?:[0-9]+|[一二三四五六七八九十百零〇两]+)(?:[.．][0-9]+)+").unwrap();
    decimal.find(&cleaned).map(|m| (m.as_str().matches(['.', '．']).count() + 1).min(6))
}

fn candidate(id_seed: &str, line: usize, original: &str, level: usize, selected: bool, confidence: f64, source: &str, reason: &str) -> HeadingCandidate {
    HeadingCandidate { id: stable_id("hc", &format!("{id_seed}:{line}")), line, text: normalized_heading_text(original), original: original.to_string(), level, selected, confidence, source: source.into(), reason: reason.into() }
}

fn detect_heading_candidates(document_id: &str, markdown: &str) -> (Vec<HeadingCandidate>, Option<usize>, Option<usize>) {
    let lines: Vec<&str> = markdown.lines().collect();
    let toc_re = Regex::new(r"^\s*\[([^]]+)\]\(#_Toc[^)]*\)\s*$").unwrap();
    let toc_entries: Vec<(usize, String, usize)> = lines.iter().take(500).enumerate().filter_map(|(i, line)| {
        let caps = toc_re.captures(line)?;
        let title = normalized_heading_text(&caps[1]);
        inferred_level(&title).map(|level| (i, title, level))
    }).collect();
    let (toc_start, toc_end) = if toc_entries.len() >= 3 {
        let first=toc_entries.first().map(|x|x.0).unwrap_or(0);let label=(first.saturating_sub(8)..first).rev().find(|i|normalized_heading_text(lines[*i]).replace(' ',"")=="目录");
        (Some(label.unwrap_or(first)),toc_entries.last().map(|x|x.0))
    } else { (None, None) };
    let mut by_line: BTreeMap<usize, HeadingCandidate> = BTreeMap::new();
    let mut in_fence = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") { in_fence = !in_fence; continue; }
        if in_fence || toc_start.zip(toc_end).is_some_and(|(start,end)| index >= start && index <= end) || trimmed.starts_with('|') || trimmed.starts_with('[') { continue; }
        if let Some((level, _)) = markdown_heading(line) {
            by_line.insert(index, candidate(document_id,index,line,level,true,1.0,"markdown","已有 Markdown 标题"));
            continue;
        }
        if let Some(level) = inferred_level(line) {
            let short = normalized_heading_text(line).chars().count() <= 120;
            if short && !trimmed.ends_with('。') && !trimmed.ends_with('；') {
                by_line.insert(index,candidate(document_id,index,line,level,true,0.94,"numbering","编号层级明确"));
            }
        }
    }
    if let Some(end) = toc_end {
        for (_, toc_title, level) in &toc_entries {
            if let Some((index, line)) = lines.iter().enumerate().skip(end + 1).find(|(i,line)| !by_line.contains_key(i) && normalized_heading_text(line) == *toc_title) {
                by_line.insert(index,candidate(document_id,index,line,*level,true,0.98,"toc","与 Word 目录匹配"));
            }
        }
    }
    let bold_re = Regex::new(r"^\s*(?:\*\*[^*]{2,100}\*\*\s*)+$").unwrap();
    for (index,line) in lines.iter().enumerate() {
        if by_line.contains_key(&index) || toc_start.zip(toc_end).is_some_and(|(start,end)| index >= start && index <= end) { continue; }
        let text=normalized_heading_text(line);let blank_before=index==0||lines[index-1].trim().is_empty();let blank_after=index+1>=lines.len()||lines[index+1].trim().is_empty();
        if bold_re.is_match(line) && blank_before && blank_after && text.chars().count()<=80 && !text.ends_with('。') && !text.ends_with('：') {
            by_line.insert(index,candidate(document_id,index,line,2,false,0.45,"candidate","独占粗体短行，需要确认"));
        }
    }
    (by_line.into_values().collect(),toc_start,toc_end)
}

async fn resolve_ambiguous_candidates(candidates:&mut [HeadingCandidate],markdown:&str,mut config:ModelConfig)->Option<String>{
    let pending:Vec<_>=candidates.iter().filter(|c|!c.selected&&c.source=="candidate").take(80).map(|c|{
        let lines:Vec<&str>=markdown.lines().collect();let start=c.line.saturating_sub(2);let end=(c.line+3).min(lines.len());
        json!({"id":c.id,"line":c.line+1,"text":c.text,"context":lines[start..end].join("\n")})
    }).collect();
    if pending.is_empty(){return None;}
    if config.api_key.is_empty(){config.api_key=load_secret("openai-api-key");}
    if config.model.trim().is_empty(){return Some("未配置模型，低置信度标题保留为待确认".into());}
    if config.api_key.is_empty()&&!config.base_url.contains("localhost")&&!config.base_url.contains("127.0.0.1"){return Some("API Key 未配置，低置信度标题保留为待确认".into());}
    let payload=json!({"model":config.model,"messages":[
      {"role":"system","content":"判断候选行是否是技术方案章节标题。只返回严格JSON：{\"decisions\":[{\"id\":\"...\",\"selected\":true,\"level\":1,\"reason\":\"...\"}]}。level为1到6。普通编号清单、表格项、完整正文句不是标题。不得改写原文。"},
      {"role":"user","content":serde_json::to_string(&pending).unwrap_or_default()}
    ],"stream":false,"response_format":{"type":"json_object"}});
    let mut request=reqwest::Client::new().post(format!("{}/chat/completions",config.base_url.trim_end_matches('/'))).bearer_auth(&config.api_key).json(&payload);
    for(key,value)in &config.headers{request=request.header(key,value);}
    let result=async{let response=request.timeout(Duration::from_millis(config.timeout_ms)).send().await.map_err(|e|e.to_string())?;if !response.status().is_success(){return Err(format!("模型服务返回 {}",response.status()));}let body:Value=response.json().await.map_err(|e|e.to_string())?;let raw=body.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();serde_json::from_str::<Value>(raw).map_err(|_|"模型未返回有效 JSON".to_string())}.await;
    match result{Ok(value)=>{if let Some(items)=value.get("decisions").and_then(Value::as_array){for item in items{let Some(id)=item.get("id").and_then(Value::as_str)else{continue};if let Some(c)=candidates.iter_mut().find(|c|c.id==id){c.selected=item.get("selected").and_then(Value::as_bool).unwrap_or(false);c.level=item.get("level").and_then(Value::as_u64).unwrap_or(c.level as u64).clamp(1,6)as usize;c.reason=item.get("reason").and_then(Value::as_str).unwrap_or("模型判定").to_string();c.source="model".into();c.confidence=0.7;}}}None},Err(error)=>Some(error)}
}

fn ensure_history_copy(workspace:&WorkspacePaths,source_path:&str)->Result<(PathBuf,String),String>{
    let source=resolve_workspace_path(workspace,source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;let history=PathBuf::from(&workspace.history_dir);fs::create_dir_all(&history).map_err(|e|e.to_string())?;
    let destination=if source.starts_with(&history){source.clone()}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};if destination!=source{fs::write(&destination,&content).map_err(|e|e.to_string())?;}Ok((destination,content))
}

fn validate_history_path(workspace:&WorkspacePaths,path:&str)->Result<PathBuf,String>{
    let history=fs::canonicalize(&workspace.history_dir).map_err(|e|e.to_string())?;let target=fs::canonicalize(resolve_workspace_path(workspace,path)).map_err(|e|e.to_string())?;if !target.starts_with(history){return Err("只能规范化工作区 history 下的副本".into());}Ok(target)
}

#[tauri::command]
pub fn knowledge_scan(workspace:WorkspacePaths)->Result<Vec<KnowledgeScanItem>,String>{
    let db=knowledge_db(&workspace)?;
    let mut files=Vec::new();
    fn walk(dir:&Path,out:&mut Vec<PathBuf>)->Result<(),String>{
        if !dir.exists(){return Ok(());} for entry in fs::read_dir(dir).map_err(|e|e.to_string())?{let path=entry.map_err(|e|e.to_string())?.path();if path.is_dir(){walk(&path,out)?}else if path.extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("md")||x.eq_ignore_ascii_case("markdown")){out.push(path)}} Ok(())
    }
    walk(Path::new(&workspace.history_dir),&mut files)?;
    let generated_readme=PathBuf::from(&workspace.history_dir).join("README.md");
    files.retain(|path| path != &generated_readme);
    files.into_iter().map(|path|{
        let text=fs::read_to_string(&path).map_err(|e|e.to_string())?;let location=storage_location(&workspace,path.to_string_lossy().as_ref());
        let existing=find_document_by_location(&db,&location)?;
        let state=match existing.as_ref(){
            None=>"unindexed",
            Some((_,fingerprint))if fingerprint!=&hash_text(&text)=>"changed",
            Some((id,_))=>{let version:i64=db.query_row("SELECT chunking_version FROM knowledge_documents WHERE id=?1",[id],|r|r.get(0)).unwrap_or(1);if version<CHUNKING_VERSION{"changed"}else{"indexed"}}
        };
        Ok(KnowledgeScanItem{title:path.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名").into(),path:location,state:state.into(),document_id:existing.map(|x|x.0)})
    }).collect()
}

#[tauri::command]
pub async fn knowledge_analyze_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String,config:ModelConfig)->Result<HeadingDetectionResult,String>{
    let(destination,content)=ensure_history_copy(&workspace,&source_path)?;let location=storage_location(&workspace,destination.to_string_lossy().as_ref());let document_id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};
    emit_progress(&app,&document_id,"structure_scanning",0,0,"正在本地扫描标题和章节结构…");
    let(mut candidates,toc_start,toc_end)=detect_heading_candidates(&document_id,&content);let ambiguous=candidates.iter().filter(|candidate|!candidate.selected&&candidate.source=="candidate").count();
    if ambiguous>0{emit_progress(&app,&document_id,"structure_ai",0,ambiguous,&format!("正在调用 AI 判断 {ambiguous} 个低置信度标题…"));}
    let model_error=resolve_ambiguous_candidates(&mut candidates,&content,config).await;
    let message=if ambiguous==0{"本地结构识别完成，无需调用 AI"}else if model_error.is_some(){"AI 判断未完成，已保留本地识别结果"}else{"AI 标题判断完成"};
    emit_progress(&app,&document_id,"structure_complete",ambiguous.max(1),ambiguous.max(1),message);
    Ok(HeadingDetectionResult{document_id,title:destination.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名").into(),path:location,candidates,toc_start,toc_end,model_error})
}

fn backup_original(workspace:&WorkspacePaths,document_id:&str,source:&Path,content:&str)->Result<PathBuf,String>{
    let dir=PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(document_id);fs::create_dir_all(&dir).map_err(|e|e.to_string())?;let stem=source.file_stem().and_then(|x|x.to_str()).unwrap_or("document");let path=dir.join(format!("{}-{}.md",now_string(),safe_markdown_name(stem).trim_end_matches(".md")));fs::write(&path,content).map_err(|e|e.to_string())?;Ok(path)
}

fn apply_heading_decisions(content:&str,decisions:&[HeadingReviewDecision],toc_start:Option<usize>,toc_end:Option<usize>)->String{
    let selected:BTreeMap<usize,&HeadingReviewDecision>=decisions.iter().filter(|d|d.selected).map(|d|(d.line,d)).collect();let mut output=Vec::new();let mark_toc=!content.contains("<!-- knowledge-toc:start -->");
    for(index,line)in content.lines().enumerate(){if mark_toc&&Some(index)==toc_start{output.push("<!-- knowledge-toc:start -->".to_string());}if let Some(decision)=selected.get(&index){let _candidate_id=&decision.id;if markdown_heading(line).is_some(){output.push(line.to_string())}else{output.push(format!("{} {}","#".repeat(decision.level.clamp(1,6)),line.trim_start()))}}else{output.push(line.to_string())}if mark_toc&&Some(index)==toc_end{output.push("<!-- knowledge-toc:end -->".to_string());}}
    let mut result=output.join("\n");if content.ends_with('\n'){result.push('\n');}result
}

fn save_heading_metadata(workspace:&WorkspacePaths,document_id:&str,decisions:&[HeadingReviewDecision],original:&str,normalized:&str,status:&str)->Result<(),String>{
    let db=knowledge_db(workspace)?;db.execute("UPDATE knowledge_documents SET structure_status=?2,original_fingerprint=?3,normalized_fingerprint=?4 WHERE id=?1",params![document_id,status,hash_text(original),hash_text(normalized)]).map_err(|e|e.to_string())?;
    let mut stmt=db.prepare("SELECT id,title FROM knowledge_sections WHERE document_id=?1 ORDER BY position").map_err(|e|e.to_string())?;let sections:Vec<(String,String)>=stmt.query_map([document_id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;drop(stmt);
    let mut used=vec![false;decisions.len()];for(section_id,title)in sections{let normalized_title=normalized_heading_text(&title);if let Some((index,decision))=decisions.iter().enumerate().find(|(i,d)|!used[*i]&&d.selected&&original.lines().nth(d.line).map(normalized_heading_text).as_deref()==Some(normalized_title.as_str())){used[index]=true;db.execute("UPDATE knowledge_sections SET heading_source=?2,original_line=?3,confidence=?4 WHERE id=?1",params![section_id,decision.source,decision.line as i64+1,decision.confidence]).map_err(|e|e.to_string())?;}}
    Ok(())
}

#[tauri::command]
pub async fn knowledge_apply_headings(app:AppHandle,workspace:WorkspacePaths,path:String,decisions:Vec<HeadingReviewDecision>,toc_start:Option<usize>,toc_end:Option<usize>)->Result<KnowledgeDocument,String>{
    let source=validate_history_path(&workspace,&path)?;let original=fs::read_to_string(&source).map_err(|e|e.to_string())?;let absolute=source.to_string_lossy();let location=storage_location(&workspace,&absolute);let document_id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};emit_progress(&app,&document_id,"normalization_backup",0,0,"正在备份规范化前的原文…");backup_original(&workspace,&document_id,&source,&original)?;emit_progress(&app,&document_id,"normalization_writing",0,0,"正在写入确认后的标题结构…");let normalized=apply_heading_decisions(&original,&decisions,toc_start,toc_end);fs::write(&source,&normalized).map_err(|e|e.to_string())?;let title=source.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let doc=match store_document_with_progress(&workspace,"markdown",&absolute,None,title,&normalized,Some(&app)){Ok(doc)=>doc,Err(error)=>{let _=fs::write(&source,&original);return Err(error);}};emit_progress(&app,&document_id,"normalization_metadata",0,0,"正在保存章节识别结果…");save_heading_metadata(&workspace,&doc.id,&decisions,&original,&normalized,"confirmed")?;emit_progress(&app,&doc.id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"结构规范化和索引已完成");Ok(doc)
}

#[tauri::command]
pub fn knowledge_backups(workspace:WorkspacePaths,document_id:String)->Result<Vec<KnowledgeBackup>,String>{
    let dir=PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(document_id);if !dir.exists(){return Ok(Vec::new());}let mut result=Vec::new();for entry in fs::read_dir(dir).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let path=entry.path();if path.extension().and_then(|x|x.to_str())!=Some("md"){continue;}let meta=entry.metadata().map_err(|e|e.to_string())?;result.push(KnowledgeBackup{name:path.file_name().and_then(|x|x.to_str()).unwrap_or("backup.md").into(),path:path.to_string_lossy().into(),created_at:file_time_string(&meta)});}result.sort_by(|a,b|b.name.cmp(&a.name));Ok(result)
}

fn file_time_string(meta:&fs::Metadata)->String{meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_secs().to_string()).unwrap_or_default()}

#[tauri::command]
pub async fn knowledge_restore_backup(app:AppHandle,workspace:WorkspacePaths,document_id:String,backup_path:String)->Result<KnowledgeDocument,String>{
    let backup_root=fs::canonicalize(PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(&document_id)).map_err(|e|e.to_string())?;let backup=fs::canonicalize(&backup_path).map_err(|e|e.to_string())?;if !backup.starts_with(backup_root){return Err("备份路径无效".into());}let db=knowledge_db(&workspace)?;let location:String=db.query_row("SELECT location FROM knowledge_documents WHERE id=?1",[&document_id],|r|r.get(0)).map_err(|e|e.to_string())?;drop(db);let target=validate_history_path(&workspace,&location)?;let original=fs::read_to_string(&backup).map_err(|e|e.to_string())?;fs::write(&target,&original).map_err(|e|e.to_string())?;let title=target.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let doc=store_document_with_progress(&workspace,"markdown",&location,None,title,&original,Some(&app))?;let db=knowledge_db(&workspace)?;db.execute("UPDATE knowledge_documents SET structure_status='review_recommended',original_fingerprint=?2,normalized_fingerprint=NULL WHERE id=?1",params![document_id,hash_text(&original)]).map_err(|e|e.to_string())?;drop(db);emit_progress(&app,&document_id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"已恢复原文并重建索引");Ok(doc)
}

#[tauri::command]
pub async fn knowledge_import_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String)->Result<KnowledgeDocument,String>{
    let source=resolve_workspace_path(&workspace,&source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;
    fs::create_dir_all(&workspace.history_dir).map_err(|e|e.to_string())?;
    let history=PathBuf::from(&workspace.history_dir);
    let destination=if source.starts_with(&history){source.clone()}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};
    if destination!=source{fs::write(&destination,&content).map_err(|e|e.to_string())?;}
    let title=destination.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let absolute=destination.to_string_lossy().to_string();let location=storage_location(&workspace,&absolute);let id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};
    emit_progress(&app,&id,"parsing",0,0,"正在准备 Markdown 索引…");let doc=store_document_with_progress(&workspace,"markdown",&absolute,None,title,&content,Some(&app))?;
    emit_progress(&app,&doc.id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"索引完成");Ok(doc)
}

#[tauri::command]
pub async fn knowledge_index_pending(app:AppHandle,workspace:WorkspacePaths,paths:Vec<String>)->Result<Vec<KnowledgeDocument>,String>{
    let mut result=Vec::new();for path in paths{result.push(knowledge_import_markdown(app.clone(),workspace.clone(),path).await?);}Ok(result)
}

#[tauri::command]
pub fn knowledge_list(workspace:WorkspacePaths)->Result<Vec<KnowledgeDocument>,String>{
    let db=knowledge_db(&workspace)?;let mut stmt=db.prepare("SELECT id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,structure_status FROM knowledge_documents ORDER BY updated_at DESC,title").map_err(|e|e.to_string())?;
    let result=stmt.query_map([],|r|Ok(KnowledgeDocument{id:r.get(0)?,source_type:r.get(1)?,title:r.get(2)?,location:r.get(3)?,source_url:r.get(4)?,fingerprint:r.get(5)?,status:r.get(6)?,error:r.get(7)?,section_count:r.get(8)?,chunk_count:r.get(9)?,updated_at:r.get(10)?,structure_status:r.get(11)?})).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn knowledge_sections(workspace:WorkspacePaths,document_id:String)->Result<Vec<KnowledgeSection>,String>{
    let db=knowledge_db(&workspace)?;let mut stmt=db.prepare("SELECT s.id,s.document_id,s.parent_id,s.title,s.heading_path,s.level,s.position,s.chunk_count,s.heading_source,s.original_line,s.confidence,COALESCE(c.quality,'normal') FROM knowledge_sections s LEFT JOIN knowledge_chunks c ON c.section_id=s.id WHERE s.document_id=?1 ORDER BY s.position").map_err(|e|e.to_string())?;
    let result=stmt.query_map([document_id],|r|Ok(KnowledgeSection{id:r.get(0)?,document_id:r.get(1)?,parent_id:r.get(2)?,title:r.get(3)?,heading_path:r.get(4)?,level:r.get(5)?,position:r.get(6)?,chunk_count:r.get(7)?,heading_source:r.get(8)?,original_line:r.get(9)?,confidence:r.get(10)?,quality:r.get(11)?})).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(result)
}

fn chunk_from_row(r:&rusqlite::Row<'_>)->rusqlite::Result<KnowledgeChunk>{Ok(KnowledgeChunk{id:r.get(0)?,document_id:r.get(1)?,section_id:r.get(2)?,document_title:r.get(3)?,heading_path:r.get(4)?,content:r.get(5)?,position:r.get(6)?,start_char:r.get(7)?,end_char:r.get(8)?,status:r.get(9)?,quality:r.get(10)?})}

#[tauri::command]
pub fn knowledge_search(workspace:WorkspacePaths,query:String,limit:Option<usize>,qualities:Option<Vec<String>>,fields:Option<Vec<String>>)->Result<Vec<KnowledgeSearchResult>,String>{
    let db=knowledge_db(&workspace)?;let trimmed=query.trim();if trimmed.is_empty(){return Ok(Vec::new());}
    let token_expression=segmented(trimmed).split_whitespace().map(|x|format!("\"{}\"",x.replace('\"',""))).collect::<Vec<_>>().join(" AND ");
    let requested=fields.unwrap_or_else(||vec!["documentTitle".into(),"headingPath".into(),"content".into()]);
    let columns=requested.iter().filter_map(|field|match field.as_str(){"documentTitle"=>Some("document_title"),"headingPath"=>Some("title_path"),"content"=>Some("body"),_=>None}).collect::<Vec<_>>();
    if columns.is_empty(){return Ok(Vec::new());}
    let tokens=columns.iter().map(|column|format!("{column} : ({token_expression})")).collect::<Vec<_>>().join(" OR ");
    let qualities=qualities.unwrap_or_else(||vec!["good".into(),"normal".into()]);let include_good=qualities.iter().any(|x|x=="good");let include_normal=qualities.iter().any(|x|x=="normal");let include_bad=qualities.iter().any(|x|x=="bad");
    let sql="SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality,(bm25(knowledge_chunk_fts,0.0,8.0,6.0,2.0)-CASE WHEN d.title LIKE '%'||?2||'%' THEN 8.0 ELSE 0 END-CASE WHEN c.heading_path LIKE '%'||?2||'%' THEN 5.0 ELSE 0 END-CASE WHEN c.content LIKE '%'||?2||'%' THEN 2.0 ELSE 0 END) AS score,s.level,s.parent_id FROM knowledge_chunk_fts JOIN knowledge_chunks c ON c.id=knowledge_chunk_fts.chunk_id JOIN knowledge_documents d ON d.id=c.document_id JOIN knowledge_sections s ON s.id=c.section_id WHERE knowledge_chunk_fts MATCH ?1 AND ((?3 AND c.quality='good') OR (?4 AND c.quality='normal') OR (?5 AND c.quality='bad')) ORDER BY CASE c.quality WHEN 'good' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,score,c.position LIMIT ?6";
    let mut stmt=db.prepare(sql).map_err(|e|e.to_string())?;let rows=stmt.query_map(params![tokens,trimmed,include_good,include_normal,include_bad,limit.unwrap_or(30).min(100) as i64],|r|{let chunk=chunk_from_row(r)?;let raw=chunk.content.replace('\n'," ");let excerpt=raw.chars().take(220).collect();let matched_section_id=chunk.section_id.clone();let level:i64=r.get(12)?;let parent_id:Option<String>=r.get(13)?;Ok(KnowledgeSearchResult{chunk,excerpt,score:r.get(11)?,scope_section_id:matched_section_id.clone(),matched_section_id,level,can_move_up:level>1&&parent_id.is_some(),parent_id})}).map_err(|e|e.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
pub fn knowledge_section_scope(workspace:WorkspacePaths,section_id:String)->Result<KnowledgeSectionScope,String>{
    let db=knowledge_db(&workspace)?;
    let (document_id,parent_id,title,heading_path,level,position,document_title,quality):(String,Option<String>,String,String,i64,i64,String,String)=db.query_row(
        "SELECT s.document_id,s.parent_id,s.title,s.heading_path,s.level,s.position,d.title,COALESCE(c.quality,'normal') FROM knowledge_sections s JOIN knowledge_documents d ON d.id=s.document_id LEFT JOIN knowledge_chunks c ON c.section_id=s.id WHERE s.id=?1",
        [&section_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))
    ).map_err(|e|e.to_string())?;
    if level<1{return Err("文档根节点不能作为章节范围".into());}
    let mut stmt=db.prepare("SELECT s.title,s.level,c.content FROM knowledge_sections s LEFT JOIN knowledge_chunks c ON c.section_id=s.id WHERE s.document_id=?1 AND s.position>=?2 ORDER BY s.position").map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![document_id,position],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?.unwrap_or_default()))).map_err(|e|e.to_string())?;
    let mut markdown=String::new();let mut section_count=0i64;
    for row in rows{
        let (row_title,row_level,body)=row.map_err(|e|e.to_string())?;
        if section_count>0&&row_level<=level{break;}
        if !markdown.is_empty(){markdown.push_str("\n\n");}
        markdown.push_str(&format!("{} {}","#".repeat(row_level.clamp(1,6) as usize),row_title));
        if !body.trim().is_empty(){markdown.push_str("\n\n");markdown.push_str(body.trim());}
        section_count+=1;
    }
    Ok(KnowledgeSectionScope{id:format!("kscope:{section_id}"),document_id,document_title,section_id,parent_id:parent_id.clone(),title,heading_path,level,content:markdown,section_count,quality,can_move_up:level>1&&parent_id.is_some()})
}

#[tauri::command]
pub fn knowledge_chunk(workspace:WorkspacePaths,chunk_id:String)->Result<KnowledgeChunk,String>{
    let db=knowledge_db(&workspace)?;db.query_row("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.id=?1",[chunk_id],chunk_from_row).map_err(|e|e.to_string())
}

#[tauri::command]
pub fn knowledge_set_chunk_quality(workspace:WorkspacePaths,chunk_id:String,quality:String)->Result<KnowledgeChunk,String>{
    if !matches!(quality.as_str(),"good"|"normal"|"bad"){return Err("片段质量状态无效".into());}
    let db=knowledge_db(&workspace)?;let changed=db.execute("UPDATE knowledge_chunks SET quality=?2 WHERE id=?1",params![chunk_id,quality]).map_err(|e|e.to_string())?;if changed==0{return Err("知识片段不存在".into());}drop(db);knowledge_chunk(workspace,chunk_id)
}

#[tauri::command]
pub fn knowledge_section_chunks(workspace:WorkspacePaths,section_id:String)->Result<Vec<KnowledgeChunk>,String>{
    let db=knowledge_db(&workspace)?;
    let mut stmt=db.prepare("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunk_sections m JOIN knowledge_chunks c ON c.id=m.chunk_id JOIN knowledge_documents d ON d.id=c.document_id WHERE m.section_id=?1 ORDER BY c.position").map_err(|e|e.to_string())?;
    let result=stmt.query_map([section_id],chunk_from_row).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn knowledge_remove(workspace:WorkspacePaths,document_id:String)->Result<(),String>{let db=knowledge_db(&workspace)?;db.execute("DELETE FROM knowledge_chunk_fts WHERE chunk_id IN(SELECT id FROM knowledge_chunks WHERE document_id=?1)",[&document_id]).map_err(|e|e.to_string())?;db.execute("DELETE FROM knowledge_documents WHERE id=?1",[document_id]).map_err(|e|e.to_string())?;Ok(())}

#[tauri::command]
pub fn knowledge_delete_file(workspace:WorkspacePaths,path:String,document_id:Option<String>)->Result<(),String>{
    let target=validate_history_path(&workspace,&path)?;if !target.is_file(){return Err("知识文档不存在".into());}
    if target.file_name().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("README.md")){return Err("不能删除知识库说明文件".into());}
    let db=knowledge_db(&workspace)?;
    let indexed_id=if let Some(requested)=document_id.as_ref(){let indexed_path:String=db.query_row("SELECT location FROM knowledge_documents WHERE id=?1",[requested],|r|r.get(0)).map_err(|e|e.to_string())?;let canonical_indexed=fs::canonicalize(resolve_workspace_path(&workspace,&indexed_path)).map_err(|e|e.to_string())?;if canonical_indexed!=target{return Err("文档索引与文件不匹配".into());}Some(requested.clone())}else{let location=storage_location(&workspace,target.to_string_lossy().as_ref());find_document_by_location(&db,&location)?.map(|(id,_)|id)};
    fs::remove_file(&target).map_err(|e|format!("删除知识文档失败: {e}"))?;
    if let Some(id)=indexed_id{db.execute("DELETE FROM knowledge_chunk_fts WHERE chunk_id IN(SELECT id FROM knowledge_chunks WHERE document_id=?1)",[&id]).map_err(|e|e.to_string())?;db.execute("DELETE FROM knowledge_documents WHERE id=?1",[id]).map_err(|e|e.to_string())?;}
    Ok(())
}

async fn fetch_web_markdown(url:&str)->Result<(String,String),String>{
    let parsed=reqwest::Url::parse(url).map_err(|_|"网页地址无效".to_string())?;if parsed.scheme()!="http"&&parsed.scheme()!="https"{return Err("仅支持 HTTP/HTTPS 网页".into());}
    let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(5)).timeout(Duration::from_secs(30)).build().map_err(|e|e.to_string())?;
    let response=client.get(parsed).send().await.map_err(|e|format!("抓取网页失败: {e}"))?;if !response.status().is_success(){return Err(format!("网页返回 {}",response.status()));}
    let kind=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|x|x.to_str().ok()).unwrap_or("").to_ascii_lowercase();if !kind.contains("text/html"){return Err("该地址不是 HTML 网页".into());}
    if response.content_length().is_some_and(|n|n as usize>MAX_WEB_BYTES){return Err("网页内容超过 5 MB".into());}
    let bytes=response.bytes().await.map_err(|e|e.to_string())?;if bytes.len()>MAX_WEB_BYTES{return Err("网页内容超过 5 MB".into());}let html=String::from_utf8_lossy(&bytes).to_string();
    let doc=Html::parse_document(&html);let title_sel=Selector::parse("title").unwrap();let title=doc.select(&title_sel).next().map(|x|x.text().collect::<String>().trim().to_string()).filter(|x|!x.is_empty()).unwrap_or_else(||"网页知识".into());
    let content_sel=Selector::parse("article, main, body").unwrap();let element=doc.select(&content_sel).next().ok_or("网页没有可提取的正文")?;let fragment=element.html();let markdown=html2md::parse_html(&fragment);if markdown.trim().chars().count()<40{return Err("网页没有足够的可提取正文".into());}Ok((title,markdown))
}

#[tauri::command]
pub async fn knowledge_import_web(app:AppHandle,workspace:WorkspacePaths,url:String)->Result<KnowledgeDocument,String>{
    let (title,body)=fetch_web_markdown(&url).await?;let dir=PathBuf::from(&workspace.history_dir).join("web");fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let existing_location={let db=knowledge_db(&workspace)?;db.query_row("SELECT location FROM knowledge_documents WHERE source_url=?1",[&url],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?};
    let destination=existing_location.map(|location|resolve_workspace_path(&workspace,&location)).unwrap_or_else(||unique_destination(&dir,&safe_markdown_name(&title)));let markdown=format!("---\nsourceUrl: {}\nfetchedAt: {}\n---\n\n# {}\n\n{}",url,now_string(),title,body);fs::write(&destination,&markdown).map_err(|e|e.to_string())?;
    let location=destination.to_string_lossy().to_string();let doc=store_document_with_progress(&workspace,"web",&location,Some(&url),&title,&markdown,Some(&app))?;emit_progress(&app,&doc.id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"网页正文已提取并完成索引");Ok(doc)
}

#[tauri::command]
pub fn knowledge_set_section_quality(workspace:WorkspacePaths,section_id:String,quality:String)->Result<String,String>{
    if !matches!(quality.as_str(),"good"|"normal"|"bad"){return Err("片段质量状态无效".into());}
    let db=knowledge_db(&workspace)?;let changed=db.execute("UPDATE knowledge_chunks SET quality=?2 WHERE section_id=?1",params![section_id,quality]).map_err(|e|e.to_string())?;
    if changed==0{return Err("该章节没有独立知识片段，请重新识别文档".into());}
    Ok(quality)
}

#[cfg(test)]
mod tests{
 use super::*;
 #[cfg(windows)]
 #[test] fn treats_windows_verbatim_and_regular_paths_as_the_same_location(){
   assert_eq!(normalized_location(r"\\?\E:\Knowledge\Doc.md"),normalized_location(r"e:/knowledge/doc.md"));
   assert_eq!(normalized_location(r"\\?\UNC\server\share\Doc.md"),normalized_location(r"\\server\share\doc.md"));
 }
 #[cfg(windows)]
 #[test] fn scan_recognizes_an_existing_verbatim_path_index(){
   let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let root=std::env::temp_dir().join(format!("gouan-path-test-{nonce}"));let history=root.join("history");fs::create_dir_all(&history).unwrap();let source=history.join("document.md");let markdown="# 文档\n\n正文";fs::write(&source,markdown).unwrap();
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let regular=source.to_string_lossy();let verbatim=format!(r"\\?\{regular}");store_document(&workspace,"markdown",&verbatim,None,"文档",markdown).unwrap();let scanned=knowledge_scan(workspace).unwrap();assert_eq!(scanned.len(),1);assert_eq!(scanned[0].state,"indexed");assert_eq!(scanned[0].path,"history/document.md");let _=fs::remove_dir_all(root);
 }
 #[cfg(windows)]
 #[test] fn relocates_migrated_knowledge_paths_to_current_history(){
   let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let root=std::env::temp_dir().join(format!("gouan-relocate-test-{nonce}"));let history=root.join("history");let web=history.join("web");fs::create_dir_all(&web).unwrap();let source=web.join("document.md");let markdown="# 文档\n\n正文";fs::write(&source,markdown).unwrap();
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let location=source.to_string_lossy().to_string();let document=store_document(&workspace,"web",&location,None,"文档",markdown).unwrap();let db=knowledge_db(&workspace).unwrap();db.execute("UPDATE knowledge_documents SET location=?2 WHERE id=?1",params![document.id,r"\\?\E:\old-workspace\history\web\document.md"]).unwrap();drop(db);
   let documents=knowledge_list(workspace.clone()).unwrap();assert_eq!(documents[0].location,"history/web/document.md");assert_eq!(fs::canonicalize(resolve_workspace_path(&workspace,&documents[0].location)).unwrap(),fs::canonicalize(&source).unwrap());let _=fs::remove_dir_all(root);
 }
 #[test] fn parses_tree_and_ignores_fenced_headings(){let s=parse_sections("d","Doc","intro\n# A\nbody\n```md\n# fake\n```\n### C\ntext");assert_eq!(s.len(),3);assert_eq!(s[1].title,"A");assert_eq!(s[2].path,"A > C");}
 #[test] fn does_not_create_empty_preamble_but_keeps_empty_heading(){let s=parse_sections("d","Doc","# A\n## Empty\n");assert_eq!(s.len(),2);assert_eq!(s[0].title,"A");assert_eq!(s[1].title,"Empty");}
 #[test] fn creates_one_chunk_per_section_including_empty_sections(){let markdown="# 第一章\n\n引言\n\n## 功能设计\n\n### 空章节\n\n#### 水环境专题\n\n水质正文";let sections=parse_sections("d","Doc",markdown);let chunks=build_document_chunks("d",&sections);assert_eq!(chunks.len(),sections.len());assert!(chunks.iter().all(|chunk|chunk.section_ids==vec![chunk.section_id.clone()]));assert_eq!(chunks[2].content,"");assert_eq!(chunks[3].content,"水质正文");}
 #[test] fn detects_word_numbering_and_toc_without_lists(){
   let md="目 录\n\n[第一章 项目概述](#_Toc1)\n[1.1 建设目标](#_Toc2)\n[1.1.1 建设内容](#_Toc3)\n\n第一章\u{00a0}项目概述\n\n正文。\n\n1.1\u{3000}建设目标\n\n1、这是普通功能清单\n\n（1）这是操作步骤\n\n1.1.1 建设内容\n";
   let(candidates,start,end)=detect_heading_candidates("doc",md);assert!(start.is_some()&&end.is_some());assert_eq!(candidates.iter().filter(|c|c.selected).count(),3);assert_eq!(candidates.iter().map(|c|c.level).collect::<Vec<_>>(),vec![1,2,3]);assert!(!candidates.iter().any(|c|c.text.contains("功能清单")||c.text.contains("操作步骤")));
 }
 #[test] fn keeps_toc_but_excludes_it_from_sections(){
   let original="[第一章 概述](#_Toc1)\n[1.1 目标](#_Toc2)\n[1.2 范围](#_Toc3)\n\n第一章 概述\n正文\n";let decisions=vec![HeadingReviewDecision{id:"x".into(),line:4,selected:true,level:1,source:"numbering".into(),confidence:0.9}];let normalized=apply_heading_decisions(original,&decisions,Some(0),Some(2));assert!(normalized.contains("<!-- knowledge-toc:start -->\n[第一章 概述]"));assert!(normalized.contains("# 第一章 概述"));let sections=parse_sections("d","Doc",&normalized);assert_eq!(sections.len(),1);assert!(!sections[0].body.contains("#_Toc"));
 }
 #[test] fn indexes_searches_and_removes_without_deleting_source(){
   let root=std::env::temp_dir().join(format!("gouan-knowledge-test-{}",now_string()));let history=root.join("history");fs::create_dir_all(&history).unwrap();let source=history.join("payment.md");let markdown="# 支付架构\n\n接口使用幂等键避免重复扣款。";fs::write(&source,markdown).unwrap();
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let location=source.to_string_lossy().to_string();let first=store_document(&workspace,"markdown",&location,None,"支付方案",markdown).unwrap();let second=store_document(&workspace,"markdown",&location,None,"支付方案",markdown).unwrap();assert_eq!(first.id,second.id);
   let hits=knowledge_search(workspace.clone(),"幂等".into(),Some(10),None,None).unwrap();assert_eq!(hits.len(),1);assert!(hits[0].chunk.content.contains("重复扣款"));
   assert_eq!(knowledge_search(workspace.clone(),"支付方案".into(),Some(10),None,Some(vec!["documentTitle".into()])).unwrap().len(),1);
   assert!(knowledge_search(workspace.clone(),"支付方案".into(),Some(10),None,Some(vec!["content".into()])).unwrap().is_empty());
   assert_eq!(knowledge_search(workspace.clone(),"支付架构".into(),Some(10),None,Some(vec!["headingPath".into()])).unwrap().len(),1);
   let chunk_id=hits[0].chunk.id.clone();knowledge_set_chunk_quality(workspace.clone(),chunk_id.clone(),"bad".into()).unwrap();assert!(knowledge_search(workspace.clone(),"幂等".into(),Some(10),None,None).unwrap().is_empty());assert_eq!(knowledge_search(workspace.clone(),"幂等".into(),Some(10),Some(vec!["bad".into()]),None).unwrap().len(),1);knowledge_set_chunk_quality(workspace.clone(),chunk_id,"good".into()).unwrap();knowledge_remove(workspace.clone(),first.id).unwrap();assert!(source.exists());assert!(knowledge_list(workspace.clone()).unwrap().is_empty());let restored=store_document(&workspace,"markdown",&location,None,"支付方案",markdown).unwrap();knowledge_delete_file(workspace.clone(),location,Some(restored.id)).unwrap();assert!(!source.exists());assert!(knowledge_list(workspace).unwrap().is_empty());let _=fs::remove_dir_all(root);
 }
 #[test] fn repeated_heading_recognition_is_idempotent(){
   let original="目 录\n\n[第一章 概述](#_Toc1)\n[1.1 建设目标](#_Toc2)\n[1.2 建设范围](#_Toc3)\n\n# 第一章 概述\n\n## 1.1 建设目标\n\n正文\n";
   let(candidates,toc_start,toc_end)=detect_heading_candidates("doc",original);let decisions=candidates.into_iter().map(|item|HeadingReviewDecision{id:item.id,line:item.line,selected:item.selected,level:item.level,source:item.source,confidence:item.confidence}).collect::<Vec<_>>();let once=apply_heading_decisions(original,&decisions,toc_start,toc_end);
   let(candidates2,toc_start2,toc_end2)=detect_heading_candidates("doc",&once);let decisions2=candidates2.into_iter().map(|item|HeadingReviewDecision{id:item.id,line:item.line,selected:item.selected,level:item.level,source:item.source,confidence:item.confidence}).collect::<Vec<_>>();let twice=apply_heading_decisions(&once,&decisions2,toc_start2,toc_end2);
   assert_eq!(once,twice);assert_eq!(twice.matches("<!-- knowledge-toc:start -->").count(),1);assert_eq!(twice.matches("# 第一章 概述").count(),1);
 }
 #[test] fn searches_leaf_section_and_expands_parent_scope(){
   let root=std::env::temp_dir().join(format!("gouan-scope-test-{}",now_string()));let history=root.join("history");fs::create_dir_all(&history).unwrap();let source=history.join("water.md");let markdown="# 功能方案\n\n章引言\n\n## 领导驾驶舱\n\n驾驶舱引言\n\n### 环境质量专题\n\n专题引言\n\n#### 水环境专题\n\n水质达标率正文\n\n#### 声环境专题\n\n噪声正文\n\n### 实验室专题\n\n实验室正文";fs::write(&source,markdown).unwrap();
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let document=store_document(&workspace,"markdown",&source.to_string_lossy(),None,"水环境方案",markdown).unwrap();assert_eq!(document.section_count,document.chunk_count);
   let hits=knowledge_search(workspace.clone(),"水质达标率".into(),Some(10),None,Some(vec!["content".into()])).unwrap();assert_eq!(hits.len(),1);assert_eq!(hits[0].level,4);assert!(hits[0].chunk.heading_path.contains("水环境专题"));
   let water_section=hits[0].matched_section_id.clone();assert_eq!(knowledge_set_section_quality(workspace.clone(),water_section.clone(),"good".into()).unwrap(),"good");let listed=knowledge_sections(workspace.clone(),document.id.clone()).unwrap();assert_eq!(listed.iter().find(|section|section.id==water_section).unwrap().quality,"good");assert_eq!(knowledge_search(workspace.clone(),"水质达标率".into(),Some(10),Some(vec!["good".into()]),Some(vec!["content".into()])).unwrap().len(),1);assert!(knowledge_search(workspace.clone(),"水质达标率".into(),Some(10),Some(vec!["normal".into()]),Some(vec!["content".into()])).unwrap().is_empty());
   let parent=hits[0].parent_id.clone().unwrap();let scope=knowledge_section_scope(workspace.clone(),parent).unwrap();assert_eq!(scope.level,3);assert!(scope.content.contains("水环境专题"));assert!(scope.content.contains("声环境专题"));assert!(!scope.content.contains("实验室专题"));assert_eq!(scope.section_count,3);
   let title_hits=knowledge_search(workspace.clone(),"水环境专题".into(),Some(10),None,Some(vec!["headingPath".into()])).unwrap();assert_eq!(title_hits.len(),1);assert_eq!(title_hits[0].matched_section_id,hits[0].matched_section_id);let _=fs::remove_dir_all(root);
 }
}
