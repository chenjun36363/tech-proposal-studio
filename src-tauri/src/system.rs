#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    let normalized = url.trim();
    let lowercase = normalized.to_ascii_lowercase();
    if normalized.chars().any(char::is_control)
        || !(lowercase.starts_with("https://") || lowercase.starts_with("http://"))
    {
        return Err("仅允许打开 http/https 来源链接".into());
    }
    open::that(normalized).map_err(|error| format!("无法打开来源链接: {error}"))
}
