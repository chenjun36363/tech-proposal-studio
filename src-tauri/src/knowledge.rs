use crate::{load_secret, ModelConfig, WorkspacePaths};
use jieba_rs::Jieba;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};

const MAX_CHUNK_CHARS: usize = 6000;
const CHUNK_OVERLAP_CHARS: usize = 300;
const TARGET_CHUNK_CHARS: usize = 4000;
const CHUNKING_VERSION: i64 = 2;
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
    summary: String,
    chunk_count: i64,
    heading_source: String,
    original_line: Option<i64>,
    confidence: f64,
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
    summary: String,
    keywords: Vec<String>,
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
           chunk_id UNINDEXED, title_path, body, summary, keywords, tokenize='unicode61'
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
    Ok(db)
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

fn char_slice(value: &str, start: usize, end: usize) -> String {
    value.chars().skip(start).take(end.saturating_sub(start)).collect()
}

fn split_section(document_id: &str, section: &ParsedSection) -> Vec<ParsedChunk> {
    let total = section.body.chars().count();
    if total == 0 {
        return vec![ParsedChunk { id: stable_id("kc", &format!("{}:0:", section.id)), section_id: section.id.clone(), heading_path: section.path.clone(), content: String::new(), position: 0, start_char: 0, end_char: 0, section_ids: vec![section.id.clone()] }];
    }
    let mut result = Vec::new();
    let mut start = 0;
    while start < total {
        let target = (start + MAX_CHUNK_CHARS).min(total);
        let mut end = target;
        if target < total {
            let window = char_slice(&section.body, start, target);
            if let Some(byte_pos) = window.rfind("\n\n") {
                let chars = window[..byte_pos].chars().count();
                if chars >= MAX_CHUNK_CHARS / 2 { end = start + chars; }
            }
        }
        let content = char_slice(&section.body, start, end).trim().to_string();
        let position = result.len();
        result.push(ParsedChunk { id: stable_id("kc", &format!("{document_id}:{}:{position}:{}", section.id, hash_text(&content))), section_id: section.id.clone(), heading_path: section.path.clone(), content, position, start_char: start, end_char: end, section_ids: vec![section.id.clone()] });
        if end == total { break; }
        start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
    }
    result
}

fn build_document_chunks(document_id:&str,sections:&[ParsedSection])->Vec<ParsedChunk>{
    let mut chunks=Vec::new();let mut content=String::new();let mut section_ids=Vec::new();let mut anchor:Option<&ParsedSection>=None;let mut start_char=0usize;
    let flush=|chunks:&mut Vec<ParsedChunk>,content:&mut String,section_ids:&mut Vec<String>,anchor:&mut Option<&ParsedSection>,start_char:&mut usize|{if content.trim().is_empty(){return;}let section=anchor.take().unwrap();let body=content.trim().to_string();let position=chunks.len();chunks.push(ParsedChunk{id:stable_id("kc",&format!("{document_id}:merged:{position}:{}",hash_text(&body))),section_id:section.id.clone(),heading_path:section.path.clone(),content:body,position,start_char:*start_char,end_char:*start_char+content.chars().count(),section_ids:std::mem::take(section_ids)});*start_char+=content.chars().count();content.clear();};
    for section in sections{
        if section.body.chars().count()>MAX_CHUNK_CHARS{flush(&mut chunks,&mut content,&mut section_ids,&mut anchor,&mut start_char);for mut chunk in split_section(document_id,section){chunk.position=chunks.len();chunks.push(chunk);}continue;}
        let heading=if section.level>0{format!("{} {}\n\n","#".repeat(section.level.min(6)),section.title)}else{String::new()};let piece=format!("{}{}{}",heading,if heading.is_empty(){""}else{""},section.body);let piece_len=piece.chars().count();
        let boundary=section.level>0&&section.level<=2&&!content.is_empty();let too_large=!content.is_empty()&&content.chars().count()+piece_len>MAX_CHUNK_CHARS;let target_reached=content.chars().count()>=TARGET_CHUNK_CHARS;
        if boundary||too_large||(target_reached&&piece_len>=800){flush(&mut chunks,&mut content,&mut section_ids,&mut anchor,&mut start_char);}
        if anchor.is_none(){anchor=Some(section);}if !content.is_empty(){content.push_str("\n\n");}content.push_str(&piece);section_ids.push(section.id.clone());
    }
    flush(&mut chunks,&mut content,&mut section_ids,&mut anchor,&mut start_char);chunks
}

fn segmented(value: &str) -> String {
    Jieba::new().cut(value, false).join(" ")
}

fn emit_progress(app: &AppHandle, document_id: &str, stage: &str, current: usize, total: usize, message: &str) {
    let _ = app.emit("knowledge://progress", KnowledgeProgress { document_id: document_id.into(), stage: stage.into(), current, total, message: message.into() });
}

fn store_document(workspace: &WorkspacePaths, source_type: &str, location: &str, source_url: Option<&str>, title: &str, markdown: &str) -> Result<KnowledgeDocument, String> {
    let mut db = knowledge_db(workspace)?;
    let fingerprint = hash_text(markdown);
    let id = document_id_for_location(&db, location)?;
    if let Some(existing) = load_document(&db, &id)? {
        let version:i64=db.query_row("SELECT chunking_version FROM knowledge_documents WHERE id=?1",[&id],|r|r.get(0)).unwrap_or(1);
        if existing.fingerprint == fingerprint && version >= CHUNKING_VERSION { return Ok(existing); }
    }
    let sections = parse_sections(&id, title, markdown);
    let chunks = build_document_chunks(&id, &sections);
    let existing_quality: BTreeMap<String, String> = {
        let mut stmt = db.prepare("SELECT id,quality FROM knowledge_chunks WHERE document_id=?1").map_err(|e|e.to_string())?;
        let result=stmt.query_map([&id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
        result
    };
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_chunk_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?1)", [&id]).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO knowledge_documents(id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,chunking_version)
      VALUES(?1,?2,?3,?4,?5,?6,'pending_enrichment',NULL,?7,?8,?9,?10)
      ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,title=excluded.title,location=excluded.location,source_url=excluded.source_url,fingerprint=excluded.fingerprint,status=excluded.status,error=NULL,section_count=excluded.section_count,chunk_count=excluded.chunk_count,updated_at=excluded.updated_at,chunking_version=excluded.chunking_version",
      params![id, source_type, title, location, source_url, fingerprint, sections.len() as i64, chunks.len() as i64, now_string(),CHUNKING_VERSION]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_sections WHERE document_id=?1", [&id]).map_err(|e| e.to_string())?;
    for section in &sections {
        let count = chunks.iter().filter(|c| c.section_ids.contains(&section.id)).count();
        tx.execute("INSERT INTO knowledge_sections(id,document_id,parent_id,title,heading_path,level,position,summary,chunk_count) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8)", params![section.id,id,section.parent_id,section.title,section.path,section.level as i64,section.position as i64,count as i64]).map_err(|e| e.to_string())?;
    }
    for chunk in &chunks {
        let search_text = segmented(&format!("{} {}", chunk.heading_path, chunk.content));
        let quality=existing_quality.get(&chunk.id).map(String::as_str).unwrap_or("normal");
        tx.execute("INSERT INTO knowledge_chunks(id,document_id,section_id,heading_path,content,search_text,position,start_char,end_char,fingerprint,status,quality) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11)", params![chunk.id,id,chunk.section_id,chunk.heading_path,chunk.content,search_text,chunk.position as i64,chunk.start_char as i64,chunk.end_char as i64,hash_text(&chunk.content),quality]).map_err(|e| e.to_string())?;
        for section_id in &chunk.section_ids { tx.execute("INSERT INTO knowledge_chunk_sections(chunk_id,section_id) VALUES(?1,?2)",params![chunk.id,section_id]).map_err(|e|e.to_string())?; }
        tx.execute("INSERT INTO knowledge_chunk_fts(chunk_id,title_path,body,summary,keywords) VALUES(?1,?2,?3,'','')", params![chunk.id,segmented(&chunk.heading_path),segmented(&chunk.content)]).map_err(|e| e.to_string())?;
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

async fn enrich_document(app: &AppHandle, workspace: &WorkspacePaths, document_id: &str, mut config: ModelConfig) -> Result<KnowledgeDocument, String> {
    if config.api_key.is_empty() { config.api_key = load_secret("openai-api-key"); }
    if config.model.trim().is_empty() { return mark_enrichment_error(workspace, document_id, "未配置模型"); }
    if config.api_key.is_empty() && !config.base_url.contains("localhost") && !config.base_url.contains("127.0.0.1") { return mark_enrichment_error(workspace, document_id, "API Key 未配置"); }
    let chunks: Vec<(String, String, String)> = {
        let db = knowledge_db(workspace)?;
        let mut stmt = db.prepare("SELECT id,heading_path,content FROM knowledge_chunks WHERE document_id=?1 AND status!='ready' ORDER BY section_id,position").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([document_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())?
    };
    let total = chunks.len();
    let client = reqwest::Client::new();
    let mut failures = Vec::new();
    let mut batches:Vec<Vec<&(String,String,String)>>=Vec::new();let mut batch=Vec::new();let mut batch_chars=0usize;
    for chunk in &chunks{let size=chunk.2.chars().count();if !batch.is_empty()&&(batch.len()>=6||batch_chars+size>16_000){batches.push(std::mem::take(&mut batch));batch_chars=0;}batch.push(chunk);batch_chars+=size;}if !batch.is_empty(){batches.push(batch);}
    let mut processed=0usize;
    for items in batches {
        emit_progress(app, document_id, "enriching", processed, total, &format!("批量增强 {} 个切片",items.len()));
        let input:Vec<Value>=items.iter().map(|(id,path,content)|json!({"id":id,"headingPath":path,"content":content})).collect();
        let payload = json!({"model":config.model,"messages":[
          {"role":"system","content":"你是知识库索引助手。只返回严格 JSON，不要 Markdown 围栏。格式：{\"items\":[{\"id\":\"原id\",\"summary\":\"不超过120字\",\"keywords\":[\"关键词\"]}]}。每个输入必须返回一项，不得改写原文。"},
          {"role":"user","content":serde_json::to_string(&input).unwrap_or_default()}
        ],"stream":false,"response_format":{"type":"json_object"}});
        let mut request = client.post(format!("{}/chat/completions",config.base_url.trim_end_matches('/'))).bearer_auth(&config.api_key).json(&payload);
        for (key,value) in &config.headers { request=request.header(key,value); }
        let outcome = async {
            let response=request.timeout(Duration::from_millis(config.timeout_ms)).send().await.map_err(|e|e.to_string())?;
            if !response.status().is_success(){return Err(format!("模型服务返回 {}",response.status()));}
            let body:Value=response.json().await.map_err(|e|e.to_string())?;
            let raw=body.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
            let parsed:Value=serde_json::from_str(raw).map_err(|_|"模型未返回有效 JSON".to_string())?;
            parsed.get("items").and_then(Value::as_array).cloned().ok_or_else(||"模型未返回 items 数组".to_string())
        }.await;
        match outcome {
            Ok(results) => {
                let db = knowledge_db(workspace)?;
                for (id,_,_) in &items { if let Some(result)=results.iter().find(|value|value.get("id").and_then(Value::as_str)==Some(id.as_str())) { let summary=result.get("summary").and_then(Value::as_str).unwrap_or("").trim().to_string();let keywords:Vec<String>=result.get("keywords").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_string).take(12).collect()).unwrap_or_default();if summary.is_empty(){db.execute("UPDATE knowledge_chunks SET status='failed' WHERE id=?1",[id]).map_err(|e|e.to_string())?;failures.push(format!("切片 {id} 摘要为空"));continue;}let words=keywords.join(" ");db.execute("UPDATE knowledge_chunks SET summary=?2,keywords=?3,status='ready' WHERE id=?1",params![id,summary,serde_json::to_string(&keywords).unwrap_or_default()]).map_err(|e|e.to_string())?;db.execute("UPDATE knowledge_chunk_fts SET summary=?2,keywords=?3 WHERE chunk_id=?1",params![id,segmented(&summary),segmented(&words)]).map_err(|e|e.to_string())?;}else{db.execute("UPDATE knowledge_chunks SET status='failed' WHERE id=?1",[id]).map_err(|e|e.to_string())?;failures.push(format!("模型遗漏切片 {id}"));} }
            },
            Err(error) => { let db = knowledge_db(workspace)?;for (id,_,_) in &items{db.execute("UPDATE knowledge_chunks SET status='failed' WHERE id=?1",[id]).map_err(|e|e.to_string())?;}failures.push(error); }
        }
        processed+=items.len();
    }
    let status=if failures.is_empty(){"ready"}else{"partial"};
    let error=failures.first().cloned();
    let db = knowledge_db(workspace)?;
    db.execute("UPDATE knowledge_sections SET summary=COALESCE((SELECT group_concat(c.summary, ' ') FROM knowledge_chunk_sections m JOIN knowledge_chunks c ON c.id=m.chunk_id WHERE m.section_id=knowledge_sections.id AND c.summary!=''),'') WHERE document_id=?1",[document_id]).map_err(|e|e.to_string())?;
    db.execute("UPDATE knowledge_documents SET status=?2,error=?3,updated_at=?4 WHERE id=?1",params![document_id,status,error,now_string()]).map_err(|e|e.to_string())?;
    emit_progress(app, document_id, "complete", total, total, if failures.is_empty(){"索引完成"}else{"索引完成，部分 AI 增强失败"});
    load_document(&db,document_id)?.ok_or_else(||"知识文档不存在".into())
}

fn mark_enrichment_error(workspace:&WorkspacePaths,document_id:&str,error:&str)->Result<KnowledgeDocument,String>{
    let db=knowledge_db(workspace)?;
    db.execute("UPDATE knowledge_documents SET status='pending_enrichment',error=?2 WHERE id=?1",params![document_id,error]).map_err(|e|e.to_string())?;
    load_document(&db,document_id)?.ok_or_else(||"知识文档不存在".into())
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
    let source=PathBuf::from(source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;let history=PathBuf::from(&workspace.history_dir);fs::create_dir_all(&history).map_err(|e|e.to_string())?;
    let destination=if source.starts_with(&history){source}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};if destination!=PathBuf::from(source_path){fs::write(&destination,&content).map_err(|e|e.to_string())?;}Ok((destination,content))
}

fn validate_history_path(workspace:&WorkspacePaths,path:&str)->Result<PathBuf,String>{
    let history=fs::canonicalize(&workspace.history_dir).map_err(|e|e.to_string())?;let target=fs::canonicalize(path).map_err(|e|e.to_string())?;if !target.starts_with(history){return Err("只能规范化工作区 history 下的副本".into());}Ok(target)
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
        let text=fs::read_to_string(&path).map_err(|e|e.to_string())?;let location=path.to_string_lossy().to_string();
        let existing=find_document_by_location(&db,&location)?;
        let state=match existing.as_ref(){None=>"unindexed",Some((_,fingerprint))if fingerprint!=&hash_text(&text)=>"changed",Some(_)=>"indexed"};
        Ok(KnowledgeScanItem{title:path.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名").into(),path:location,state:state.into(),document_id:existing.map(|x|x.0)})
    }).collect()
}

#[tauri::command]
pub async fn knowledge_analyze_markdown(workspace:WorkspacePaths,source_path:String,config:ModelConfig)->Result<HeadingDetectionResult,String>{
    let(destination,content)=ensure_history_copy(&workspace,&source_path)?;let location=destination.to_string_lossy().to_string();let document_id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};let(mut candidates,toc_start,toc_end)=detect_heading_candidates(&document_id,&content);let model_error=resolve_ambiguous_candidates(&mut candidates,&content,config).await;
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
pub async fn knowledge_apply_headings(app:AppHandle,workspace:WorkspacePaths,path:String,decisions:Vec<HeadingReviewDecision>,toc_start:Option<usize>,toc_end:Option<usize>,config:ModelConfig)->Result<KnowledgeDocument,String>{
    let source=validate_history_path(&workspace,&path)?;let original=fs::read_to_string(&source).map_err(|e|e.to_string())?;let location=source.to_string_lossy();let document_id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};backup_original(&workspace,&document_id,&source,&original)?;let normalized=apply_heading_decisions(&original,&decisions,toc_start,toc_end);fs::write(&source,&normalized).map_err(|e|e.to_string())?;let title=source.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");emit_progress(&app,&document_id,"chunking",0,1,"正在按确认后的结构切片");let doc=match store_document(&workspace,"markdown",&location,None,title,&normalized){Ok(doc)=>doc,Err(error)=>{let _=fs::write(&source,&original);return Err(error);}};save_heading_metadata(&workspace,&doc.id,&decisions,&original,&normalized,"confirmed")?;enrich_document(&app,&workspace,&doc.id,config).await
}

#[tauri::command]
pub fn knowledge_backups(workspace:WorkspacePaths,document_id:String)->Result<Vec<KnowledgeBackup>,String>{
    let dir=PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(document_id);if !dir.exists(){return Ok(Vec::new());}let mut result=Vec::new();for entry in fs::read_dir(dir).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let path=entry.path();if path.extension().and_then(|x|x.to_str())!=Some("md"){continue;}let meta=entry.metadata().map_err(|e|e.to_string())?;result.push(KnowledgeBackup{name:path.file_name().and_then(|x|x.to_str()).unwrap_or("backup.md").into(),path:path.to_string_lossy().into(),created_at:file_time_string(&meta)});}result.sort_by(|a,b|b.name.cmp(&a.name));Ok(result)
}

fn file_time_string(meta:&fs::Metadata)->String{meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_secs().to_string()).unwrap_or_default()}

#[tauri::command]
pub async fn knowledge_restore_backup(app:AppHandle,workspace:WorkspacePaths,document_id:String,backup_path:String,config:ModelConfig)->Result<KnowledgeDocument,String>{
    let backup_root=fs::canonicalize(PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(&document_id)).map_err(|e|e.to_string())?;let backup=fs::canonicalize(&backup_path).map_err(|e|e.to_string())?;if !backup.starts_with(backup_root){return Err("备份路径无效".into());}let db=knowledge_db(&workspace)?;let location:String=db.query_row("SELECT location FROM knowledge_documents WHERE id=?1",[&document_id],|r|r.get(0)).map_err(|e|e.to_string())?;drop(db);let target=validate_history_path(&workspace,&location)?;let original=fs::read_to_string(&backup).map_err(|e|e.to_string())?;fs::write(&target,&original).map_err(|e|e.to_string())?;let title=target.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let doc=store_document(&workspace,"markdown",&location,None,title,&original)?;let db=knowledge_db(&workspace)?;db.execute("UPDATE knowledge_documents SET structure_status='review_recommended',original_fingerprint=?2,normalized_fingerprint=NULL WHERE id=?1",params![document_id,hash_text(&original)]).map_err(|e|e.to_string())?;drop(db);emit_progress(&app,&document_id,"chunking",0,doc.chunk_count as usize,"已恢复原文，正在重建索引");enrich_document(&app,&workspace,&document_id,config).await
}

#[tauri::command]
pub async fn knowledge_import_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String,config:ModelConfig)->Result<KnowledgeDocument,String>{
    let source=PathBuf::from(&source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;
    fs::create_dir_all(&workspace.history_dir).map_err(|e|e.to_string())?;
    let history=PathBuf::from(&workspace.history_dir);
    let destination=if source.starts_with(&history){source}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};
    if destination!=PathBuf::from(&source_path){fs::write(&destination,&content).map_err(|e|e.to_string())?;}
    let title=destination.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let location=destination.to_string_lossy().to_string();let id={let db=knowledge_db(&workspace)?;document_id_for_location(&db,&location)?};
    emit_progress(&app,&id,"parsing",0,1,"正在解析 Markdown");let doc=store_document(&workspace,"markdown",&location,None,title,&content)?;
    enrich_document(&app,&workspace,&doc.id,config).await
}

#[tauri::command]
pub async fn knowledge_index_pending(app:AppHandle,workspace:WorkspacePaths,paths:Vec<String>,config:ModelConfig)->Result<Vec<KnowledgeDocument>,String>{
    let mut result=Vec::new();for path in paths{result.push(knowledge_import_markdown(app.clone(),workspace.clone(),path,ModelConfig{base_url:config.base_url.clone(),api_key:config.api_key.clone(),model:config.model.clone(),timeout_ms:config.timeout_ms,headers:config.headers.clone()}).await?);}Ok(result)
}

#[tauri::command]
pub fn knowledge_list(workspace:WorkspacePaths)->Result<Vec<KnowledgeDocument>,String>{
    let db=knowledge_db(&workspace)?;let mut stmt=db.prepare("SELECT id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,structure_status FROM knowledge_documents ORDER BY updated_at DESC,title").map_err(|e|e.to_string())?;
    let result=stmt.query_map([],|r|Ok(KnowledgeDocument{id:r.get(0)?,source_type:r.get(1)?,title:r.get(2)?,location:r.get(3)?,source_url:r.get(4)?,fingerprint:r.get(5)?,status:r.get(6)?,error:r.get(7)?,section_count:r.get(8)?,chunk_count:r.get(9)?,updated_at:r.get(10)?,structure_status:r.get(11)?})).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn knowledge_sections(workspace:WorkspacePaths,document_id:String)->Result<Vec<KnowledgeSection>,String>{
    let db=knowledge_db(&workspace)?;let mut stmt=db.prepare("SELECT id,document_id,parent_id,title,heading_path,level,position,summary,chunk_count,heading_source,original_line,confidence FROM knowledge_sections WHERE document_id=?1 ORDER BY position").map_err(|e|e.to_string())?;
    let result=stmt.query_map([document_id],|r|Ok(KnowledgeSection{id:r.get(0)?,document_id:r.get(1)?,parent_id:r.get(2)?,title:r.get(3)?,heading_path:r.get(4)?,level:r.get(5)?,position:r.get(6)?,summary:r.get(7)?,chunk_count:r.get(8)?,heading_source:r.get(9)?,original_line:r.get(10)?,confidence:r.get(11)?})).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?;
    Ok(result)
}

fn chunk_from_row(r:&rusqlite::Row<'_>)->rusqlite::Result<KnowledgeChunk>{Ok(KnowledgeChunk{id:r.get(0)?,document_id:r.get(1)?,section_id:r.get(2)?,document_title:r.get(3)?,heading_path:r.get(4)?,content:r.get(5)?,summary:r.get(6)?,keywords:serde_json::from_str::<Vec<String>>(&r.get::<_,String>(7)?).unwrap_or_default(),position:r.get(8)?,start_char:r.get(9)?,end_char:r.get(10)?,status:r.get(11)?,quality:r.get(12)?})}

#[tauri::command]
pub fn knowledge_search(workspace:WorkspacePaths,query:String,limit:Option<usize>,qualities:Option<Vec<String>>)->Result<Vec<KnowledgeSearchResult>,String>{
    let db=knowledge_db(&workspace)?;let trimmed=query.trim();if trimmed.is_empty(){return Ok(Vec::new());}let tokens=segmented(trimmed).split_whitespace().map(|x|format!("\"{}\"",x.replace('\"',""))).collect::<Vec<_>>().join(" AND ");
    let qualities=qualities.unwrap_or_else(||vec!["good".into(),"normal".into()]);let include_good=qualities.iter().any(|x|x=="good");let include_normal=qualities.iter().any(|x|x=="normal");let include_bad=qualities.iter().any(|x|x=="bad");
    let sql="SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.summary,c.keywords,c.position,c.start_char,c.end_char,c.status,c.quality,(bm25(knowledge_chunk_fts)-CASE WHEN c.heading_path LIKE '%'||?2||'%' THEN 5.0 ELSE 0 END-CASE WHEN c.content LIKE '%'||?2||'%' THEN 2.0 ELSE 0 END) AS score FROM knowledge_chunk_fts JOIN knowledge_chunks c ON c.id=knowledge_chunk_fts.chunk_id JOIN knowledge_documents d ON d.id=c.document_id WHERE knowledge_chunk_fts MATCH ?1 AND ((?3 AND c.quality='good') OR (?4 AND c.quality='normal') OR (?5 AND c.quality='bad')) ORDER BY CASE c.quality WHEN 'good' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,score,c.position LIMIT ?6";
    let mut stmt=db.prepare(sql).map_err(|e|e.to_string())?;let rows=stmt.query_map(params![tokens,trimmed,include_good,include_normal,include_bad,limit.unwrap_or(30).min(100) as i64],|r|{let chunk=chunk_from_row(r)?;let raw=chunk.content.replace('\n'," ");let excerpt=raw.chars().take(220).collect();Ok(KnowledgeSearchResult{chunk,excerpt,score:r.get(13)?})}).map_err(|e|e.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|e|e.to_string())
}

#[tauri::command]
pub fn knowledge_chunk(workspace:WorkspacePaths,chunk_id:String)->Result<KnowledgeChunk,String>{
    let db=knowledge_db(&workspace)?;db.query_row("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.summary,c.keywords,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.id=?1",[chunk_id],chunk_from_row).map_err(|e|e.to_string())
}

#[tauri::command]
pub fn knowledge_set_chunk_quality(workspace:WorkspacePaths,chunk_id:String,quality:String)->Result<KnowledgeChunk,String>{
    if !matches!(quality.as_str(),"good"|"normal"|"bad"){return Err("片段质量状态无效".into());}
    let db=knowledge_db(&workspace)?;let changed=db.execute("UPDATE knowledge_chunks SET quality=?2 WHERE id=?1",params![chunk_id,quality]).map_err(|e|e.to_string())?;if changed==0{return Err("知识片段不存在".into());}drop(db);knowledge_chunk(workspace,chunk_id)
}

#[tauri::command]
pub fn knowledge_section_chunks(workspace:WorkspacePaths,section_id:String)->Result<Vec<KnowledgeChunk>,String>{
    let db=knowledge_db(&workspace)?;
    let mut stmt=db.prepare("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.summary,c.keywords,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunk_sections m JOIN knowledge_chunks c ON c.id=m.chunk_id JOIN knowledge_documents d ON d.id=c.document_id WHERE m.section_id=?1 ORDER BY c.position").map_err(|e|e.to_string())?;
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
    let indexed_id=if let Some(requested)=document_id.as_ref(){let indexed_path:String=db.query_row("SELECT location FROM knowledge_documents WHERE id=?1",[requested],|r|r.get(0)).map_err(|e|e.to_string())?;let canonical_indexed=fs::canonicalize(indexed_path).map_err(|e|e.to_string())?;if canonical_indexed!=target{return Err("文档索引与文件不匹配".into());}Some(requested.clone())}else{find_document_by_location(&db,target.to_string_lossy().as_ref())?.map(|(id,_)|id)};
    fs::remove_file(&target).map_err(|e|format!("删除知识文档失败: {e}"))?;
    if let Some(id)=indexed_id{db.execute("DELETE FROM knowledge_chunk_fts WHERE chunk_id IN(SELECT id FROM knowledge_chunks WHERE document_id=?1)",[&id]).map_err(|e|e.to_string())?;db.execute("DELETE FROM knowledge_documents WHERE id=?1",[id]).map_err(|e|e.to_string())?;}
    Ok(())
}

#[tauri::command]
pub async fn knowledge_retry_enrichment(app:AppHandle,workspace:WorkspacePaths,document_id:String,config:ModelConfig)->Result<KnowledgeDocument,String>{let db=knowledge_db(&workspace)?;db.execute("UPDATE knowledge_chunks SET status='pending' WHERE document_id=?1 AND status!='ready'",[&document_id]).map_err(|e|e.to_string())?;drop(db);enrich_document(&app,&workspace,&document_id,config).await}

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
pub async fn knowledge_import_web(app:AppHandle,workspace:WorkspacePaths,url:String,config:ModelConfig)->Result<KnowledgeDocument,String>{
    let (title,body)=fetch_web_markdown(&url).await?;let dir=PathBuf::from(&workspace.history_dir).join("web");fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let existing_location={let db=knowledge_db(&workspace)?;db.query_row("SELECT location FROM knowledge_documents WHERE source_url=?1",[&url],|r|r.get::<_,String>(0)).optional().map_err(|e|e.to_string())?};
    let destination=existing_location.map(PathBuf::from).unwrap_or_else(||unique_destination(&dir,&safe_markdown_name(&title)));let markdown=format!("---\nsourceUrl: {}\nfetchedAt: {}\n---\n\n# {}\n\n{}",url,now_string(),title,body);fs::write(&destination,&markdown).map_err(|e|e.to_string())?;
    let location=destination.to_string_lossy().to_string();let doc=store_document(&workspace,"web",&location,Some(&url),&title,&markdown)?;emit_progress(&app,&doc.id,"chunking",0,doc.chunk_count as usize,"网页正文已提取");enrich_document(&app,&workspace,&doc.id,config).await
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
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let regular=source.to_string_lossy();let verbatim=format!(r"\\?\{regular}");store_document(&workspace,"markdown",&verbatim,None,"文档",markdown).unwrap();let scanned=knowledge_scan(workspace).unwrap();assert_eq!(scanned.len(),1);assert_eq!(scanned[0].state,"indexed");let _=fs::remove_dir_all(root);
 }
 #[test] fn parses_tree_and_ignores_fenced_headings(){let s=parse_sections("d","Doc","intro\n# A\nbody\n```md\n# fake\n```\n### C\ntext");assert_eq!(s.len(),3);assert_eq!(s[1].title,"A");assert_eq!(s[2].path,"A > C");}
 #[test] fn does_not_create_empty_preamble_but_keeps_empty_heading(){let s=parse_sections("d","Doc","# A\n## Empty\n");assert_eq!(s.len(),2);assert_eq!(s[0].title,"A");assert_eq!(s[1].title,"Empty");}
 #[test] fn chunks_with_overlap(){let body=(0..13000).map(|i|if i%80==0{'\n'}else{'中'}).collect::<String>();let s=ParsedSection{id:"s".into(),parent_id:None,title:"T".into(),path:"T".into(),level:1,position:0,body};let c=split_section("d",&s);assert!(c.len()>=3);assert_eq!(c[1].start_char,c[0].end_char-CHUNK_OVERLAP_CHARS);}
 #[test] fn merges_many_small_leaf_sections_into_few_chunks(){let mut markdown="# 第一章\n\n## 功能设计\n\n".to_string();for i in 0..80{markdown.push_str(&format!("### 1.1.{i} 功能{i}\n\n{}\n\n","业务说明".repeat(20)));}let sections=parse_sections("d","Doc",&markdown);assert!(sections.len()>80);let chunks=build_document_chunks("d",&sections);assert!(chunks.len()<10,"unexpected chunk count: {}",chunks.len());assert!(chunks.iter().all(|chunk|chunk.content.chars().count()<=MAX_CHUNK_CHARS));assert!(chunks.iter().any(|chunk|chunk.section_ids.len()>10));}
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
   let hits=knowledge_search(workspace.clone(),"幂等".into(),Some(10),None).unwrap();assert_eq!(hits.len(),1);assert!(hits[0].chunk.content.contains("重复扣款"));let chunk_id=hits[0].chunk.id.clone();knowledge_set_chunk_quality(workspace.clone(),chunk_id.clone(),"bad".into()).unwrap();assert!(knowledge_search(workspace.clone(),"幂等".into(),Some(10),None).unwrap().is_empty());assert_eq!(knowledge_search(workspace.clone(),"幂等".into(),Some(10),Some(vec!["bad".into()])).unwrap().len(),1);knowledge_set_chunk_quality(workspace.clone(),chunk_id,"good".into()).unwrap();knowledge_remove(workspace.clone(),first.id).unwrap();assert!(source.exists());assert!(knowledge_list(workspace.clone()).unwrap().is_empty());let restored=store_document(&workspace,"markdown",&location,None,"支付方案",markdown).unwrap();knowledge_delete_file(workspace.clone(),location,Some(restored.id)).unwrap();assert!(!source.exists());assert!(knowledge_list(workspace).unwrap().is_empty());let _=fs::remove_dir_all(root);
 }
}
