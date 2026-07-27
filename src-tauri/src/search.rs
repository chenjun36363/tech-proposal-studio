use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
pub(crate) struct SearchConfig {
    provider: String,
    endpoint: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    #[serde(default = "default_search_engines")]
    engines: Vec<String>,
}

fn default_search_engines() -> Vec<String> {
    vec!["baidu".into(), "360search".into(), "bing".into()]
}

#[derive(Serialize)]
pub(crate) struct SearchResult {
    title: String,
    url: String,
    excerpt: String,
}

#[tauri::command]
pub(crate) async fn search_web(
    query: String,
    config: SearchConfig,
) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::new();
    let response = if config.provider == "searxng" {
        let engines = if config.engines.is_empty() {
            default_search_engines()
        } else {
            config.engines.clone()
        };
        client
            .get(format!("{}/search", config.endpoint.trim_end_matches('/')))
            .query(&[("q", query.as_str()), ("format", "json")])
            .query(&[("engines", engines.join(","))])
            .send()
            .await
    } else {
        client
            .get(if config.endpoint.is_empty() {
                "https://api.search.brave.com/res/v1/web/search"
            } else {
                &config.endpoint
            })
            .query(&[("q", query.as_str())])
            .header("X-Subscription-Token", config.api_key)
            .send()
            .await
    }
    .map_err(|error| error.to_string())?;
    let json: Value = response.json().await.map_err(|error| error.to_string())?;
    if config.provider == "searxng"
        && json
            .get("results")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        if let Some(failures) = json.get("unresponsive_engines").and_then(Value::as_array) {
            if !failures.is_empty() {
                let detail = failures
                    .iter()
                    .filter_map(|item| item.as_array())
                    .map(|item| {
                        format!(
                            "{}（{}）",
                            item.first().and_then(Value::as_str).unwrap_or("未知引擎"),
                            item.get(1).and_then(Value::as_str).unwrap_or("失败")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("、");
                return Err(format!("上游搜索失败：{detail}"));
            }
        }
    }
    let items = if config.provider == "searxng" {
        json.get("results")
    } else {
        json.pointer("/web/results")
    }
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
    Ok(items
        .into_iter()
        .take(8)
        .map(|item| SearchResult {
            title: item
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            url: item
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            excerpt: item
                .get(if config.provider == "searxng" {
                    "content"
                } else {
                    "description"
                })
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
        })
        .collect())
}
