use serde::Serialize;
use tauri::{AppHandle, Url};
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://gitea.newxuu.top:1888/chen/tech-proposal-studio/releases/latest/download/latest.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
    message: Option<String>,
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn update_endpoint() -> Option<&'static str> {
    option_env!("TECH_PROPOSAL_UPDATE_ENDPOINT")
        .map(str::trim)
        .filter(|value| value.starts_with("https://"))
        .or(Some(DEFAULT_UPDATE_ENDPOINT))
}

fn updater_public_key() -> Option<&'static str> {
    option_env!("TECH_PROPOSAL_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn unconfigured(app: &AppHandle) -> UpdateStatus {
    UpdateStatus {
        configured: false,
        available: false,
        current_version: current_version(app),
        version: None,
        date: None,
        body: None,
        message: Some("此安装包未配置 HTTPS 升级地址或签名公钥，请使用正式发布版本。".into()),
    }
}

async fn find_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let public_key = updater_public_key().ok_or("升级签名公钥未配置")?;
    let endpoint = Url::parse(update_endpoint().ok_or("HTTPS 升级地址未配置")?)
        .map_err(|error| format!("升级地址无效: {error}"))?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("升级地址无效: {error}"))?
        .build()
        .map_err(|error| format!("无法初始化升级服务: {error}"))?;
    updater.check().await.map_err(|error| format!("检查更新失败: {error}"))
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    if updater_public_key().is_none() || update_endpoint().is_none() {
        return Ok(unconfigured(&app));
    }
    let current = current_version(&app);
    let Some(update) = find_update(&app).await? else {
        return Ok(UpdateStatus {
            configured: true, available: false, current_version: current,
            version: None, date: None, body: None,
            message: Some("当前已是最新版本。".into()),
        });
    };
    Ok(UpdateStatus {
        configured: true,
        available: true,
        current_version: current,
        version: Some(update.version),
        date: update.date.map(|date| date.to_string()),
        body: update.body,
        message: None,
    })
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle) -> Result<(), String> {
    let Some(update) = find_update(&app).await? else {
        return Err("没有可安装的新版本。".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载或安装更新失败: {error}"))?;
    app.restart();
}
