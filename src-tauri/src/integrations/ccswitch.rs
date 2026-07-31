use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{env, fs, path::PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchProvider {
    source_id: String,
    app_type: String,
    name: String,
    base_url: String,
    api_key: String,
    protocol: String,
    models: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchProvidersResponse {
    database_path: Option<String>,
    checked_paths: Vec<String>,
    providers: Vec<CcSwitchProvider>,
}

#[tauri::command]
pub async fn list_ccswitch_providers() -> Result<CcSwitchProvidersResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let candidates = database_candidates();
        let database = candidates.iter().find(|path| path.is_file());
        let providers = match database {
            Some(path) => read_providers(path)?,
            None => Vec::new(),
        };
        Ok(CcSwitchProvidersResponse {
            database_path: database.map(|path| path.to_string_lossy().into_owned()),
            checked_paths: candidates.iter().map(|path| path.to_string_lossy().into_owned()).collect(),
            providers,
        })
    })
    .await
    .map_err(|error| format!("读取 CCSwitch 配置任务失败: {error}"))?
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    { env::var_os("APPDATA").map(PathBuf::from) }
    #[cfg(not(windows))]
    { env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| home_dir().map(|home| home.join(".config"))) }
}

fn database_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(config) = config_dir() {
        let app_paths = config.join("com.ccswitch.desktop").join("app_paths.json");
        if let Ok(text) = fs::read_to_string(app_paths) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(path) = value.get("app_config_dir_override").and_then(Value::as_str) {
                    let path = expand_home(path.trim());
                    if !path.as_os_str().is_empty() { paths.push(path.join("cc-switch.db")); }
                }
            }
        }
    }
    if let Some(home) = home_dir() { paths.push(home.join(".cc-switch").join("cc-switch.db")); }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        let path = home.join(".cc-switch").join("cc-switch.db");
        if !paths.contains(&path) { paths.push(path); }
    }
    paths
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" { return home_dir().unwrap_or_default(); }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() { return home.join(rest); }
    }
    PathBuf::from(path)
}

fn read_providers(path: &PathBuf) -> Result<Vec<CcSwitchProvider>, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开 CCSwitch 数据库失败 {}: {error}", path.display()))?;
    let mut statement = connection.prepare(
        "SELECT id, app_type, name, settings_config FROM providers
         WHERE app_type IN ('codex','claude','claude-code','claude_code','gemini','grokbuild','grok-build','grok_build','grok','xai')
         ORDER BY COALESCE(sort_index, 999999), created_at, id"
    ).map_err(|error| format!("读取 CCSwitch providers 表失败: {error}"))?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
        .map_err(|error| format!("查询 CCSwitch providers 失败: {error}"))?;
    let mut result = Vec::new();
    for row in rows {
        let (source_id, app_type, name, settings) = row.map_err(|error| format!("读取 CCSwitch provider 失败: {error}"))?;
        let Ok(config) = serde_json::from_str::<Value>(&settings) else { continue };
        if let Some(provider) = provider_from_value(source_id, app_type, name, config) { result.push(provider); }
    }
    Ok(result)
}

fn provider_from_value(source_id: String, app_type: String, name: String, config: Value) -> Option<CcSwitchProvider> {
    let kind = app_type.trim().to_ascii_lowercase();
    let protocol = match kind.as_str() {
        "claude" | "claude-code" | "claude_code" => "anthropic-messages",
        "gemini" => "google-generative-ai",
        "grokbuild" | "grok-build" | "grok_build" | "grok" | "xai" => "openai-responses",
        "codex" if is_chat_protocol(&config) => "openai-completions",
        "codex" => "openai-responses",
        _ => return None,
    };
    let (base_keys, key_keys, model_keys): (&[&[&str]], &[&[&str]], &[&[&str]]) = match protocol {
        "anthropic-messages" => (&[&["env", "ANTHROPIC_BASE_URL"], &["config", "ANTHROPIC_BASE_URL"]], &[&["env", "ANTHROPIC_AUTH_TOKEN"], &["env", "ANTHROPIC_API_KEY"]], &[&["env", "ANTHROPIC_MODEL"], &["env", "ANTHROPIC_DEFAULT_SONNET_MODEL"], &["env", "ANTHROPIC_DEFAULT_OPUS_MODEL"], &["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]]),
        "google-generative-ai" => (&[&["env", "GEMINI_BASE_URL"], &["env", "GOOGLE_GEMINI_BASE_URL"], &["config", "base_url"]], &[&["env", "GEMINI_API_KEY"], &["env", "GOOGLE_API_KEY"]], &[&["env", "GEMINI_MODEL"], &["env", "GOOGLE_GEMINI_MODEL"], &["env", "GOOGLE_MODEL"]]),
        _ => (&[&["base_url"], &["baseURL"], &["config", "base_url"], &["config", "baseURL"]], &[&["env", "OPENAI_API_KEY"], &["auth", "OPENAI_API_KEY"], &["apiKey"], &["api_key"], &["config", "apiKey"], &["config", "api_key"]], &[]),
    };
    let config_text = config.get("config").and_then(Value::as_str);
    let base_url = first_string(&config, base_keys).or_else(|| config_text.and_then(|text| toml_string(text, "base_url"))).unwrap_or_default().trim().trim_end_matches('/').to_string();
    let api_key = first_string(&config, key_keys).or_else(|| config_text.and_then(|text| toml_string(text, "api_key"))).unwrap_or_default();
    let mut models = Vec::new();
    for path in model_keys { push_unique(&mut models, value_at(&config, path)); }
    for key in ["model", "default_model", "defaultModel"] { push_unique(&mut models, config.get(key).and_then(Value::as_str).map(str::to_string)); }
    if let Some(text) = config_text { push_unique(&mut models, toml_string(text, "default")); push_unique(&mut models, toml_string(text, "model")); }
    Some(CcSwitchProvider { source_id, app_type, name: strip_suffix(&name), base_url, api_key, protocol: protocol.into(), models })
}

fn first_string(value: &Value, paths: &[&[&str]]) -> Option<String> { paths.iter().find_map(|path| value_at(value, path)) }
fn value_at(value: &Value, path: &[&str]) -> Option<String> { path.iter().try_fold(value, |current, key| current.get(*key)).and_then(Value::as_str).map(str::to_string) }
fn push_unique(values: &mut Vec<String>, value: Option<String>) { if let Some(value) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) { if !values.contains(&value) { values.push(value); } } }
fn toml_string(text: &str, key: &str) -> Option<String> { text.lines().find_map(|line| { let rest = line.trim().strip_prefix(key)?.trim_start().strip_prefix('=')?.trim_start(); let quote = rest.chars().next()?; if quote != '\'' && quote != '"' { return None; } Some(rest[1..].split(quote).next()?.to_string()) }) }
fn is_chat_protocol(config: &Value) -> bool { first_string(config, &[&["api_format"], &["apiFormat"]]).map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "chat" | "chat_completions" | "chat-completions" | "openai_chat" | "openai-chat")).unwrap_or(false) || first_string(config, &[&["base_url"], &["baseURL"]]).map(|v| v.to_ascii_lowercase().ends_with("/chat/completions")).unwrap_or(false) }
fn strip_suffix(name: &str) -> String { name.trim().strip_suffix("（ccswitch）").or_else(|| name.trim().strip_suffix("(ccswitch)")).unwrap_or(name.trim()).to_string() }

