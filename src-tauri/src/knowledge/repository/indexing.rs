use super::{document_id_for_location, knowledge_db, storage_location};
use crate::knowledge::parser::{build_document_chunks, parse_sections, segmented};
use crate::knowledge::{
    hash_text, now_string, KnowledgeDocument, WorkspacePaths, CHUNKING_VERSION, MAX_CHUNK_CHARS,
};
use rusqlite::{params, OptionalExtension};
use std::collections::BTreeMap;

fn load_document(db: &rusqlite::Connection, id: &str) -> Result<Option<KnowledgeDocument>, String> {
    db.query_row(
        "SELECT d.id,d.source_type,d.title,d.location,d.source_url,d.fingerprint,d.status,d.error,d.section_count,d.chunk_count,d.updated_at,d.structure_status,COALESCE((SELECT SUM(LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(c.content,' ',''),char(9),''),char(10),''),char(13),''))) FROM knowledge_chunks c WHERE c.document_id=d.id),0),d.category_id FROM knowledge_documents d WHERE d.id=?1",
        [id],
        |row| {
            Ok(KnowledgeDocument {
                id: row.get(0)?,
                source_type: row.get(1)?,
                title: row.get(2)?,
                location: row.get(3)?,
                source_url: row.get(4)?,
                fingerprint: row.get(5)?,
                status: row.get(6)?,
                error: row.get(7)?,
                section_count: row.get(8)?,
                chunk_count: row.get(9)?,
                updated_at: row.get(10)?,
                structure_status: row.get(11)?,
                char_count: row.get(12)?,
                category_id: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub(in crate::knowledge) fn index_document<F>(
    workspace: &WorkspacePaths,
    source_type: &str,
    location: &str,
    source_url: Option<&str>,
    title: &str,
    markdown: &str,
    progress: F,
) -> Result<KnowledgeDocument, String>
where
    F: FnMut(&str, &str, usize, usize, &str),
{
    index_document_with_source(
        workspace,
        source_type,
        location,
        source_url,
        title,
        markdown,
        markdown,
        progress,
    )
}

pub(in crate::knowledge) fn index_document_with_source<F>(
    workspace: &WorkspacePaths,
    source_type: &str,
    location: &str,
    source_url: Option<&str>,
    title: &str,
    source_markdown: &str,
    index_markdown: &str,
    mut progress: F,
) -> Result<KnowledgeDocument, String>
where
    F: FnMut(&str, &str, usize, usize, &str),
{
    let mut db = knowledge_db(workspace)?;
    let fingerprint = hash_text(source_markdown);
    let location = storage_location(workspace, location);
    let id = document_id_for_location(&db, &location)?;
    if let Some(existing) = load_document(&db, &id)? {
        let version = db
            .query_row(
                "SELECT chunking_version FROM knowledge_documents WHERE id=?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(1);
        if source_markdown == index_markdown
            && existing.fingerprint == fingerprint
            && version >= CHUNKING_VERSION
        {
            progress(
                &id,
                "index_unchanged",
                1,
                1,
                "内容没有变化，现有索引仍然有效",
            );
            return Ok(existing);
        }
    }

    progress(&id, "index_parsing", 0, 0, "正在解析 Markdown 章节…");
    let sections = parse_sections(&id, title, index_markdown);
    progress(
        &id,
        "index_chunking",
        0,
        0,
        &format!("正在根据 {} 个章节生成知识切片…", sections.len()),
    );
    let chunks = build_document_chunks(&id, &sections);
    let existing_quality: BTreeMap<String, String> = {
        let mut stmt = db
            .prepare("SELECT id,quality FROM knowledge_chunks WHERE document_id=?1")
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_map([&id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        result
    };
    progress(
        &id,
        "index_writing",
        0,
        chunks.len(),
        &format!("正在写入 {} 个知识切片…", chunks.len()),
    );

    let segmented_title = segmented(title);
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM knowledge_chunk_fts WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?1)",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO knowledge_documents(id,source_type,title,location,source_url,fingerprint,status,error,section_count,chunk_count,updated_at,chunking_version)
         VALUES(?1,?2,?3,?4,?5,?6,'ready',NULL,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET source_type=excluded.source_type,title=excluded.title,location=excluded.location,source_url=excluded.source_url,fingerprint=excluded.fingerprint,status=excluded.status,error=NULL,section_count=excluded.section_count,chunk_count=excluded.chunk_count,updated_at=excluded.updated_at,chunking_version=excluded.chunking_version",
        params![
            id,
            source_type,
            title,
            location,
            source_url,
            fingerprint,
            sections.len() as i64,
            chunks.len() as i64,
            now_string(),
            CHUNKING_VERSION
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM knowledge_sections WHERE document_id=?1", [&id])
        .map_err(|e| e.to_string())?;
    for section in &sections {
        let count = chunks
            .iter()
            .filter(|chunk| chunk.section_ids.contains(&section.id))
            .count();
        tx.execute(
            "INSERT INTO knowledge_sections(id,document_id,parent_id,title,heading_path,level,position,summary,chunk_count) VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8)",
            params![
                section.id,
                id,
                section.parent_id,
                section.title,
                section.path,
                section.level as i64,
                section.position as i64,
                count as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let search_text = segmented(&format!("{} {}", chunk.heading_path, chunk.content));
        let quality = existing_quality
            .get(&chunk.id)
            .map(String::as_str)
            .unwrap_or("normal");
        tx.execute(
            "INSERT INTO knowledge_chunks(id,document_id,section_id,heading_path,content,search_text,position,start_char,end_char,fingerprint,status,quality) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'ready',?11)",
            params![
                chunk.id,
                id,
                chunk.section_id,
                chunk.heading_path,
                chunk.content,
                search_text,
                chunk.position as i64,
                chunk.start_char as i64,
                chunk.end_char as i64,
                hash_text(&chunk.content),
                quality
            ],
        )
        .map_err(|e| e.to_string())?;
        for section_id in &chunk.section_ids {
            tx.execute(
                "INSERT INTO knowledge_chunk_sections(chunk_id,section_id) VALUES(?1,?2)",
                params![chunk.id, section_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO knowledge_chunk_fts(chunk_id,document_title,title_path,body) VALUES(?1,?2,?3,?4)",
            params![
                chunk.id,
                segmented_title,
                segmented(&chunk.heading_path),
                segmented(&chunk.content)
            ],
        )
        .map_err(|e| e.to_string())?;
        if chunk_index % 10 == 9 || chunk_index + 1 == chunks.len() {
            progress(
                &id,
                "index_writing",
                chunk_index + 1,
                chunks.len(),
                &format!("正在写入知识切片 {}/{}…", chunk_index + 1, chunks.len()),
            );
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    if source_type == "markdown"
        && sections.len() <= 1
        && source_markdown.chars().count() > MAX_CHUNK_CHARS
    {
        db.execute(
            "UPDATE knowledge_documents SET structure_status='review_recommended' WHERE id=?1 AND structure_status!='confirmed'",
            [&id],
        )
        .map_err(|e| e.to_string())?;
    }
    load_document(&db, &id)?.ok_or_else(|| "知识文档写入失败".into())
}
