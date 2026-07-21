use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs, path::PathBuf, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{process::Command, time::timeout};

const CREDENTIAL_SERVICE: &str = "com.techproposal.studio";
const LEGACY_CREDENTIAL_SERVICE: &str = "cn.gouan.writer";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfig { base_url: String, api_key: String, timeout_ms: u64, headers: HashMap<String, String> }
#[derive(Deserialize)]
struct SearchConfig { provider: String, endpoint: String, #[serde(rename = "apiKey")] api_key: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiDraft { block_id: String, before: String, after: String, instruction: String }
#[derive(Serialize)]
struct SearchResult { title: String, url: String, excerpt: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandPreset { program: String, args: Vec<String>, cwd: String, timeout_ms: u64, allow_shell: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult { exit_code: i32, stdout: String, stderr: String, duration_ms: u128 }

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map_err(|e| e.to_string()) }
fn init_db(app: &AppHandle) -> Result<(), String> {
    let dir = app_dir(app)?; fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db = rusqlite::Connection::open(dir.join("workspace.db")).map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL, excerpt TEXT NOT NULL, fingerprint TEXT NOT NULL, accessed_at TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(id UNINDEXED, title, excerpt, tokenize='unicode61'); CREATE TABLE IF NOT EXISTS command_runs(id INTEGER PRIMARY KEY, program TEXT NOT NULL, exit_code INTEGER NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);").map_err(|e| e.to_string())
}
fn load_secret(name: &str) -> String {
    let current = keyring::Entry::new(CREDENTIAL_SERVICE, name).ok();
    if let Some(value) = current.as_ref().and_then(|entry| entry.get_password().ok()).filter(|value| !value.is_empty()) { return value; }
    let legacy = keyring::Entry::new(LEGACY_CREDENTIAL_SERVICE, name).ok().and_then(|entry| entry.get_password().ok()).unwrap_or_default();
    if !legacy.is_empty() { if let Some(entry) = current { let _ = entry.set_password(&legacy); } }
    legacy
}

#[tauri::command]
async fn generate_text(block_id: String, mut config: ModelConfig, payload: Value, instruction: String, before: String) -> Result<AiDraft, String> {
    if config.api_key.is_empty() { config.api_key = load_secret("openai-api-key"); }
    if config.api_key.is_empty() && !config.base_url.contains("localhost") && !config.base_url.contains("127.0.0.1") { return Err("API Key 未配置".into()); }
    let mut request = reqwest::Client::new().post(format!("{}/chat/completions", config.base_url.trim_end_matches('/'))).bearer_auth(&config.api_key).json(&payload);
    for (key, value) in &config.headers { request = request.header(key, value); }
    let response = request.timeout(Duration::from_millis(config.timeout_ms)).send().await.map_err(|e| e.to_string())?;
    let status = response.status(); if !status.is_success() { return Err(format!("模型服务返回 {}", status)); }
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(AiDraft { block_id, before, after: body.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().to_string(), instruction })
}

#[tauri::command]
fn store_secret(name: String, value: String) -> Result<(), String> { keyring::Entry::new(CREDENTIAL_SERVICE, &name).map_err(|e| e.to_string())?.set_password(&value).map_err(|e| e.to_string()) }

#[tauri::command]
async fn search_web(query: String, config: SearchConfig) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::new();
    let response = if config.provider == "searxng" { client.get(format!("{}/search", config.endpoint.trim_end_matches('/'))).query(&[("q", query.as_str()), ("format", "json")]).send().await } else { client.get(if config.endpoint.is_empty() { "https://api.search.brave.com/res/v1/web/search" } else { &config.endpoint }).query(&[("q", query.as_str())]).header("X-Subscription-Token", config.api_key).send().await }.map_err(|e| e.to_string())?;
    let json: Value = response.json().await.map_err(|e| e.to_string())?;
    let items = if config.provider == "searxng" { json.get("results") } else { json.pointer("/web/results") }.and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(items.into_iter().take(8).map(|item| SearchResult { title: item.get("title").and_then(Value::as_str).unwrap_or_default().into(), url: item.get("url").and_then(Value::as_str).unwrap_or_default().into(), excerpt: item.get(if config.provider == "searxng" { "content" } else { "description" }).and_then(Value::as_str).unwrap_or_default().into() }).collect())
}

#[tauri::command]
fn save_markdown(app: AppHandle, project_name: String, markdown: String) -> Result<String, String> {
    let exports = app_dir(&app)?.join("exports"); fs::create_dir_all(&exports).map_err(|e| e.to_string())?;
    let safe = Regex::new(r#"[<>:\"/\\|?*]"#).unwrap().replace_all(&project_name, "_"); let path = exports.join(format!("{}.md", safe)); fs::write(&path, markdown).map_err(|e| e.to_string())?; Ok(path.to_string_lossy().into())
}
fn redact(text: &str) -> String { Regex::new(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*\S+").unwrap().replace_all(text, "$1=[REDACTED]").chars().take(100_000).collect() }

#[tauri::command]
async fn run_command(app: AppHandle, preset: CommandPreset) -> Result<CommandResult, String> {
    if preset.allow_shell { return Err("首版不允许 Shell 模式".into()); }
    let root = std::env::current_dir().map_err(|e| e.to_string())?.canonicalize().map_err(|e| e.to_string())?;
    let cwd = root.join(&preset.cwd).canonicalize().map_err(|e| e.to_string())?; if !cwd.starts_with(&root) { return Err("工作目录超出项目范围".into()); }
    let started = std::time::Instant::now(); let child = Command::new(&preset.program).args(&preset.args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
    let output = timeout(Duration::from_millis(preset.timeout_ms), child.wait_with_output()).await.map_err(|_| "命令执行超时".to_string())?.map_err(|e| e.to_string())?;
    let result = CommandResult { exit_code: output.status.code().unwrap_or(-1), stdout: redact(&String::from_utf8_lossy(&output.stdout)), stderr: redact(&String::from_utf8_lossy(&output.stderr)), duration_ms: started.elapsed().as_millis() };
    let db = rusqlite::Connection::open(app_dir(&app)?.join("workspace.db")).map_err(|e| e.to_string())?; db.execute("INSERT INTO command_runs(program,exit_code,stdout,stderr,duration_ms) VALUES(?1,?2,?3,?4,?5)", rusqlite::params![preset.program, result.exit_code, result.stdout, result.stderr, result.duration_ms as i64]).map_err(|e| e.to_string())?; Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() { tauri::Builder::default().plugin(tauri_plugin_dialog::init()).setup(|app| { init_db(&app.handle()).map_err(std::io::Error::other)?; Ok(()) }).invoke_handler(tauri::generate_handler![generate_text, store_secret, search_web, save_markdown, run_command]).run(tauri::generate_context!()).expect("failed to run application"); }
