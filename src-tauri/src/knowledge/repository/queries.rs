use super::{find_document_by_location, knowledge_db};
use crate::knowledge::parser::segmented;
use crate::knowledge::{
    KnowledgeChunk, KnowledgeDocument, KnowledgeSearchResult, KnowledgeSection,
    KnowledgeSectionScope, WorkspacePaths,
};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, OptionalExtension, Row};
use std::collections::{HashMap, HashSet};

fn chunk_from_row(row: &Row<'_>) -> rusqlite::Result<KnowledgeChunk> {
    Ok(KnowledgeChunk {
        id: row.get(0)?,
        document_id: row.get(1)?,
        section_id: row.get(2)?,
        document_title: row.get(3)?,
        heading_path: row.get(4)?,
        content: row.get(5)?,
        position: row.get(6)?,
        start_char: row.get(7)?,
        end_char: row.get(8)?,
        status: row.get(9)?,
        quality: row.get(10)?,
    })
}

fn valid_quality(quality: &str) -> Result<(), String> {
    if matches!(quality, "good" | "normal" | "bad") {
        Ok(())
    } else {
        Err("片段质量状态无效".into())
    }
}

fn search_tokens(query: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "请", "请问", "帮", "帮我", "我", "一下", "查", "查询", "检索", "搜索", "找", "查找",
        "如何", "怎么", "怎样", "什么", "哪些", "哪个", "是否", "能否", "可以", "需要", "保障",
        "保证", "实现", "采用", "关于", "有关", "相关", "方面", "内容", "资料", "信息", "方案",
        "说明", "介绍", "的", "了", "和", "与", "或", "及", "以及", "并", "在", "对", "中", "为",
        "是",
    ];
    let mut tokens: Vec<String> = Vec::new();
    for token in segmented(query).split_whitespace() {
        let token = token
            .trim_matches(|character: char| {
                character.is_whitespace()
                    || character.is_ascii_punctuation()
                    || "，。！？；：、（）【】《》“”‘’".contains(character)
            })
            .replace('"', "");
        if !token.is_empty()
            && !STOP_WORDS.contains(&token.as_str())
            && !tokens
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&token))
        {
            tokens.push(token);
            if tokens.len() == 8 {
                break;
            }
        }
    }
    tokens
}

fn match_expression(columns: &[&str], tokens: &[String], joiner: &str) -> String {
    tokens
        .iter()
        .map(|token| {
            let alternatives = columns
                .iter()
                .map(|column| format!("{column} : (\"{token}\")"))
                .collect::<Vec<_>>()
                .join(" OR ");
            format!("({alternatives})")
        })
        .collect::<Vec<_>>()
        .join(joiner)
}

fn search_excerpt(content: &str, tokens: &[String]) -> String {
    let chars = content.chars().collect::<Vec<_>>();
    let match_char = tokens
        .iter()
        .filter_map(|token| {
            content
                .find(token)
                .map(|byte| content[..byte].chars().count())
        })
        .min()
        .unwrap_or(0);
    let start = match_char.saturating_sub(70);
    let end = (start + 220).min(chars.len());
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    format!(
        "{prefix}{}{suffix}",
        chars[start..end]
            .iter()
            .collect::<String>()
            .replace('\n', " ")
    )
}

fn token_match_score(result: &KnowledgeSearchResult, tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return 0.0;
    }
    let document = result.chunk.document_title.to_lowercase();
    let heading = result.chunk.heading_path.to_lowercase();
    let content = result.chunk.content.to_lowercase();
    let mut matched = 0usize;
    let mut field_bonus = 0.0;
    for token in tokens {
        let token = token.to_lowercase();
        let in_document = document.contains(&token);
        let in_heading = heading.contains(&token);
        let in_content = content.contains(&token);
        if in_document || in_heading || in_content {
            matched += 1;
        }
        if in_document {
            field_bonus += 1.2;
        }
        if in_heading {
            field_bonus += 1.0;
        }
        if in_content {
            field_bonus += 0.2;
        }
    }
    let coverage = matched as f64 / tokens.len() as f64;
    coverage * 2.0 + field_bonus
}

pub(in crate::knowledge) fn classify_documents(
    workspace: &WorkspacePaths,
    candidates: &[(String, String)],
    current_chunking_version: i64,
) -> Result<Vec<(String, Option<String>)>, String> {
    let db = knowledge_db(workspace)?;
    candidates
        .iter()
        .map(|(location, fingerprint)| {
            let existing = find_document_by_location(&db, location)?;
            let (state, document_id) = match existing {
                None => ("unindexed", None),
                Some((id, stored_fingerprint)) if stored_fingerprint != *fingerprint => {
                    ("changed", Some(id))
                }
                Some((id, _)) => {
                    let version = db
                        .query_row(
                            "SELECT chunking_version FROM knowledge_documents WHERE id=?1",
                            [&id],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap_or(1);
                    if version < current_chunking_version {
                        ("changed", Some(id))
                    } else {
                        ("indexed", Some(id))
                    }
                }
            };
            Ok((state.into(), document_id))
        })
        .collect()
}

pub(in crate::knowledge) fn document_location(
    workspace: &WorkspacePaths,
    document_id: &str,
) -> Result<String, String> {
    let db = knowledge_db(workspace)?;
    db.query_row(
        "SELECT location FROM knowledge_documents WHERE id=?1",
        [document_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(in crate::knowledge) fn source_location(
    workspace: &WorkspacePaths,
    source_url: &str,
) -> Result<Option<String>, String> {
    let db = knowledge_db(workspace)?;
    db.query_row(
        "SELECT location FROM knowledge_documents WHERE source_url=?1",
        [source_url],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub(in crate::knowledge) fn list_documents(
    workspace: &WorkspacePaths,
) -> Result<Vec<KnowledgeDocument>, String> {
    let db = knowledge_db(workspace)?;
    let mut stmt = db
        .prepare("SELECT d.id,d.source_type,d.title,d.location,d.source_url,d.fingerprint,d.status,d.error,d.section_count,d.chunk_count,d.updated_at,d.structure_status,COALESCE((SELECT SUM(LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(c.content,' ',''),char(9),''),char(10),''),char(13),''))) FROM knowledge_chunks c WHERE c.document_id=d.id),0) FROM knowledge_documents d ORDER BY d.updated_at DESC,d.title")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([], |row| {
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
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

pub(in crate::knowledge) fn list_sections(
    workspace: &WorkspacePaths,
    document_id: &str,
) -> Result<Vec<KnowledgeSection>, String> {
    let db = knowledge_db(workspace)?;
    let mut stmt = db
        .prepare("SELECT s.id,s.document_id,s.parent_id,s.title,s.heading_path,s.level,s.position,s.chunk_count,s.heading_source,s.original_line,s.confidence,COALESCE((SELECT c.quality FROM knowledge_chunks c JOIN knowledge_chunk_sections m ON m.chunk_id=c.id WHERE m.section_id=s.id ORDER BY c.position LIMIT 1),'normal'),COALESCE((SELECT SUM(LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(c.content,' ',''),char(9),''),char(10),''),char(13),''))) FROM knowledge_chunks c JOIN knowledge_chunk_sections m ON m.chunk_id=c.id WHERE m.section_id=s.id),0) FROM knowledge_sections s WHERE s.document_id=?1 ORDER BY s.position")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([document_id], |row| {
            Ok(KnowledgeSection {
                id: row.get(0)?,
                document_id: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                heading_path: row.get(4)?,
                level: row.get(5)?,
                position: row.get(6)?,
                chunk_count: row.get(7)?,
                heading_source: row.get(8)?,
                original_line: row.get(9)?,
                confidence: row.get(10)?,
                quality: row.get(11)?,
                char_count: row.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

pub(in crate::knowledge) fn search(
    workspace: &WorkspacePaths,
    query: &str,
    limit: Option<usize>,
    qualities: Option<Vec<String>>,
    fields: Option<Vec<String>>,
    document_ids: Option<Vec<String>>,
) -> Result<Vec<KnowledgeSearchResult>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let query_tokens = search_tokens(trimmed);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }
    let requested = fields.unwrap_or_else(|| {
        vec![
            "documentTitle".into(),
            "headingPath".into(),
            "content".into(),
        ]
    });
    let columns = requested
        .iter()
        .filter_map(|field| match field.as_str() {
            "documentTitle" => Some("document_title"),
            "headingPath" => Some("title_path"),
            "content" => Some("body"),
            _ => None,
        })
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let strict_match = match_expression(&columns, &query_tokens, " AND ");
    let relaxed_match = match_expression(&columns, &query_tokens, " OR ");
    let qualities = qualities.unwrap_or_else(|| vec!["good".into(), "normal".into()]);
    let include_good = qualities.iter().any(|quality| quality == "good");
    let include_normal = qualities.iter().any(|quality| quality == "normal");
    let include_bad = qualities.iter().any(|quality| quality == "bad");
    let document_ids = document_ids
        .unwrap_or_default()
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let document_filter = if document_ids.is_empty() {
        String::new()
    } else {
        let placeholders = (0..document_ids.len())
            .map(|index| format!("?{}", index + 7))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" AND d.id IN ({placeholders})")
    };
    let db = knowledge_db(workspace)?;
    let requested_limit = limit.unwrap_or(30).min(100);
    let candidate_limit = requested_limit.saturating_mul(4).clamp(20, 100);
    let sql = format!("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality,(bm25(knowledge_chunk_fts,0.0,8.0,6.0,2.0)-CASE WHEN d.title LIKE '%'||?2||'%' THEN 8.0 ELSE 0 END-CASE WHEN c.heading_path LIKE '%'||?2||'%' THEN 5.0 ELSE 0 END-CASE WHEN c.content LIKE '%'||?2||'%' THEN 2.0 ELSE 0 END+CASE c.quality WHEN 'good' THEN -0.6 WHEN 'bad' THEN 2.5 ELSE 0.0 END) AS score,s.level,s.parent_id FROM knowledge_chunk_fts JOIN knowledge_chunks c ON c.id=knowledge_chunk_fts.chunk_id JOIN knowledge_documents d ON d.id=c.document_id JOIN knowledge_sections s ON s.id=c.section_id WHERE knowledge_chunk_fts MATCH ?1 AND ((?3 AND c.quality='good') OR (?4 AND c.quality='normal') OR (?5 AND c.quality='bad')){document_filter} ORDER BY score,c.position LIMIT ?6");
    let run =
        |expression: &str, stage_penalty: f64| -> Result<Vec<KnowledgeSearchResult>, String> {
            let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
            let mut bind_values: Vec<Value> = vec![
                Value::Text(expression.to_string()),
                Value::Text(trimmed.to_string()),
                Value::Integer(include_good as i64),
                Value::Integer(include_normal as i64),
                Value::Integer(include_bad as i64),
                Value::Integer(candidate_limit as i64),
            ];
            bind_values.extend(document_ids.iter().cloned().map(Value::Text));
            let rows = stmt
                .query_map(params_from_iter(bind_values), |row| {
                    let chunk = chunk_from_row(row)?;
                    let excerpt = search_excerpt(&chunk.content, &query_tokens);
                    let matched_section_id = chunk.section_id.clone();
                    let level: i64 = row.get(12)?;
                    let parent_id: Option<String> = row.get(13)?;
                    let mut result = KnowledgeSearchResult {
                        chunk,
                        excerpt,
                        score: row.get(11)?,
                        scope_section_id: matched_section_id.clone(),
                        matched_section_id,
                        level,
                        can_move_up: level > 1 && parent_id.is_some(),
                        parent_id,
                    };
                    result.score += stage_penalty - token_match_score(&result, &query_tokens);
                    Ok(result)
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
        };

    let finish = |mut results: Vec<KnowledgeSearchResult>| {
        results.sort_by(|left, right| {
            left.score
                .total_cmp(&right.score)
                .then_with(|| left.chunk.position.cmp(&right.chunk.position))
        });
        results.truncate(requested_limit);
        results
    };
    let strict = run(&strict_match, 0.0)?;
    if !strict.is_empty() || strict_match == relaxed_match {
        return Ok(finish(strict));
    }

    if (3..=8).contains(&query_tokens.len()) {
        let mut seen_expressions = HashSet::new();
        let mut merged = HashMap::<String, KnowledgeSearchResult>::new();
        for omitted in 0..query_tokens.len() {
            let subset = query_tokens
                .iter()
                .enumerate()
                .filter(|(index, _)| *index != omitted)
                .map(|(_, token)| token.clone())
                .collect::<Vec<_>>();
            let expression = match_expression(&columns, &subset, " AND ");
            if !seen_expressions.insert(expression.clone()) {
                continue;
            }
            for result in run(&expression, 0.75)? {
                match merged.get_mut(&result.chunk.id) {
                    Some(existing) if result.score < existing.score => *existing = result,
                    None => {
                        merged.insert(result.chunk.id.clone(), result);
                    }
                    _ => {}
                }
            }
        }
        if !merged.is_empty() {
            return Ok(finish(merged.into_values().collect()));
        }
    }
    Ok(finish(run(&relaxed_match, 2.5)?))
}

pub(in crate::knowledge) fn section_scope(
    workspace: &WorkspacePaths,
    section_id: &str,
) -> Result<KnowledgeSectionScope, String> {
    let db = knowledge_db(workspace)?;
    let (document_id, parent_id, title, heading_path, level, position, document_title, quality): (
        String,
        Option<String>,
        String,
        String,
        i64,
        i64,
        String,
        String,
    ) = db
        .query_row(
            "SELECT s.document_id,s.parent_id,s.title,s.heading_path,s.level,s.position,d.title,COALESCE(c.quality,'normal') FROM knowledge_sections s JOIN knowledge_documents d ON d.id=s.document_id LEFT JOIN knowledge_chunks c ON c.section_id=s.id WHERE s.id=?1",
            [section_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .map_err(|e| e.to_string())?;
    if level < 1 {
        return Err("文档根节点不能作为章节范围".into());
    }
    let mut stmt = db
        .prepare("SELECT s.title,s.level,c.content FROM knowledge_sections s LEFT JOIN knowledge_chunks c ON c.section_id=s.id WHERE s.document_id=?1 AND s.position>=?2 ORDER BY s.position")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![document_id, position], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut markdown = String::new();
    let mut section_count = 0;
    for row in rows {
        let (row_title, row_level, body) = row.map_err(|e| e.to_string())?;
        if section_count > 0 && row_level <= level {
            break;
        }
        if !markdown.is_empty() {
            markdown.push_str("\n\n");
        }
        markdown.push_str(&format!(
            "{} {}",
            "#".repeat(row_level.clamp(1, 6) as usize),
            row_title
        ));
        if !body.trim().is_empty() {
            markdown.push_str("\n\n");
            markdown.push_str(body.trim());
        }
        section_count += 1;
    }
    Ok(KnowledgeSectionScope {
        id: format!("kscope:{section_id}"),
        document_id,
        document_title,
        section_id: section_id.into(),
        parent_id: parent_id.clone(),
        title,
        heading_path,
        level,
        content: markdown,
        section_count,
        quality,
        can_move_up: level > 1 && parent_id.is_some(),
    })
}

pub(in crate::knowledge) fn chunk(
    workspace: &WorkspacePaths,
    chunk_id: &str,
) -> Result<KnowledgeChunk, String> {
    let db = knowledge_db(workspace)?;
    db.query_row(
        "SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.id=?1",
        [chunk_id],
        chunk_from_row,
    )
    .map_err(|e| e.to_string())
}

pub(in crate::knowledge) fn set_chunk_quality(
    workspace: &WorkspacePaths,
    chunk_id: &str,
    quality: &str,
) -> Result<KnowledgeChunk, String> {
    valid_quality(quality)?;
    let db = knowledge_db(workspace)?;
    let changed = db
        .execute(
            "UPDATE knowledge_chunks SET quality=?2 WHERE id=?1",
            params![chunk_id, quality],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("知识片段不存在".into());
    }
    drop(db);
    chunk(workspace, chunk_id)
}

pub(in crate::knowledge) fn section_chunks(
    workspace: &WorkspacePaths,
    section_id: &str,
) -> Result<Vec<KnowledgeChunk>, String> {
    let db = knowledge_db(workspace)?;
    let mut stmt = db
        .prepare("SELECT c.id,c.document_id,c.section_id,d.title,c.heading_path,c.content,c.position,c.start_char,c.end_char,c.status,c.quality FROM knowledge_chunk_sections m JOIN knowledge_chunks c ON c.id=m.chunk_id JOIN knowledge_documents d ON d.id=c.document_id WHERE m.section_id=?1 ORDER BY c.position")
        .map_err(|e| e.to_string())?;
    let result = stmt
        .query_map([section_id], chunk_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

pub(in crate::knowledge) fn set_section_quality(
    workspace: &WorkspacePaths,
    section_id: &str,
    quality: &str,
) -> Result<String, String> {
    valid_quality(quality)?;
    let db = knowledge_db(workspace)?;
    let changed = db
        .execute(
            "UPDATE knowledge_chunks SET quality=?2 WHERE section_id=?1",
            params![section_id, quality],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("该章节没有独立知识片段，请重新识别文档".into());
    }
    Ok(quality.into())
}

pub(in crate::knowledge) fn remove_document(
    workspace: &WorkspacePaths,
    document_id: &str,
) -> Result<(), String> {
    let db = knowledge_db(workspace)?;
    db.execute(
        "DELETE FROM knowledge_chunk_fts WHERE chunk_id IN(SELECT id FROM knowledge_chunks WHERE document_id=?1)",
        [document_id],
    )
    .map_err(|e| e.to_string())?;
    db.execute("DELETE FROM knowledge_documents WHERE id=?1", [document_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(in crate::knowledge) fn find_document_id(
    workspace: &WorkspacePaths,
    location: &str,
) -> Result<Option<String>, String> {
    let db = knowledge_db(workspace)?;
    Ok(find_document_by_location(&db, location)?.map(|(id, _)| id))
}

pub(in crate::knowledge) fn document_id(
    workspace: &WorkspacePaths,
    location: &str,
) -> Result<String, String> {
    let db = knowledge_db(workspace)?;
    super::document_id_for_location(&db, location)
}

pub(in crate::knowledge) fn save_heading_metadata(
    workspace: &WorkspacePaths,
    document_id: &str,
    decisions: &[crate::knowledge::HeadingReviewDecision],
    original: &str,
    normalized: &str,
    status: &str,
) -> Result<(), String> {
    use crate::knowledge::{hash_text, headings::normalized_heading_text};

    let db = knowledge_db(workspace)?;
    db.execute(
        "UPDATE knowledge_documents SET structure_status=?2,original_fingerprint=?3,normalized_fingerprint=?4 WHERE id=?1",
        params![document_id, status, hash_text(original), hash_text(normalized)],
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id,title FROM knowledge_sections WHERE document_id=?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    let sections = stmt
        .query_map([document_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut used = vec![false; decisions.len()];
    for (section_id, title) in sections {
        let normalized_title = normalized_heading_text(&title);
        if let Some((index, decision)) = decisions.iter().enumerate().find(|(index, decision)| {
            !used[*index]
                && decision.selected
                && original
                    .lines()
                    .nth(decision.line)
                    .map(normalized_heading_text)
                    .as_deref()
                    == Some(normalized_title.as_str())
        }) {
            used[index] = true;
            db.execute(
                "UPDATE knowledge_sections SET heading_source=?2,original_line=?3,confidence=?4 WHERE id=?1",
                params![section_id, decision.source, decision.line as i64 + 1, decision.confidence],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(in crate::knowledge) fn mark_document_restored(
    workspace: &WorkspacePaths,
    document_id: &str,
    original_fingerprint: &str,
) -> Result<(), String> {
    let db = knowledge_db(workspace)?;
    db.execute(
        "UPDATE knowledge_documents SET structure_status='review_recommended',original_fingerprint=?2,normalized_fingerprint=NULL WHERE id=?1",
        params![document_id, original_fingerprint],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
pub(in crate::knowledge) fn replace_document_location(
    workspace: &WorkspacePaths,
    document_id: &str,
    location: &str,
) -> Result<(), String> {
    let db = knowledge_db(workspace)?;
    db.execute(
        "UPDATE knowledge_documents SET location=?2 WHERE id=?1",
        params![document_id, location],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::search_tokens;

    #[test]
    fn normalizes_natural_language_search_tokens() {
        let tokens = search_tokens("请帮我查一下如何保障支付接口幂等和灾备");
        assert!(tokens.iter().any(|token| token == "支付"));
        assert!(tokens.iter().any(|token| token == "接口"));
        assert!(tokens.concat().contains("幂等"));
        assert!(tokens.concat().contains("灾备"), "{tokens:?}");
        assert!(!tokens
            .iter()
            .any(|token| matches!(token.as_str(), "请" | "如何" | "保障" | "和")));
    }

    #[test]
    fn deduplicates_and_limits_search_tokens() {
        let tokens = search_tokens("\"OAuth\" OAuth PKCE token refresh client server callback redirect security protocol standard");
        assert_eq!(
            tokens
                .iter()
                .filter(|token| token.eq_ignore_ascii_case("OAuth"))
                .count(),
            1
        );
        assert!(tokens.len() <= 8);
        assert!(tokens.iter().any(|token| token == "PKCE"));
    }
}
