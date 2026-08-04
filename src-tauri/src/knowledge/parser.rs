use super::{stable_id, ParsedChunk, ParsedSection};
use jieba_rs::Jieba;
use std::sync::OnceLock;

pub(super) fn markdown_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let count = trimmed.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&count) {
        return None;
    }
    let rest = &trimmed[count..];
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((count, rest.trim().trim_end_matches('#').trim().to_string()))
}

pub(super) fn parse_sections(document_id: &str, title: &str, markdown: &str) -> Vec<ParsedSection> {
    let mut sections = Vec::new();
    let mut stack: Vec<(usize, String, String)> = Vec::new();
    let mut current_title = title.to_string();
    let mut current_level = 0usize;
    let mut current_parent = None;
    let mut current_path = title.to_string();
    let mut body = String::new();
    let mut in_fence = false;
    let mut in_toc = false;
    let flush = |sections: &mut Vec<ParsedSection>,
                 body: &mut String,
                 current_title: &str,
                 current_path: &str,
                 current_level: usize,
                 current_parent: &Option<String>| {
        if !body.trim().is_empty() || current_level > 0 {
            let position = sections.len();
            let id = stable_id("ks", &format!("{document_id}:{position}:{current_path}"));
            sections.push(ParsedSection {
                id,
                parent_id: current_parent.clone(),
                title: current_title.to_string(),
                path: current_path.to_string(),
                level: current_level,
                position,
                body: body.trim().to_string(),
            });
        }
        body.clear();
    };
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed == "<!-- knowledge-toc:start -->" {
            in_toc = true;
            continue;
        }
        if trimmed == "<!-- knowledge-toc:end -->" {
            in_toc = false;
            continue;
        }
        if in_toc {
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some((level, heading)) = markdown_heading(line) {
                flush(
                    &mut sections,
                    &mut body,
                    &current_title,
                    &current_path,
                    current_level,
                    &current_parent,
                );
                while stack.last().is_some_and(|(old, _, _)| *old >= level) {
                    stack.pop();
                }
                current_parent = stack.last().map(|(_, id, _)| id.clone());
                let mut paths: Vec<String> =
                    stack.iter().map(|(_, _, name)| name.clone()).collect();
                paths.push(heading.clone());
                current_path = paths.join(" > ");
                current_title = heading;
                current_level = level;
                let future_id = stable_id(
                    "ks",
                    &format!("{document_id}:{}:{current_path}", sections.len()),
                );
                stack.push((level, future_id, current_title.clone()));
                continue;
            }
        }
        body.push_str(line);
        body.push('\n');
    }
    flush(
        &mut sections,
        &mut body,
        &current_title,
        &current_path,
        current_level,
        &current_parent,
    );
    if sections.is_empty() {
        sections.push(ParsedSection {
            id: stable_id("ks", &format!("{document_id}:0:{title}")),
            parent_id: None,
            title: title.to_string(),
            path: title.to_string(),
            level: 0,
            position: 0,
            body: String::new(),
        });
    }
    sections
}

pub(super) fn build_document_chunks(
    document_id: &str,
    sections: &[ParsedSection],
) -> Vec<ParsedChunk> {
    let mut start_char = 0usize;
    sections
        .iter()
        .enumerate()
        .map(|(position, section)| {
            let content = section.body.trim().to_string();
            let end_char = start_char + content.chars().count();
            let chunk = ParsedChunk {
                id: stable_id("kc", &format!("{document_id}:{}", section.id)),
                section_id: section.id.clone(),
                heading_path: section.path.clone(),
                content,
                position,
                start_char,
                end_char,
                section_ids: vec![section.id.clone()],
            };
            start_char = end_char;
            chunk
        })
        .collect()
}

pub(super) fn segmented(value: &str) -> String {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    JIEBA.get_or_init(Jieba::new).cut(value, false).join(" ")
}
