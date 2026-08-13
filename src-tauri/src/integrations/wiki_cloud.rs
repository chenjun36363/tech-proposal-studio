use crate::load_secret;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiCloudConfig {
    enabled: bool,
    base_url: String,
    workspace_id: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    knowledge_base_ids: Vec<String>,
    #[serde(default = "default_retrieval_mode")]
    retrieval_mode: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiCloudRetrievalHit {
    knowledge_base_id: String,
    knowledge_base_name: String,
    document_id: String,
    chunk_id: String,
    version_no: i32,
    title: String,
    heading_path: String,
    content: String,
    score: f64,
    lexical_score: f64,
    semantic_score: f64,
    fusion_score: f64,
    rerank_score: Option<f64>,
    quality: String,
    #[serde(default)]
    matched_fields: Vec<String>,
    fusion_method: String,
    source_uri: Option<String>,
    locator: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    code: i32,
    message: String,
    data: Option<T>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WikiCloudConnectionTest {
    ok: bool,
    hit_count: usize,
    message: String,
}

fn default_retrieval_mode() -> String {
    "HYBRID".into()
}

fn default_limit() -> usize {
    8
}

fn endpoint(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("wiki-cloud 地址必须以 http:// 或 https:// 开头".into());
    }
    if base.is_empty() {
        return Err("请填写 wiki-cloud 服务地址".into());
    }
    if base.ends_with("/api/v1/retrieval/search") {
        Ok(base.into())
    } else {
        Ok(format!("{base}/api/v1/retrieval/search"))
    }
}

fn api_key(config: &WikiCloudConfig) -> Result<String, String> {
    if !config.api_key.trim().is_empty() {
        return Ok(config.api_key.trim().into());
    }
    let name = format!(
        "wiki-cloud-api-key:{}",
        if config.workspace_id.trim().is_empty() {
            "default"
        } else {
            config.workspace_id.trim()
        }
    );
    let key = load_secret(&name);
    if key.trim().is_empty() {
        Err("未配置 wiki-cloud API Key，请先在设置中保存连接凭据".into())
    } else {
        Ok(key)
    }
}

fn validate(config: &WikiCloudConfig, query: &str) -> Result<(), String> {
    if !config.enabled {
        return Err("wiki-cloud 连接尚未启用".into());
    }
    endpoint(&config.base_url)?;
    if config.workspace_id.trim().is_empty() {
        return Err("请填写 wiki-cloud Workspace ID".into());
    }
    if query.trim().is_empty() {
        return Err("请输入检索关键词".into());
    }
    if query.chars().count() > 500 {
        return Err("检索关键词不能超过 500 个字符".into());
    }
    Ok(())
}

async fn perform_search(
    query: &str,
    config: &WikiCloudConfig,
    retrieval_mode: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<WikiCloudRetrievalHit>, String> {
    validate(config, query)?;
    let url = endpoint(&config.base_url)?;
    let key = api_key(config)?;
    let mode = retrieval_mode.unwrap_or(&config.retrieval_mode);
    let mode = if mode == "LEXICAL_ONLY" {
        "LEXICAL_ONLY"
    } else {
        "HYBRID"
    };
    let requested_limit = limit.unwrap_or(config.limit).clamp(1, 50);
    let knowledge_base_ids = if config.knowledge_base_ids.is_empty() {
        serde_json::Value::Null
    } else {
        json!(config.knowledge_base_ids)
    };
    let body = json!({
        "workspaceId": config.workspace_id.trim(),
        "query": query.trim(),
        "knowledgeBaseIds": knowledge_base_ids,
        "categoryIds": null,
        "tagIds": null,
        "qualities": null,
        "limit": requested_limit,
        "retrievalMode": mode,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("创建 wiki-cloud 客户端失败: {error}"))?;
    let response = client
        .post(url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("连接 wiki-cloud 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 wiki-cloud 响应失败: {error}"))?;
    if !status.is_success() {
        let message = serde_json::from_str::<ApiResponse<serde_json::Value>>(&text)
            .ok()
            .map(|payload| payload.message)
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| text.chars().take(240).collect());
        return Err(format!(
            "wiki-cloud 请求失败（HTTP {}）：{}",
            status.as_u16(),
            message
        ));
    }
    let payload: ApiResponse<Vec<WikiCloudRetrievalHit>> =
        serde_json::from_str(&text).map_err(|error| format!("wiki-cloud 响应格式无效: {error}"))?;
    if payload.code != 0 {
        return Err(format!(
            "wiki-cloud 返回错误 {}：{}",
            payload.code, payload.message
        ));
    }
    Ok(payload.data.unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn wiki_cloud_search(
    query: String,
    config: WikiCloudConfig,
) -> Result<Vec<WikiCloudRetrievalHit>, String> {
    perform_search(&query, &config, None, None).await
}

#[tauri::command]
pub(crate) async fn wiki_cloud_test_connection(
    config: WikiCloudConfig,
) -> Result<WikiCloudConnectionTest, String> {
    let hits = perform_search("构案连接测试", &config, Some("LEXICAL_ONLY"), Some(1)).await?;
    Ok(WikiCloudConnectionTest {
        ok: true,
        hit_count: hits.len(),
        message: "连接成功，认证与工作区访问范围有效".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(base_url: &str) -> WikiCloudConfig {
        WikiCloudConfig {
            enabled: true,
            base_url: base_url.into(),
            workspace_id: "workspace-id".into(),
            api_key: "key".into(),
            knowledge_base_ids: vec![],
            retrieval_mode: default_retrieval_mode(),
            limit: default_limit(),
        }
    }

    #[test]
    fn appends_retrieval_path() {
        assert_eq!(
            endpoint("http://127.0.0.1:5175/").unwrap(),
            "http://127.0.0.1:5175/api/v1/retrieval/search"
        );
    }

    #[test]
    fn preserves_complete_retrieval_path() {
        assert_eq!(
            endpoint("https://wiki.example/api/v1/retrieval/search").unwrap(),
            "https://wiki.example/api/v1/retrieval/search"
        );
    }

    #[test]
    fn rejects_non_http_endpoint() {
        assert!(endpoint("file:///tmp/wiki").is_err());
        assert!(validate(&config("file:///tmp/wiki"), "query").is_err());
    }
}
