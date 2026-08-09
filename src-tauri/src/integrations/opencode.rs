use crate::process::{child_path_env, resolve_executable};
use futures_util::StreamExt;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::TcpListener,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::sleep,
};

const SERVER_USERNAME: &str = "opencode";
const MAX_LOG_LINES: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpenCodeServerPhase {
    Stopped,
    Starting,
    Healthy,
    Unhealthy,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeServerStatus {
    phase: OpenCodeServerPhase,
    pid: Option<u32>,
    port: Option<u16>,
    version: Option<String>,
    started_at: Option<String>,
    active_sessions: usize,
    last_error: Option<String>,
    recent_logs: Vec<String>,
}

#[derive(Clone)]
struct ServerConnection {
    base_url: String,
    password: String,
}

struct OpenCodeServerInner {
    phase: OpenCodeServerPhase,
    child: Option<Child>,
    connection: Option<ServerConnection>,
    pid: Option<u32>,
    port: Option<u16>,
    version: Option<String>,
    started_at: Option<String>,
    active_sessions: HashSet<String>,
    last_error: Option<String>,
    restart_attempted: bool,
    logs: Arc<Mutex<VecDeque<String>>>,
}

impl Default for OpenCodeServerInner {
    fn default() -> Self {
        Self {
            phase: OpenCodeServerPhase::Stopped,
            child: None,
            connection: None,
            pid: None,
            port: None,
            version: None,
            started_at: None,
            active_sessions: HashSet::new(),
            last_error: None,
            restart_attempted: false,
            logs: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Default)]
pub(crate) struct OpenCodeServerState(Mutex<OpenCodeServerInner>);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeModelRef {
    provider_id: String,
    model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeModelOption {
    provider_id: String,
    provider_name: String,
    model_id: String,
    model_name: String,
    is_default: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateOpenCodeSessionRequest {
    directory: String,
    title: String,
    parent_id: Option<String>,
    model: OpenCodeModelRef,
    file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeSessionResult {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpenCodePromptPhase {
    Analysis,
    Write,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptOpenCodeSessionRequest {
    directory: String,
    session_id: String,
    system: String,
    text: String,
    phase: OpenCodePromptPhase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodePromptResult {
    text: String,
    raw: Value,
}

fn now_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn random_password() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn reserve_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("无法分配 OpenCode 端口: {error}"))
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let Ok(mut values) = logs.lock() else { return };
    if values.len() >= MAX_LOG_LINES {
        values.pop_front();
    }
    values.push_back(line);
}

fn spawn_log_reader<R>(reader: R, channel: &'static str, logs: Arc<Mutex<VecDeque<String>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            push_log(&logs, format!("{channel}: {line}"));
        }
    });
}

fn snapshot(inner: &OpenCodeServerInner) -> OpenCodeServerStatus {
    OpenCodeServerStatus {
        phase: inner.phase.clone(),
        pid: inner.pid,
        port: inner.port,
        version: inner.version.clone(),
        started_at: inner.started_at.clone(),
        active_sessions: inner.active_sessions.len(),
        last_error: inner.last_error.clone(),
        recent_logs: inner
            .logs
            .lock()
            .map(|values| values.iter().cloned().collect())
            .unwrap_or_default(),
    }
}

fn get_status(state: &OpenCodeServerState) -> OpenCodeServerStatus {
    state
        .0
        .lock()
        .map(|inner| snapshot(&inner))
        .unwrap_or(OpenCodeServerStatus {
            phase: OpenCodeServerPhase::Unhealthy,
            pid: None,
            port: None,
            version: None,
            started_at: None,
            active_sessions: 0,
            last_error: Some("OpenCode Server 状态锁已损坏".into()),
            recent_logs: Vec::new(),
        })
}

fn connection(state: &OpenCodeServerState) -> Result<ServerConnection, String> {
    let inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
    if inner.phase != OpenCodeServerPhase::Healthy {
        return Err(inner
            .last_error
            .clone()
            .unwrap_or_else(|| "OpenCode Server 尚未启动".into()));
    }
    inner
        .connection
        .clone()
        .ok_or_else(|| "OpenCode Server 连接不存在".into())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())
}

async fn health(connection: &ServerConnection) -> Result<String, String> {
    let value = client()?
        .get(format!("{}/global/health", connection.base_url))
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "OpenCode 健康检查未返回版本".into())
}

async fn start_internal(
    app: &AppHandle,
    state: &OpenCodeServerState,
    reset_restart: bool,
) -> Result<OpenCodeServerStatus, String> {
    {
        let mut inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
        if inner.phase == OpenCodeServerPhase::Healthy {
            return Ok(snapshot(&inner));
        }
        if inner.phase == OpenCodeServerPhase::Starting {
            return Err("OpenCode Server 正在启动".into());
        }
        inner.phase = OpenCodeServerPhase::Starting;
        inner.last_error = None;
        if reset_restart {
            inner.restart_attempted = false;
        }
    }

    let executable = resolve_executable("opencode")?;
    let port = reserve_port()?;
    let password = random_password();
    let logs = state
        .0
        .lock()
        .map_err(|_| "OpenCode Server 状态锁已损坏")?
        .logs
        .clone();
    push_log(
        &logs,
        format!("system: starting OpenCode on 127.0.0.1:{port}"),
    );

    let mut command = Command::new(executable);
    let port_text = port.to_string();
    command
        .args([
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port_text,
            "--pure",
            "--print-logs",
            "--log-level",
            "INFO",
        ])
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = child_path_env() {
        command.env("PATH", path);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 OpenCode Server 失败: {error}"))?;
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, "stdout", logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, "stderr", logs.clone());
    }
    let candidate = ServerConnection {
        base_url: format!("http://127.0.0.1:{port}"),
        password,
    };
    let mut version = None;
    let mut failure = None;
    for _ in 0..60 {
        if let Ok(Some(status)) = child.try_wait() {
            failure = Some(format!("OpenCode Server 提前退出: {status}"));
            break;
        }
        match health(&candidate).await {
            Ok(value) => {
                version = Some(value);
                break;
            }
            Err(error) => failure = Some(error),
        }
        sleep(Duration::from_millis(100)).await;
    }
    let Some(version) = version else {
        let _ = child.kill().await;
        let error = failure.unwrap_or_else(|| "OpenCode Server 启动超时".into());
        let mut inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
        inner.phase = OpenCodeServerPhase::Unhealthy;
        inner.last_error = Some(error.clone());
        return Err(error);
    };
    {
        let mut inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
        inner.phase = OpenCodeServerPhase::Healthy;
        inner.child = Some(child);
        inner.connection = Some(candidate);
        inner.pid = pid;
        inner.port = Some(port);
        inner.version = Some(version);
        inner.started_at = Some(now_millis());
        inner.last_error = None;
    }
    let status = get_status(state);
    let _ = app.emit("opencode://server-status", &status);
    Ok(status)
}

fn start_monitor(app: AppHandle) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(3)).await;
            let (phase, candidate, may_restart) = {
                let state = app.state::<OpenCodeServerState>();
                let Ok(inner) = state.0.lock() else { break };
                (
                    inner.phase.clone(),
                    inner.connection.clone(),
                    !inner.restart_attempted,
                )
            };
            if phase != OpenCodeServerPhase::Healthy {
                break;
            }
            let healthy = match candidate.as_ref() {
                Some(value) => health(value).await.is_ok(),
                None => false,
            };
            if healthy {
                continue;
            }
            let state = app.state::<OpenCodeServerState>();
            let mut child = {
                let Ok(mut inner) = state.0.lock() else { break };
                inner.phase = OpenCodeServerPhase::Unhealthy;
                inner.last_error = Some("OpenCode Server 健康检查失败".into());
                inner.restart_attempted = true;
                inner.connection = None;
                inner.child.take()
            };
            if let Some(value) = child.as_mut() {
                let _ = value.kill().await;
            }
            let _ = app.emit("opencode://server-status", get_status(&state));
            if may_restart {
                sleep(Duration::from_secs(1)).await;
                if start_internal(&app, &state, false).await.is_ok() {
                    continue;
                }
            }
            break;
        }
    });
}

fn take_sse_frame(buffer: &mut String) -> Option<String> {
    let lf = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    let (index, separator_len) = match (lf, crlf) {
        (Some(left), Some(right)) => {
            if left.0 <= right.0 {
                left
            } else {
                right
            }
        }
        (Some(value), None) | (None, Some(value)) => value,
        (None, None) => return None,
    };
    let frame = buffer[..index].to_string();
    buffer.drain(..index + separator_len);
    Some(frame)
}

fn parse_sse_frame(frame: &str) -> Option<Value> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
    if data.trim().is_empty() {
        return None;
    }
    let value = serde_json::from_str::<Value>(data.trim()).ok()?;
    // /global/event wraps workspace events as { directory, payload }. The
    // frontend consumes the same event shape returned by the scoped /event.
    if let Some(payload) = value.get("payload").cloned() {
        Some(payload)
    } else {
        Some(value)
    }
}

fn start_event_stream(app: AppHandle) {
    tokio::spawn(async move {
        loop {
            let candidate = {
                let state = app.state::<OpenCodeServerState>();
                connection(&state)
            };
            let Ok(candidate) = candidate else { break };
            let request = match client() {
                Ok(value) => value
                    .get(format!("{}/global/event", candidate.base_url))
                    .header("Accept", "text/event-stream")
                    .basic_auth(SERVER_USERNAME, Some(&candidate.password)),
                Err(_) => break,
            };
            let response = match request
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            {
                Ok(value) => value,
                Err(_) => {
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                let Ok(chunk) = chunk else { break };
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(frame) = take_sse_frame(&mut buffer) {
                    if let Some(value) = parse_sse_frame(&frame) {
                        let _ = app.emit("opencode://event", value);
                    }
                }
            }
            sleep(Duration::from_millis(400)).await;
        }
    });
}

#[tauri::command]
pub(crate) async fn start_open_code_server(
    app: AppHandle,
    state: State<'_, OpenCodeServerState>,
) -> Result<OpenCodeServerStatus, String> {
    let status = start_internal(&app, &state, true).await?;
    start_monitor(app.clone());
    start_event_stream(app);
    Ok(status)
}

#[tauri::command]
pub(crate) async fn stop_open_code_server(
    app: AppHandle,
    state: State<'_, OpenCodeServerState>,
) -> Result<OpenCodeServerStatus, String> {
    let (mut child, candidate, sessions) = {
        let mut inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
        inner.phase = OpenCodeServerPhase::Stopping;
        (
            inner.child.take(),
            inner.connection.clone(),
            inner.active_sessions.iter().cloned().collect::<Vec<_>>(),
        )
    };
    if let (Some(connection), Ok(client)) = (candidate, client()) {
        for session in sessions {
            let _ = client
                .post(format!("{}/session/{session}/abort", connection.base_url))
                .basic_auth(SERVER_USERNAME, Some(&connection.password))
                .send()
                .await;
        }
    }
    if let Some(value) = child.as_mut() {
        let _ = value.kill().await;
        let _ = value.wait().await;
    }
    {
        let mut inner = state.0.lock().map_err(|_| "OpenCode Server 状态锁已损坏")?;
        let logs = inner.logs.clone();
        *inner = OpenCodeServerInner::default();
        inner.logs = logs;
        push_log(&inner.logs, "system: OpenCode Server stopped".into());
    }
    let status = get_status(&state);
    let _ = app.emit("opencode://server-status", &status);
    Ok(status)
}

#[tauri::command]
pub(crate) fn get_open_code_server_status(
    state: State<'_, OpenCodeServerState>,
) -> OpenCodeServerStatus {
    get_status(&state)
}

#[tauri::command]
pub(crate) async fn list_open_code_models(
    state: State<'_, OpenCodeServerState>,
    directory: String,
) -> Result<Vec<OpenCodeModelOption>, String> {
    let connection = connection(&state)?;
    let value = client()?
        .get(format!("{}/provider", connection.base_url))
        .query(&[("directory", directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let connected: HashSet<&str> = value
        .get("connected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let defaults: HashMap<&str, &str> = value
        .get("default")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|item| (key.as_str(), item)))
                .collect()
        })
        .unwrap_or_default();
    let mut output = Vec::new();
    for provider in value
        .get("all")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(provider_id) = provider.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !connected.contains(provider_id) {
            continue;
        }
        let provider_name = provider
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(provider_id);
        if let Some(models) = provider.get("models").and_then(Value::as_object) {
            for (model_id, model) in models {
                output.push(OpenCodeModelOption {
                    provider_id: provider_id.into(),
                    provider_name: provider_name.into(),
                    model_id: model_id.clone(),
                    model_name: model
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(model_id)
                        .into(),
                    is_default: defaults
                        .get(provider_id)
                        .is_some_and(|value| *value == model_id),
                });
            }
        }
    }
    output.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| left.provider_name.cmp(&right.provider_name))
            .then_with(|| left.model_name.cmp(&right.model_name))
    });
    Ok(output)
}

fn create_session_body(request: &CreateOpenCodeSessionRequest) -> Value {
    let mut body = json!({
        "title": request.title,
        "model": { "id": request.model.model_id, "providerID": request.model.provider_id },
        "permission": [
            { "permission": "*", "pattern": "*", "action": "deny" },
            { "permission": "read", "pattern": request.file_path, "action": "allow" },
            { "permission": "edit", "pattern": request.file_path, "action": "allow" },
            { "permission": "write", "pattern": request.file_path, "action": "allow" }
        ]
    });
    if let Some(parent_id) = request.parent_id.as_deref() {
        body.as_object_mut()
            .expect("session body is an object")
            .insert("parentID".into(), Value::String(parent_id.into()));
    }
    body
}

async fn decode_json_response(response: reqwest::Response, context: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let summary: String = text.chars().take(1000).collect();
        return Err(if summary.trim().is_empty() {
            format!("{context}失败（HTTP {status}）")
        } else {
            format!("{context}失败（HTTP {status}）：{summary}")
        });
    }
    serde_json::from_str(&text).map_err(|error| format!("{context}返回无效 JSON: {error}"))
}

#[tauri::command]
pub(crate) async fn create_open_code_session(
    state: State<'_, OpenCodeServerState>,
    request: CreateOpenCodeSessionRequest,
) -> Result<OpenCodeSessionResult, String> {
    let connection = connection(&state)?;
    let body = create_session_body(&request);
    let response = client()?
        .post(format!("{}/session", connection.base_url))
        .query(&[("directory", request.directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let value = decode_json_response(response, "创建 OpenCode session").await?;
    let session_id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or("OpenCode 未返回 session id")?
        .to_string();
    state
        .0
        .lock()
        .map_err(|_| "OpenCode Server 状态锁已损坏")?
        .active_sessions
        .insert(session_id.clone());
    Ok(OpenCodeSessionResult { session_id })
}

fn response_text(value: &Value) -> String {
    value
        .get("parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub(crate) async fn prompt_open_code_session(
    state: State<'_, OpenCodeServerState>,
    request: PromptOpenCodeSessionRequest,
) -> Result<OpenCodePromptResult, String> {
    let connection = connection(&state)?;
    let write = matches!(request.phase, OpenCodePromptPhase::Write);
    let body = json!({
        "system": request.system,
        "tools": {
            "read": true, "edit": write, "write": write, "apply_patch": write,
            "bash": false, "shell": false, "webfetch": false, "task": false
        },
        "parts": [{ "type": "text", "text": request.text }]
    });
    let value = client()?
        .post(format!(
            "{}/session/{}/message",
            connection.base_url, request.session_id
        ))
        .query(&[("directory", request.directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(OpenCodePromptResult {
        text: response_text(&value),
        raw: value,
    })
}

#[tauri::command]
pub(crate) async fn abort_open_code_session(
    state: State<'_, OpenCodeServerState>,
    directory: String,
    session_id: String,
) -> Result<bool, String> {
    let connection = connection(&state)?;
    client()?
        .post(format!(
            "{}/session/{session_id}/abort",
            connection.base_url
        ))
        .query(&[("directory", directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<bool>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn get_open_code_session_status(
    state: State<'_, OpenCodeServerState>,
    directory: String,
) -> Result<Value, String> {
    let connection = connection(&state)?;
    client()?
        .get(format!("{}/session/status", connection.base_url))
        .query(&[("directory", directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn get_open_code_session_messages(
    state: State<'_, OpenCodeServerState>,
    directory: String,
    session_id: String,
) -> Result<Value, String> {
    let connection = connection(&state)?;
    let response = client()?
        .get(format!(
            "{}/session/{session_id}/message",
            connection.base_url
        ))
        .query(&[("directory", directory)])
        .basic_auth(SERVER_USERNAME, Some(&connection.password))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    decode_json_response(response, "读取 OpenCode session 会话").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(parent_id: Option<&str>) -> CreateOpenCodeSessionRequest {
        CreateOpenCodeSessionRequest {
            directory: r"E:\workspace".into(),
            title: "Coordinator".into(),
            parent_id: parent_id.map(str::to_string),
            model: OpenCodeModelRef {
                provider_id: "provider".into(),
                model_id: "model".into(),
            },
            file_path: r"E:\workspace\proposal.md".into(),
        }
    }

    #[test]
    fn coordinator_session_omits_null_parent_id() {
        let body = create_session_body(&request(None));
        assert!(body.get("parentID").is_none());
        assert_eq!(
            body.pointer("/model/providerID").and_then(Value::as_str),
            Some("provider")
        );
    }

    #[test]
    fn child_session_includes_parent_id() {
        let body = create_session_body(&request(Some("ses_parent")));
        assert_eq!(
            body.get("parentID").and_then(Value::as_str),
            Some("ses_parent")
        );
    }

    #[test]
    fn sse_frame_parser_accepts_crlf_and_unwraps_global_payload() {
        let mut buffer = "data: {\"directory\":\"E:\\\\workspace\",\"payload\":{\"type\":\"message.part.delta\",\"properties\":{\"sessionID\":\"ses_1\"}}}\r\n\r\n".to_string();
        let frame = take_sse_frame(&mut buffer).expect("frame");
        let event = parse_sse_frame(&frame).expect("event");
        assert!(buffer.is_empty());
        assert_eq!(
            event.get("type").and_then(Value::as_str),
            Some("message.part.delta")
        );
        assert_eq!(
            event
                .pointer("/properties/sessionID")
                .and_then(Value::as_str),
            Some("ses_1")
        );
    }

    #[test]
    fn sse_frame_parser_accepts_lf_and_multiline_data() {
        let mut buffer = "data: {\"type\":\"session.updated\",\n data: \"properties\":{}}\n\nrest"
            .replace(" data:", "data:");
        let frame = take_sse_frame(&mut buffer).expect("frame");
        let event = parse_sse_frame(&frame).expect("event");
        assert_eq!(buffer, "rest");
        assert_eq!(
            event.get("type").and_then(Value::as_str),
            Some("session.updated")
        );
    }
}
