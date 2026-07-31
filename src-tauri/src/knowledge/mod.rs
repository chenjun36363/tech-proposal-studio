use crate::{ModelConfig, WorkspacePaths};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};
mod headings;
mod parser;
mod repository;
use headings::{apply_heading_decisions, detect_heading_candidates, resolve_ambiguous_candidates};
#[cfg(test)] use parser::{build_document_chunks, parse_sections};
use repository::{
    chunk as repository_chunk, classify_documents, document_id as repository_document_id,
    document_location, find_document_id, index_document as repository_index_document,
    list_documents, list_sections, mark_document_restored, remove_document,
    save_heading_metadata as repository_save_heading_metadata,
    resolve_workspace_path, search as search_repository, section_chunks as repository_section_chunks,
    section_scope as repository_section_scope, set_chunk_quality as repository_set_chunk_quality,
    set_section_quality as repository_set_section_quality, source_location, storage_location,
};

#[cfg(test)]
use repository::{normalized_location, replace_document_location};


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
    char_count: i64,
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
    char_count: i64,
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

fn emit_progress(app: &AppHandle, document_id: &str, stage: &str, current: usize, total: usize, message: &str) {
    let _ = app.emit("knowledge://progress", KnowledgeProgress { document_id: document_id.into(), stage: stage.into(), current, total, message: message.into() });
}

#[cfg(test)]
fn store_document(workspace: &WorkspacePaths, source_type: &str, location: &str, source_url: Option<&str>, title: &str, markdown: &str) -> Result<KnowledgeDocument, String> {
    store_document_with_progress(workspace,source_type,location,source_url,title,markdown,None)
}

fn store_document_with_progress(workspace: &WorkspacePaths, source_type: &str, location: &str, source_url: Option<&str>, title: &str, markdown: &str, app: Option<&AppHandle>) -> Result<KnowledgeDocument, String> {
    repository_index_document(
        workspace,
        source_type,
        location,
        source_url,
        title,
        markdown,
        |document_id, stage, current, total, message| {
            if let Some(app) = app {
                emit_progress(app, document_id, stage, current, total, message);
            }
        },
    )
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

fn ensure_history_copy(workspace:&WorkspacePaths,source_path:&str)->Result<(PathBuf,String),String>{
    let source=resolve_workspace_path(workspace,source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;let history=PathBuf::from(&workspace.history_dir);fs::create_dir_all(&history).map_err(|e|e.to_string())?;
    let destination=if source.starts_with(&history){source.clone()}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};if destination!=source{fs::write(&destination,&content).map_err(|e|e.to_string())?;}Ok((destination,content))
}

fn validate_history_path(workspace:&WorkspacePaths,path:&str)->Result<PathBuf,String>{
    let history=fs::canonicalize(&workspace.history_dir).map_err(|e|e.to_string())?;let target=fs::canonicalize(resolve_workspace_path(workspace,path)).map_err(|e|e.to_string())?;if !target.starts_with(history){return Err("只能规范化工作区知识库目录下的副本".into());}Ok(target)
}

#[tauri::command]
pub fn knowledge_scan(workspace: WorkspacePaths) -> Result<Vec<KnowledgeScanItem>, String> {
    let mut files = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else if path.extension().and_then(|x| x.to_str()).is_some_and(|x| {
                x.eq_ignore_ascii_case("md") || x.eq_ignore_ascii_case("markdown")
            }) {
                out.push(path);
            }
        }
        Ok(())
    }
    walk(Path::new(&workspace.history_dir), &mut files)?;
    let generated_readme = PathBuf::from(&workspace.history_dir).join("README.md");
    files.retain(|path| path != &generated_readme);

    let candidates = files
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let location = storage_location(&workspace, path.to_string_lossy().as_ref());
            Ok((path, location, hash_text(&text)))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let identities = candidates
        .iter()
        .map(|(_, location, fingerprint)| (location.clone(), fingerprint.clone()))
        .collect::<Vec<_>>();
    let states = classify_documents(&workspace, &identities, CHUNKING_VERSION)?;

    Ok(candidates
        .into_iter()
        .zip(states)
        .map(|((path, location, _), (state, document_id))| KnowledgeScanItem {
            title: path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("未命名")
                .into(),
            path: location,
            state,
            document_id,
        })
        .collect())
}

#[tauri::command]
pub async fn knowledge_analyze_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String,config:ModelConfig)->Result<HeadingDetectionResult,String>{
    let(destination,content)=ensure_history_copy(&workspace,&source_path)?;let location=storage_location(&workspace,destination.to_string_lossy().as_ref());let document_id=repository_document_id(&workspace,&location)?;
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

fn save_heading_metadata(workspace: &WorkspacePaths, document_id: &str, decisions: &[HeadingReviewDecision], original: &str, normalized: &str, status: &str) -> Result<(), String> {
    repository_save_heading_metadata(workspace, document_id, decisions, original, normalized, status)
}

#[tauri::command]
pub async fn knowledge_apply_headings(app:AppHandle,workspace:WorkspacePaths,path:String,decisions:Vec<HeadingReviewDecision>,toc_start:Option<usize>,toc_end:Option<usize>)->Result<KnowledgeDocument,String>{
    let source=validate_history_path(&workspace,&path)?;let original=fs::read_to_string(&source).map_err(|e|e.to_string())?;let absolute=source.to_string_lossy();let location=storage_location(&workspace,&absolute);let document_id=repository_document_id(&workspace,&location)?;emit_progress(&app,&document_id,"normalization_backup",0,0,"正在备份规范化前的原文…");backup_original(&workspace,&document_id,&source,&original)?;emit_progress(&app,&document_id,"normalization_writing",0,0,"正在写入确认后的标题结构…");let normalized=apply_heading_decisions(&original,&decisions,toc_start,toc_end);fs::write(&source,&normalized).map_err(|e|e.to_string())?;let title=source.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let doc=match store_document_with_progress(&workspace,"markdown",&absolute,None,title,&normalized,Some(&app)){Ok(doc)=>doc,Err(error)=>{let _=fs::write(&source,&original);return Err(error);}};emit_progress(&app,&document_id,"normalization_metadata",0,0,"正在保存章节识别结果…");save_heading_metadata(&workspace,&doc.id,&decisions,&original,&normalized,"confirmed")?;emit_progress(&app,&doc.id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"结构规范化和索引已完成");Ok(doc)
}

#[tauri::command]
pub fn knowledge_backups(workspace:WorkspacePaths,document_id:String)->Result<Vec<KnowledgeBackup>,String>{
    let dir=PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(document_id);if !dir.exists(){return Ok(Vec::new());}let mut result=Vec::new();for entry in fs::read_dir(dir).map_err(|e|e.to_string())?{let entry=entry.map_err(|e|e.to_string())?;let path=entry.path();if path.extension().and_then(|x|x.to_str())!=Some("md"){continue;}let meta=entry.metadata().map_err(|e|e.to_string())?;result.push(KnowledgeBackup{name:path.file_name().and_then(|x|x.to_str()).unwrap_or("backup.md").into(),path:path.to_string_lossy().into(),created_at:file_time_string(&meta)});}result.sort_by(|a,b|b.name.cmp(&a.name));Ok(result)
}

fn file_time_string(meta:&fs::Metadata)->String{meta.modified().ok().and_then(|v|v.duration_since(UNIX_EPOCH).ok()).map(|v|v.as_secs().to_string()).unwrap_or_default()}

#[tauri::command]
pub async fn knowledge_restore_backup(app: AppHandle, workspace: WorkspacePaths, document_id: String, backup_path: String) -> Result<KnowledgeDocument, String> {
    let backup_root = fs::canonicalize(PathBuf::from(&workspace.root).join(".gouan").join("backups").join("knowledge").join(&document_id)).map_err(|e| e.to_string())?;
    let backup = fs::canonicalize(&backup_path).map_err(|e| e.to_string())?;
    if !backup.starts_with(backup_root) {
        return Err("备份路径无效".into());
    }
    let location = document_location(&workspace, &document_id)?;
    let target = validate_history_path(&workspace, &location)?;
    let original = fs::read_to_string(&backup).map_err(|e| e.to_string())?;
    fs::write(&target, &original).map_err(|e| e.to_string())?;
    let title = target.file_stem().and_then(|value| value.to_str()).unwrap_or("未命名");
    let doc = store_document_with_progress(&workspace, "markdown", &location, None, title, &original, Some(&app))?;
    mark_document_restored(&workspace, &document_id, &hash_text(&original))?;
    emit_progress(&app, &document_id, "complete", doc.chunk_count as usize, doc.chunk_count as usize, "已恢复原文并重建索引");
    Ok(doc)
}

#[tauri::command]
pub async fn knowledge_import_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String)->Result<KnowledgeDocument,String>{
    let source=resolve_workspace_path(&workspace,&source_path);let content=fs::read_to_string(&source).map_err(|e|format!("读取 Markdown 失败: {e}"))?;
    fs::create_dir_all(&workspace.history_dir).map_err(|e|e.to_string())?;
    let history=PathBuf::from(&workspace.history_dir);
    let destination=if source.starts_with(&history){source.clone()}else{unique_destination(&history,&safe_markdown_name(source.file_name().and_then(|x|x.to_str()).unwrap_or("知识文档.md")))};
    if destination!=source{fs::write(&destination,&content).map_err(|e|e.to_string())?;}
    let title=destination.file_stem().and_then(|x|x.to_str()).unwrap_or("未命名");let absolute=destination.to_string_lossy().to_string();let location=storage_location(&workspace,&absolute);let id=repository_document_id(&workspace,&location)?;
    emit_progress(&app,&id,"parsing",0,0,"正在准备 Markdown 索引…");let doc=store_document_with_progress(&workspace,"markdown",&absolute,None,title,&content,Some(&app))?;
    emit_progress(&app,&doc.id,"complete",doc.chunk_count as usize,doc.chunk_count as usize,"索引完成");Ok(doc)
}

#[tauri::command]
pub async fn knowledge_move_workspace_markdown(app:AppHandle,workspace:WorkspacePaths,source_path:String)->Result<KnowledgeDocument,String>{
    let root=fs::canonicalize(&workspace.root).map_err(|e|format!("工作区路径无效: {e}"))?;
    let source=fs::canonicalize(resolve_workspace_path(&workspace,&source_path)).map_err(|e|format!("工作区文档不存在: {e}"))?;
    if source.parent()!=Some(root.as_path()) || !source.extension().and_then(|x|x.to_str()).is_some_and(|x|x.eq_ignore_ascii_case("md")||x.eq_ignore_ascii_case("markdown")){return Err("只能移动工作区根目录下的 Markdown 文档".into());}
    let doc=knowledge_import_markdown(app,workspace.clone(),source.to_string_lossy().into_owned()).await?;
    if let Err(error)=fs::remove_file(&source){
        let rollback=knowledge_delete_file(workspace.clone(),doc.location.clone(),Some(doc.id.clone()));
        return Err(match rollback{Ok(())=>format!("删除工作区原文档失败，知识库写入已回滚: {error}"),Err(rollback_error)=>format!("删除工作区原文档失败: {error}；知识库回滚也失败: {rollback_error}")});
    }
    Ok(doc)
}

#[tauri::command]
pub async fn knowledge_index_pending(app:AppHandle,workspace:WorkspacePaths,paths:Vec<String>)->Result<Vec<KnowledgeDocument>,String>{
    let mut result=Vec::new();for path in paths{result.push(knowledge_import_markdown(app.clone(),workspace.clone(),path).await?);}Ok(result)
}

#[tauri::command]
pub fn knowledge_list(workspace: WorkspacePaths) -> Result<Vec<KnowledgeDocument>, String> {
    list_documents(&workspace)
}

#[tauri::command]
pub fn knowledge_sections(workspace: WorkspacePaths, document_id: String) -> Result<Vec<KnowledgeSection>, String> {
    list_sections(&workspace, &document_id)
}

#[tauri::command]
pub fn knowledge_search(workspace: WorkspacePaths, query: String, limit: Option<usize>, qualities: Option<Vec<String>>, fields: Option<Vec<String>>) -> Result<Vec<KnowledgeSearchResult>, String> {
    search_repository(&workspace, &query, limit, qualities, fields)
}

#[tauri::command]
pub fn knowledge_section_scope(workspace: WorkspacePaths, section_id: String) -> Result<KnowledgeSectionScope, String> {
    repository_section_scope(&workspace, &section_id)
}

#[tauri::command]
pub fn knowledge_chunk(workspace: WorkspacePaths, chunk_id: String) -> Result<KnowledgeChunk, String> {
    repository_chunk(&workspace, &chunk_id)
}

#[tauri::command]
pub fn knowledge_set_chunk_quality(workspace: WorkspacePaths, chunk_id: String, quality: String) -> Result<KnowledgeChunk, String> {
    repository_set_chunk_quality(&workspace, &chunk_id, &quality)
}

#[tauri::command]
pub fn knowledge_section_chunks(workspace: WorkspacePaths, section_id: String) -> Result<Vec<KnowledgeChunk>, String> {
    repository_section_chunks(&workspace, &section_id)
}

#[tauri::command]
pub fn knowledge_remove(workspace: WorkspacePaths, document_id: String) -> Result<(), String> {
    remove_document(&workspace, &document_id)
}

#[tauri::command]
pub fn knowledge_delete_file(workspace: WorkspacePaths, path: String, document_id: Option<String>) -> Result<(), String> {
    let target = validate_history_path(&workspace, &path)?;
    if !target.is_file() {
        return Err("知识文档不存在".into());
    }
    if target.file_name().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("README.md")) {
        return Err("不能删除知识库说明文件".into());
    }
    let indexed_id = if let Some(requested) = document_id {
        let indexed_path = document_location(&workspace, &requested)?;
        let canonical_indexed = fs::canonicalize(resolve_workspace_path(&workspace, &indexed_path)).map_err(|e| e.to_string())?;
        if canonical_indexed != target {
            return Err("文档索引与文件不匹配".into());
        }
        Some(requested)
    } else {
        let location = storage_location(&workspace, target.to_string_lossy().as_ref());
        find_document_id(&workspace, &location)?
    };
    fs::remove_file(&target).map_err(|e| format!("删除知识文档失败: {e}"))?;
    if let Some(document_id) = indexed_id {
        remove_document(&workspace, &document_id)?;
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPageContent {
    title: String,
    url: String,
    markdown: String,
}

#[tauri::command]
pub async fn knowledge_fetch_web_page(url: String) -> Result<WebPageContent, String> {
    let (title, markdown) = fetch_web_markdown(&url).await?;
    Ok(WebPageContent { title, url, markdown })
}

#[tauri::command]
pub async fn knowledge_import_web(app: AppHandle, workspace: WorkspacePaths, url: String) -> Result<KnowledgeDocument, String> {
    let (title, body) = fetch_web_markdown(&url).await?;
    let dir = PathBuf::from(&workspace.history_dir).join("web");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let destination = source_location(&workspace, &url)?
        .map(|location| resolve_workspace_path(&workspace, &location))
        .unwrap_or_else(|| unique_destination(&dir, &safe_markdown_name(&title)));
    let markdown = format!("---\nsourceUrl: {}\nfetchedAt: {}\n---\n\n# {}\n\n{}", url, now_string(), title, body);
    fs::write(&destination, &markdown).map_err(|e| e.to_string())?;
    let location = destination.to_string_lossy().to_string();
    let doc = store_document_with_progress(&workspace, "web", &location, Some(&url), &title, &markdown, Some(&app))?;
    emit_progress(&app, &doc.id, "complete", doc.chunk_count as usize, doc.chunk_count as usize, "网页正文已提取并完成索引");
    Ok(doc)
}

#[tauri::command]
pub fn knowledge_set_section_quality(workspace: WorkspacePaths, section_id: String, quality: String) -> Result<String, String> {
    repository_set_section_quality(&workspace, &section_id, &quality)
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
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:history.to_string_lossy().into()};let location=source.to_string_lossy().to_string();let document=store_document(&workspace,"web",&location,None,"文档",markdown).unwrap();replace_document_location(&workspace,&document.id,r"\\?\E:\old-workspace\history\web\document.md").unwrap();
   let documents=knowledge_list(workspace.clone()).unwrap();assert_eq!(documents[0].location,"history/web/document.md");assert_eq!(fs::canonicalize(resolve_workspace_path(&workspace,&documents[0].location)).unwrap(),fs::canonicalize(&source).unwrap());let _=fs::remove_dir_all(root);
 }
 #[test] fn relocates_relative_history_paths_to_knowledge(){
   let nonce=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let root=std::env::temp_dir().join(format!("gouan-knowledge-dir-test-{nonce}"));let knowledge=root.join("knowledge");fs::create_dir_all(&knowledge).unwrap();let source=knowledge.join("document.md");let markdown="# 文档\n\n正文";fs::write(&source,markdown).unwrap();
   let workspace=WorkspacePaths{root:root.to_string_lossy().into(),history_dir:knowledge.to_string_lossy().into()};let document=store_document(&workspace,"markdown",&source.to_string_lossy(),None,"文档",markdown).unwrap();replace_document_location(&workspace,&document.id,"history/document.md").unwrap();
   let documents=knowledge_list(workspace).unwrap();assert_eq!(documents[0].id,document.id);assert_eq!(documents[0].location,"knowledge/document.md");let _=fs::remove_dir_all(root);
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
