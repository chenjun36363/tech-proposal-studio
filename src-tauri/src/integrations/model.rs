use crate::{load_secret, StreamEvent};
use futures_util::StreamExt;
use reqwest::{RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

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
            .post(format!(
                "{}/chat/completions",
                self.base_url.trim_end_matches('/')
            ))
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
    if base.to_ascii_lowercase().ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    }
}

fn is_anthropic_endpoint(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("api.anthropic.com")
}

fn upstream_error(prefix: &str, status: StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
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
            request
                .header("x-api-key", &config.api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(&config.api_key)
        };
    }
    let response = config
        .with_headers(request)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(upstream_error("模型列表请求返回", status, &body));
    }
    serde_json::from_str(&body).map_err(|error| format!("上游模型列表不是有效 JSON: {error}"))
}

async fn completion(config: &mut ModelConfig, payload: &Value) -> Result<Value, String> {
    config.validate()?;
    let response = config
        .chat_request(payload)
        .send()
        .await
        .map_err(|error| error.to_string())?;
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
        after: body
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        instruction,
    })
}

#[tauri::command]
pub(crate) async fn agent_completion(
    mut config: ModelConfig,
    payload: Value,
) -> Result<Value, String> {
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
    let response = config
        .chat_request(&payload)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(upstream_error("模型服务返回", status, &body));
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut output = String::new();
    while let Some(chunk) = stream.next().await {
        pending.push_str(&String::from_utf8_lossy(
            &chunk.map_err(|error| error.to_string())?,
        ));
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim().trim_end_matches('\r').to_string();
            pending.drain(..=index);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let content = value
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !content.is_empty() {
                output.push_str(content);
                let _ = app.emit(
                    "session://ai",
                    StreamEvent {
                        run_id: run_id.clone(),
                        channel: "output".into(),
                        content: content.into(),
                    },
                );
            }
        }
    }
    Ok(AiDraft {
        block_id,
        before,
        after: output,
        instruction,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProxyRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<Value>,
    timeout_ms: u64,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    provider_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelProxyResponse {
    status: u16,
    body: String,
}

#[derive(Default)]
struct ModelProxyRequests {
    active: HashMap<String, oneshot::Sender<()>>,
    cancelled: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct ModelProxyState(Mutex<ModelProxyRequests>);

impl ModelProxyState {
    fn register(&self, run_id: &str) -> Result<Option<oneshot::Receiver<()>>, String> {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let mut requests = self
            .0
            .lock()
            .map_err(|_| "模型请求状态不可用".to_string())?;
        if requests.cancelled.remove(run_id) {
            return Ok(None);
        }
        requests.active.insert(run_id.to_string(), cancel_tx);
        Ok(Some(cancel_rx))
    }

    fn cancel(&self, run_id: String) -> Result<(), String> {
        let mut requests = self
            .0
            .lock()
            .map_err(|_| "模型请求状态不可用".to_string())?;
        if let Some(cancel) = requests.active.remove(&run_id) {
            let _ = cancel.send(());
        } else {
            requests.cancelled.insert(run_id);
        }
        Ok(())
    }

    fn finish(&self, run_id: &str) {
        if let Ok(mut requests) = self.0.lock() {
            requests.active.remove(run_id);
            requests.cancelled.remove(run_id);
        }
    }
}

fn header_has(headers: &HashMap<String, String>, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    headers.keys().any(|key| key.to_ascii_lowercase() == lower)
}

fn resolve_proxy_api_key(request: &ModelProxyRequest) -> String {
    if !request.api_key.trim().is_empty() {
        return request.api_key.clone();
    }
    if let Some(provider_id) = request
        .provider_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let named = load_secret(&format!("llm-provider:{provider_id}"));
        if !named.trim().is_empty() {
            return named;
        }
    }
    load_secret("openai-api-key")
}

fn inject_protocol_auth(headers: &mut HashMap<String, String>, protocol: &str, api_key: &str) {
    if api_key.trim().is_empty() {
        return;
    }
    match protocol {
        "anthropic-messages" => {
            if !header_has(headers, "x-api-key") {
                headers.insert("x-api-key".into(), api_key.to_string());
            }
            if !header_has(headers, "anthropic-version") {
                headers.insert("anthropic-version".into(), "2023-06-01".into());
            }
        }
        "google-generative-ai" => {
            if !header_has(headers, "x-goog-api-key") {
                headers.insert("x-goog-api-key".into(), api_key.to_string());
            }
        }
        _ => {
            if !header_has(headers, "authorization") {
                headers.insert("Authorization".into(), format!("Bearer {api_key}"));
            }
        }
    }
}

fn build_proxy_request(request: &ModelProxyRequest) -> Result<reqwest::RequestBuilder, String> {
    if request.url.trim().is_empty() {
        return Err("模型请求 URL 为空".into());
    }
    let api_key = resolve_proxy_api_key(request);
    let local = ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|host| request.url.contains(host));
    if api_key.trim().is_empty() && !local {
        return Err("API Key 未配置".into());
    }

    let mut headers = request.headers.clone();
    inject_protocol_auth(&mut headers, &request.protocol, &api_key);

    let client = reqwest::Client::new();
    let method = request.method.trim().to_ascii_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&request.url),
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        other => return Err(format!("不支持的 HTTP 方法: {other}")),
    };
    builder = builder.timeout(Duration::from_millis(if request.timeout_ms == 0 {
        60_000
    } else {
        request.timeout_ms
    }));
    for (key, value) in &headers {
        builder = builder.header(key, value);
    }
    if let Some(body) = &request.body {
        if !body.is_null() {
            builder = builder.json(body);
        }
    }
    Ok(builder)
}

#[tauri::command]
pub(crate) async fn model_proxy_json(
    run_id: String,
    request: ModelProxyRequest,
    state: State<'_, ModelProxyState>,
) -> Result<ModelProxyResponse, String> {
    let Some(cancel_rx) = state.register(&run_id)? else {
        return Err("模型请求已取消".into());
    };

    let request_future = async {
        let response = build_proxy_request(&request)?
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(|error| error.to_string())?;
        Ok(ModelProxyResponse { status, body })
    };
    let result = tokio::select! {
        response = request_future => response,
        _ = cancel_rx => Err("模型请求已取消".into()),
    };
    state.finish(&run_id);
    result
}

#[tauri::command]
pub(crate) fn model_proxy_cancel(
    run_id: String,
    state: State<'_, ModelProxyState>,
) -> Result<(), String> {
    state.cancel(run_id)
}

#[tauri::command]
pub(crate) async fn model_proxy_stream(
    app: AppHandle,
    run_id: String,
    request: ModelProxyRequest,
) -> Result<(), String> {
    let response = build_proxy_request(&request)?
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(upstream_error("模型服务返回", status, &body));
    }

    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    while let Some(chunk) = stream.next().await {
        pending.push_str(&String::from_utf8_lossy(
            &chunk.map_err(|error| error.to_string())?,
        ));
        while let Some(index) = pending.find('\n') {
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            if line.is_empty() {
                continue;
            }
            let data = line
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(line.trim());
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let _ = app.emit(
                "session://ai",
                StreamEvent {
                    run_id: run_id.clone(),
                    channel: "output".into(),
                    content: data.to_string(),
                },
            );
        }
    }
    if !pending.trim().is_empty() {
        let data = pending
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(pending.trim());
        if data != "[DONE]" && !data.is_empty() {
            let _ = app.emit(
                "session://ai",
                StreamEvent {
                    run_id: run_id.clone(),
                    channel: "output".into(),
                    content: data.to_string(),
                },
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_endpoint_accepts_existing_models_suffix() {
        assert_eq!(
            model_list_endpoint("http://localhost:11434/v1/models"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            model_list_endpoint("http://localhost:11434/v1/"),
            "http://localhost:11434/v1/models"
        );
    }

    #[test]
    fn model_proxy_cancellation_handles_both_registration_orders() {
        let state = ModelProxyState::default();
        state.cancel("early".into()).unwrap();
        assert!(state.register("early").unwrap().is_none());

        let mut active = state.register("active").unwrap().unwrap();
        state.cancel("active".into()).unwrap();
        assert!(active.try_recv().is_ok());
        state.finish("active");
    }
}
