use super::{stable_id, HeadingCandidate, HeadingReviewDecision};
use super::parser::markdown_heading;
use crate::{load_secret, ModelConfig};
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

pub(super) fn normalized_heading_text(value: &str) -> String {
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

pub(super) fn detect_heading_candidates(document_id: &str, markdown: &str) -> (Vec<HeadingCandidate>, Option<usize>, Option<usize>) {
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

pub(super) async fn resolve_ambiguous_candidates(candidates:&mut [HeadingCandidate],markdown:&str,mut config:ModelConfig)->Option<String>{
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


pub(super) fn apply_heading_decisions(content:&str,decisions:&[HeadingReviewDecision],toc_start:Option<usize>,toc_end:Option<usize>)->String{
    let selected:BTreeMap<usize,&HeadingReviewDecision>=decisions.iter().filter(|d|d.selected).map(|d|(d.line,d)).collect();let mut output=Vec::new();let mark_toc=!content.contains("<!-- knowledge-toc:start -->");
    for(index,line)in content.lines().enumerate(){if mark_toc&&Some(index)==toc_start{output.push("<!-- knowledge-toc:start -->".to_string());}if let Some(decision)=selected.get(&index){let _candidate_id=&decision.id;if markdown_heading(line).is_some(){output.push(line.to_string())}else{output.push(format!("{} {}","#".repeat(decision.level.clamp(1,6)),line.trim_start()))}}else{output.push(line.to_string())}if mark_toc&&Some(index)==toc_end{output.push("<!-- knowledge-toc:end -->".to_string());}}
    let mut result=output.join("\n");if content.ends_with('\n'){result.push('\n');}result
}

