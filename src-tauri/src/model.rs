use crate::{load_secret, StreamEvent};
use futures_util::StreamExt;
use reqwest::{RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelConfig {
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    #[serde(default)]
    pub(crate) model: String,
    pub(crate) timeout_ms: u64,
    pub(crate) headers: HashMap<String, String>,
}

impl ModelConfig {
    fn resolve_secret(&mut self) {
        if self.api_key.trim().is_empty() {
            self.api_key = load_secret("openai-api-key");
        }
    }

    fn validate(&mut self) -> Result<(), String> {
        if self.base_url.trim().is_empty() {
            return Err("请先填写模型服务 API 地址".into());
        }
        self.resolve_secret();
        let local = ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|host| self.base_url.contains(host));
        if self.api_key.trim().is_empty() && !local {
            return Err("API Key 未配置".into());
        }
        Ok(())
    }

    fn with_headers(&self, mut request: RequestBuilder) -> RequestBuilder {
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }
        request
    }

    fn chat_request(&self, payload: &Value) -> RequestBuilder {
        let request = reqwest::Client::new()
            .post(format!("{}/chat/completions", self.base_url.trim_end_matches('/')))
            .bearer_auth(&self.api_key)
            .json(payload)
            .timeout(Duration::from_millis(self.timeout_ms));
        self.with_headers(request)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiDraft {
    block_id: String,
    before: String,
    after: String,
    instruction: String,
}

fn model_list_endpoint(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("/models") { base.to_string() } else { format!("{base}/models") }
}

fn is_anthropic_endpoint(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("api.anthropic.com")
}

fn upstream_error(prefix: &str, status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.pointer("/error/message").and_then(Value::as_str).map(str::to_string));
    match detail {
        Some(detail) if !detail.is_empty() => format!("{prefix} {status}：{detail}"),
        _ => format!("{prefix} {status}"),
    }
}

#[tauri::command]
pub(crate) async fn list_models(mut config: ModelConfig) -> Result<Value, String> {
    config.validate()?;
    let mut request = reqwest::Client::new()
        .get(model_list_endpoint(&config.base_url))
        .timeout(Duration::from_millis(config.timeout_ms));
    if !config.api_key.is_empty() {
        request = if is_anthropic_endpoint(&config.base_url) {
            request.header("x-api-key", &config.api_key).header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(&config.api_key)
        };
    }
    let response = config.with_headers(request).send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(upstream_error("模型列表请求返回", status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("上游模型列表不是有效 JSON: {error}"))
}

async fn completion(config: &mut ModelConfig, payload: &Value) -> Result<Value, String> {
    config.validate()?;
    let response = config.chat_request(payload).send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(upstream_error("模型服务返回", status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("模型服务返回了无效 JSON：{error}"))
}

#[tauri::command]
pub(crate) async fn generate_text(
    block_id: String,
    mut config: ModelConfig,
    payload: Value,
    instruction: String,
    before: String,
) -> Result<AiDraft, String> {
    let body = completion(&mut config, &payload).await?;
    Ok(AiDraft {
        block_id,
        before,
        after: body.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or_default().to_string(),
        instruction,
    })
}

#[tauri::command]
pub(crate) async fn agent_completion(mut config: ModelConfig, payload: Value) -> Result<Value, String> {
    completion(&mut config, &payload).await
}

#[tauri::command]
pub(crate) async fn generate_text_stream(
    app: AppHandle,
    run_id: String,
    block_id: String,
    mut config: ModelConfig,
    mut payload: Value,
    instruction: String,
    before: String,
) -> Result<AiDraft, String> {
    config.validate()?;
    payload["stream"] = Value::Bool(true);
    let response = config.chat_request(&payload).send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(upstream_error("模型服务返回", status, &body));
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut output = String::new();
    while let Some(chunk) = stream.next().await {
        pending.push_str(&String::from_utf8_lossy(&chunk.map_err(|error| error.to_string())?));
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim().trim_end_matches('\r').to_string();
            pending.drain(..=index);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue; };
            if data == "[DONE]" { continue; }
            let Ok(value) = serde_json::from_str::<Value>(data) else { continue; };
            let content = value.pointer("/choices/0/delta/content").and_then(Value::as_str).unwrap_or_default();
            if !content.is_empty() {
                output.push_str(content);
                let _ = app.emit("session://ai", StreamEvent { run_id: run_id.clone(), channel: "output".into(), content: content.into() });
            }
        }
    }
    Ok(AiDraft { block_id, before, after: output, instruction })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_endpoint_accepts_existing_models_suffix() {
        assert_eq!(model_list_endpoint("http://localhost:11434/v1/models"), "http://localhost:11434/v1/models");
        assert_eq!(model_list_endpoint("http://localhost:11434/v1/"), "http://localhost:11434/v1/models");
    }
}
