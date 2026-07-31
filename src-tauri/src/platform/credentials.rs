const CREDENTIAL_SERVICE: &str = "com.techproposal.studio";
const LEGACY_CREDENTIAL_SERVICE: &str = "cn.gouan.writer";

pub(crate) fn load_secret(name: &str) -> String {
    let current = keyring::Entry::new(CREDENTIAL_SERVICE, name).ok();
    if let Some(value) = current
        .as_ref()
        .and_then(|entry| entry.get_password().ok())
        .filter(|value| !value.is_empty())
    {
        return value;
    }
    let legacy = keyring::Entry::new(LEGACY_CREDENTIAL_SERVICE, name)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .unwrap_or_default();
    if !legacy.is_empty() {
        if let Some(entry) = current {
            let _ = entry.set_password(&legacy);
        }
    }
    legacy
}

#[tauri::command]
pub(crate) fn store_secret(name: String, value: String) -> Result<(), String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, &name)
        .map_err(|error| error.to_string())?
        .set_password(&value)
        .map_err(|error| error.to_string())
}
