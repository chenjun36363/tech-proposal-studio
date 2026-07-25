use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinerUConfig {
    pub base_url: String,
    pub api_key: String,
    pub model_version: String,
    pub language: String,
    pub is_ocr: bool,
    pub enable_table: bool,
    pub enable_formula: bool,
    pub timeout_seconds: u64,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertDocumentRequest {
    pub source_path: String,
    pub workspace_root: String,
    pub config: MinerUConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertDocumentResult {
    pub markdown: String,
    pub asset_relative_dir: Option<String>,
    pub source_file_name: String,
}

fn trim_trailing_slash(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn safe_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "document".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn rewrite_image_paths(markdown: &str, asset_rel: &str) -> String {
    let asset = asset_rel.replace('\\', "/").trim_matches('/').to_string();
    let mut out = markdown.replace("](./images/", &format!("]({asset}/"));
    out = out.replace("](images/", &format!("]({asset}/"));
    out = out.replace("](./Images/", &format!("]({asset}/"));
    out = out.replace("](Images/", &format!("]({asset}/"));
    // bare relative paths sometimes used without images/ prefix but under images dir in zip
    out
}

fn extract_zip_markdown_and_images(
    zip_bytes: &[u8],
    workspace_root: &Path,
    source_file_name: &str,
) -> Result<(String, Option<String>), String> {
    let cursor = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("MinerU 结果压缩包无效: {e}"))?;

    let mut markdown: Option<String> = None;
    let mut image_entries: Vec<(String, Vec<u8>)> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 MinerU 压缩包条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let lower = name.to_ascii_lowercase();
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取压缩包文件失败 ({name}): {e}"))?;

        if lower.ends_with("full.md") {
            markdown = Some(String::from_utf8_lossy(&buf).into_owned());
            continue;
        }

        // Media files under any .../images/... path, or common image extensions at zip root
        let is_image_path = lower.contains("/images/") || lower.starts_with("images/");
        let is_image_ext = matches!(
            Path::new(&lower)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or(""),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
        );
        if is_image_path || (is_image_ext && !lower.ends_with(".md")) {
            let file_name = Path::new(&name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("image.bin")
                .to_string();
            image_entries.push((file_name, buf));
        }
    }

    let raw_md = markdown.ok_or_else(|| "MinerU 结果压缩包中未找到 full.md".to_string())?;

    if image_entries.is_empty() {
        return Ok((raw_md, None));
    }

    let stem = safe_stem(source_file_name);
    let rel = format!("assets/import-{stem}");
    let dest_dir = workspace_root.join("assets").join(format!("import-{stem}"));
    fs::create_dir_all(&dest_dir).map_err(|e| format!("创建图片目录失败: {e}"))?;

    let mut used_names = std::collections::HashSet::new();
    for (name, bytes) in image_entries {
        let mut final_name = name.clone();
        if used_names.contains(&final_name.to_ascii_lowercase()) {
            let path = PathBuf::from(&name);
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image");
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default();
            let mut n = 1;
            loop {
                let candidate = format!("{stem}-{n}{ext}");
                if !used_names.contains(&candidate.to_ascii_lowercase()) {
                    final_name = candidate;
                    break;
                }
                n += 1;
            }
        }
        used_names.insert(final_name.to_ascii_lowercase());
        let path = dest_dir.join(&final_name);
        fs::write(&path, bytes).map_err(|e| format!("写入图片失败 ({final_name}): {e}"))?;
    }

    let rewritten = rewrite_image_paths(&raw_md, &rel);
    Ok((rewritten, Some(rel)))
}

async fn send_json(
    client: &reqwest::Client,
    url: &str,
    method: &str,
    api_key: &str,
    body: Option<&Value>,
    timeout_secs: u64,
) -> Result<Value, String> {
    let mut builder = client
        .request(
            if method.eq_ignore_ascii_case("POST") {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            url,
        )
        .timeout(Duration::from_secs(timeout_secs.max(30)))
        .header("Accept", "*/*")
        .header("Authorization", format!("Bearer {api_key}"));

    if let Some(payload) = body {
        builder = builder
            .header("Content-Type", "application/json")
            .json(payload);
    }

    let response = builder.send().await.map_err(|e| format!("MinerU 调用失败: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 MinerU 响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("MinerU HTTP {status}: {text}"));
    }
    let json: Value =
        serde_json::from_str(&text).map_err(|e| format!("MinerU 返回非 JSON: {e}; body={text}"))?;
    let code = json.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        let msg = json
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or(text.as_str());
        return Err(format!("MinerU 返回错误: {msg}"));
    }
    Ok(json)
}

async fn poll_batch_result(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    batch_id: &str,
    timeout_secs: u64,
    poll_interval_secs: u64,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.max(30));
    let interval = Duration::from_secs(poll_interval_secs.clamp(1, 30));
    let mut last: Option<Value> = None;

    while Instant::now() < deadline {
        let url = format!("{base_url}/api/v4/extract-results/batch/{batch_id}");
        let response = send_json(client, &url, "GET", api_key, None, timeout_secs).await?;
        let item = response
            .pointer("/data/extract_result/0")
            .cloned()
            .or_else(|| response.pointer("/data/extract_result").cloned())
            .unwrap_or(Value::Null);
        last = Some(item.clone());
        let state = item
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if state == "done" {
            return Ok(item);
        }
        if state == "failed" {
            let error = item
                .get("err_msg")
                .and_then(Value::as_str)
                .unwrap_or("未知错误");
            return Err(format!("MinerU 解析失败: {error}"));
        }
        tokio::time::sleep(interval).await;
    }

    Err(format!(
        "MinerU 解析超时，最后状态: {}",
        last.map(|v| v.to_string()).unwrap_or_else(|| "null".into())
    ))
}

fn fill_mineru_api_key(config: &mut MinerUConfig, workspace_root: &Path) {
    if !config.api_key.trim().is_empty() {
        return;
    }
    // 1) Workspace connections.json (authoritative for desktop)
    let conn_path = workspace_root.join(".gouan").join("connections.json");
    if let Ok(text) = fs::read_to_string(&conn_path) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(key) = value
                .pointer("/mineru/apiKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                config.api_key = key.to_string();
            }
            if config.base_url.trim().is_empty() {
                if let Some(base) = value.pointer("/mineru/baseUrl").and_then(Value::as_str) {
                    config.base_url = base.to_string();
                }
            }
        }
    }
    if !config.api_key.trim().is_empty() {
        return;
    }
    // 2) OS keyring mirror
    if let Ok(entry) = keyring::Entry::new("com.techproposal.studio", "mineru-api-key") {
        if let Ok(value) = entry.get_password() {
            if !value.trim().is_empty() {
                config.api_key = value;
            }
        }
    }
}

pub async fn convert_document(req: ConvertDocumentRequest) -> Result<ConvertDocumentResult, String> {
    let mut config = req.config;
    let workspace_root = PathBuf::from(&req.workspace_root);
    if req.workspace_root.trim().is_empty() {
        return Err("请先在设置中配置工作目录".into());
    }
    fill_mineru_api_key(&mut config, &workspace_root);
    if config.api_key.trim().is_empty() {
        return Err(format!(
            "请先在设置中配置 MinerU API Key（也可写入 {}）",
            workspace_root.join(".gouan").join("connections.json").display()
        ));
    }

    let source = PathBuf::from(&req.source_path);
    if !source.is_file() {
        return Err(format!("源文件不存在: {}", req.source_path));
    }
    fs::create_dir_all(workspace_root.join("assets"))
        .map_err(|e| format!("创建 assets 目录失败: {e}"))?;

    let file_name = source
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    let lower = file_name.to_ascii_lowercase();
    if !(lower.ends_with(".pdf") || lower.ends_with(".doc") || lower.ends_with(".docx")) {
        return Err("仅支持 .pdf / .doc / .docx（推荐 .pdf 或 .docx）".into());
    }

    let bytes = fs::read(&source).map_err(|e| format!("读取源文件失败: {e}"))?;
    if bytes.is_empty() {
        return Err("源文件为空".into());
    }

    let base_url = {
        let raw = trim_trailing_slash(&config.base_url);
        if raw.is_empty() {
            "https://mineru.net".into()
        } else {
            raw
        }
    };
    let timeout_secs = config.timeout_seconds.clamp(30, 1800);
    let poll_secs = config.poll_interval_seconds.clamp(1, 30);
    let model_version = if config.model_version.trim().is_empty() {
        "vlm".into()
    } else {
        config.model_version.trim().to_string()
    };
    let language = if config.language.trim().is_empty() {
        "ch".into()
    } else {
        config.language.trim().to_string()
    };
    let data_id = format!("gouan-{}", uuid_like());

    let request_body = json!({
        "files": [{
            "name": file_name,
            "data_id": data_id,
            "is_ocr": config.is_ocr,
        }],
        "model_version": model_version,
        "language": language,
        "enable_table": config.enable_table,
        "enable_formula": config.enable_formula,
    });

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let create_url = format!("{base_url}/api/v4/file-urls/batch");
    let create_result = send_json(
        &client,
        &create_url,
        "POST",
        &config.api_key,
        Some(&request_body),
        timeout_secs,
    )
    .await?;

    let batch_id = create_result
        .pointer("/data/batch_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let upload_url = create_result
        .pointer("/data/file_urls/0")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if batch_id.is_empty() || upload_url.is_empty() {
        return Err(format!("MinerU 未返回上传链接: {create_result}"));
    }

    // PUT raw bytes only — do NOT set Content-Type. OSS pre-signed URLs from MinerU
    // sign without Content-Type; default form encodings cause SignatureDoesNotMatch.
    let upload_resp = client
        .put(&upload_url)
        .timeout(Duration::from_secs(timeout_secs.max(60)))
        .header(reqwest::header::ACCEPT, "*/*")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("MinerU 文件上传失败: {e}"))?;
    if !upload_resp.status().is_success() {
        let status = upload_resp.status();
        let body = upload_resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(400).collect();
        return Err(format!(
            "MinerU 文件上传失败 HTTP {status}: {snippet}"
        ));
    }

    let extract_result = poll_batch_result(
        &client,
        &base_url,
        &config.api_key,
        &batch_id,
        timeout_secs,
        poll_secs,
    )
    .await?;

    let full_zip_url = extract_result
        .get("full_zip_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if full_zip_url.is_empty() {
        return Err(format!("MinerU 未返回解析结果压缩包: {extract_result}"));
    }

    let zip_resp = client
        .get(&full_zip_url)
        .timeout(Duration::from_secs(timeout_secs.max(60)))
        .send()
        .await
        .map_err(|e| format!("MinerU 结果下载失败: {e}"))?;
    if !zip_resp.status().is_success() {
        return Err(format!(
            "MinerU 结果下载失败 HTTP {}",
            zip_resp.status()
        ));
    }
    let zip_bytes = zip_resp
        .bytes()
        .await
        .map_err(|e| format!("读取 MinerU 压缩包失败: {e}"))?;

    let (markdown, asset_relative_dir) =
        extract_zip_markdown_and_images(&zip_bytes, &workspace_root, &file_name)?;
    if markdown.trim().is_empty() {
        return Err("MinerU 返回的 Markdown 为空".into());
    }

    Ok(ConvertDocumentResult {
        markdown,
        asset_relative_dir,
        source_file_name: file_name,
    })
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::rewrite_image_paths;

    #[test]
    fn rewrites_common_image_prefixes() {
        let md = "![a](images/a.png)\n![b](./images/b.jpg)\n![c](Images/c.gif)";
        let out = rewrite_image_paths(md, "assets/import-demo");
        assert!(out.contains("](assets/import-demo/a.png)"));
        assert!(out.contains("](assets/import-demo/b.jpg)"));
        assert!(out.contains("](assets/import-demo/c.gif)"));
    }
}
