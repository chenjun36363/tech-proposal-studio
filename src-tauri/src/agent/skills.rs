use crate::{app_dir, child_path_env, resolve_workdir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{timeout, Duration},
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_METADATA_BYTES: u64 = 200 * 1024;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 2_000;
const MAX_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const CLAWHUB: &str = "https://clawhub.ai";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    Builtin,
    Global,
    Workspace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReference {
    pub name: String,
    pub scope: SkillScope,
    pub base_dir: String,
    pub skill_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    #[serde(flatten)]
    pub reference: SkillReference,
    pub description: String,
    pub allowed_tools: Vec<String>,
    pub read_only: bool,
    pub installed_at: Option<u64>,
    pub available: bool,
    pub source: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiscovery {
    pub skills: Vec<SkillSummary>,
    pub global_root: String,
    pub workspace_root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReadResult {
    pub reference: SkillReference,
    pub metadata: SkillMetadata,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidationResult {
    pub name: Option<String>,
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub requested_tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateRequest {
    pub scope: SkillScope,
    pub workspace_root: Option<String>,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallRequest {
    pub scope: SkillScope,
    pub workspace_root: Option<String>,
    pub source: String,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetRequest {
    pub scope: SkillScope,
    pub workspace_root: Option<String>,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRuntimeItem {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub install_hint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub duration_ms: u128,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommandRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub workspace_root: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
}
fn default_timeout() -> u64 {
    120_000
}

fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || name == "."
        || name == ".."
    {
        return Err("Skill 名称只能包含字母、数字、短横线和下划线，且长度不超过 64".into());
    }
    Ok(name.to_string())
}

fn roots(
    app: &AppHandle,
    workspace_root: Option<&str>,
) -> Result<Vec<(SkillScope, PathBuf)>, String> {
    let base = app_dir(app)?;
    let builtin = base.join("builtin-skills");
    let global = base.join("skills");
    fs::create_dir_all(&builtin).map_err(|e| e.to_string())?;
    fs::create_dir_all(&global).map_err(|e| e.to_string())?;
    seed_builtins(&builtin)?;
    let mut result = vec![(SkillScope::Builtin, builtin), (SkillScope::Global, global)];
    if let Some(root) = workspace_root.map(str::trim).filter(|s| !s.is_empty()) {
        let workspace = PathBuf::from(root).join(".gouan").join("skills");
        fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        result.push((SkillScope::Workspace, workspace));
    }
    Ok(result)
}

fn root_for(
    app: &AppHandle,
    scope: &SkillScope,
    workspace_root: Option<&str>,
) -> Result<PathBuf, String> {
    roots(app, workspace_root)?
        .into_iter()
        .find(|(candidate, _)| candidate == scope)
        .map(|(_, path)| path)
        .ok_or_else(|| match scope {
            SkillScope::Workspace => "工作区目录不能为空".into(),
            SkillScope::Builtin => "内置 Skill 不可修改".into(),
            _ => "Skill 目录不可用".into(),
        })
}

fn metadata_file(dir: &Path) -> Option<PathBuf> {
    ["SKILL.md", "skill.md", "skill.json", "README.md"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn yaml_scalar(yaml: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    yaml.lines()
        .find_map(|line| {
            line.strip_prefix(&prefix)
                .map(|value| value.trim().trim_matches(['\'', '"']).to_string())
        })
        .filter(|v| !v.is_empty())
}

fn yaml_list(yaml: &str, key: &str) -> Vec<String> {
    let prefix = format!("{key}:");
    let Some(line) = yaml.lines().find(|line| line.starts_with(&prefix)) else {
        return Vec::new();
    };
    let value = line[prefix.len()..].trim();
    if value.starts_with('[') && value.ends_with(']') {
        return value[1..value.len() - 1]
            .split(',')
            .map(|s| s.trim().trim_matches(['\'', '"']).to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    value.split_whitespace().map(str::to_string).collect()
}

fn parse_metadata(file: &Path) -> Result<SkillMetadata, String> {
    let size = fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > MAX_METADATA_BYTES {
        return Err("Skill 元数据超过 200KB".into());
    }
    let raw = fs::read_to_string(file).map_err(|e| format!("读取 Skill 元数据失败: {e}"))?;
    if file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    {
        let value: Value =
            serde_json::from_str(&raw).map_err(|e| format!("skill.json 无效: {e}"))?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or("skill.json 缺少 name")?;
        let description = value
            .get("description")
            .and_then(Value::as_str)
            .ok_or("skill.json 缺少 description")?;
        let allowed_tools = value
            .get("allowed-tools")
            .or_else(|| value.get("allowedTools"))
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        return Ok(SkillMetadata {
            name: safe_name(name)?,
            description: description.trim().to_string(),
            allowed_tools,
            metadata: value.get("metadata").cloned().unwrap_or(Value::Null),
        });
    }
    let normalized = raw.trim_start_matches('\u{feff}');
    if !normalized.starts_with("---") {
        if file
            .file_name()
            .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("README.md"))
        {
            let name = safe_name(
                file.parent()
                    .and_then(Path::file_name)
                    .and_then(|n| n.to_str())
                    .unwrap_or("readme-skill"),
            )?;
            let description = normalized
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("README Skill")
                .trim()
                .trim_start_matches('#')
                .trim()
                .to_string();
            return Ok(SkillMetadata {
                name,
                description,
                allowed_tools: Vec::new(),
                metadata: Value::Null,
            });
        }
        return Err("SKILL.md frontmatter 必须以 --- 开始".into());
    }
    let rest = &normalized[3..];
    let end = rest
        .find("---")
        .ok_or("SKILL.md frontmatter 缺少结束标记")?;
    let yaml = &rest[..end];
    let name = safe_name(&yaml_scalar(yaml, "name").ok_or("SKILL.md 缺少 name")?)?;
    let description = yaml_scalar(yaml, "description").ok_or("SKILL.md 缺少 description")?;
    Ok(SkillMetadata {
        name,
        description,
        allowed_tools: yaml_list(yaml, "allowed-tools"),
        metadata: Value::Null,
    })
}

fn walk_validate(root: &Path, current: &Path, errors: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(current) else {
        errors.push(format!("无法读取目录: {}", current.display()));
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            errors.push(format!(
                "Skill 内禁止符号链接: {}",
                path.strip_prefix(root).unwrap_or(&path).display()
            ));
            continue;
        }
        if meta.is_dir() {
            walk_validate(root, &path, errors);
            continue;
        }
        if matches!(
            path.extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("py" | "sh" | "bash")
        ) {
            if fs::read_to_string(&path)
                .ok()
                .is_some_and(|v| !v.starts_with("#!"))
            {
                errors.push(format!(
                    "脚本缺少 shebang: {}",
                    path.strip_prefix(root).unwrap_or(&path).display()
                ));
            }
        }
    }
}

fn validate_dir(dir: &Path) -> SkillValidationResult {
    let mut errors = Vec::new();
    let warnings = Vec::new();
    if !dir.is_dir() {
        errors.push("Skill 目录不存在".into());
        return SkillValidationResult {
            name: None,
            ok: false,
            errors,
            warnings,
            requested_tools: Vec::new(),
        };
    }
    let file = metadata_file(dir);
    let metadata = match file.as_deref().map(parse_metadata) {
        Some(Ok(m)) => Some(m),
        Some(Err(e)) => {
            errors.push(e);
            None
        }
        None => {
            errors.push("缺少 SKILL.md、skill.json 或 README.md".into());
            None
        }
    };
    if let Some(ref m) = metadata {
        if dir.file_name().and_then(|n| n.to_str()) != Some(m.name.as_str()) {
            errors.push("目录名必须与 Skill name 一致".into());
        }
    }
    walk_validate(dir, dir, &mut errors);
    SkillValidationResult {
        name: metadata.as_ref().map(|m| m.name.clone()),
        ok: errors.is_empty(),
        errors,
        warnings,
        requested_tools: metadata.map(|m| m.allowed_tools).unwrap_or_default(),
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn discover_root(scope: SkillScope, root: &Path) -> Vec<SkillSummary> {
    let mut skills = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return skills;
    };
    for entry in entries.flatten().filter(|e| e.path().is_dir()) {
        let dir = entry.path();
        let Some(file) = metadata_file(&dir) else {
            continue;
        };
        let Ok(metadata) = parse_metadata(&file) else {
            continue;
        };
        let base_dir = dir
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let skill_file = file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let source = fs::read_to_string(dir.join(".skill-source.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        skills.push(SkillSummary {
            reference: SkillReference {
                name: metadata.name,
                scope: scope.clone(),
                base_dir,
                skill_file,
            },
            description: metadata.description,
            allowed_tools: metadata.allowed_tools,
            read_only: scope == SkillScope::Builtin,
            installed_at: modified_ms(&dir),
            available: true,
            source,
        });
    }
    skills
}

fn seed_builtins(root: &Path) -> Result<(), String> {
    for (name, content) in [
        ("docx", include_str!("../skills/docx/SKILL.md")),
        ("excel", include_str!("../skills/excel/SKILL.md")),
        (
            "agent-browser",
            include_str!("../skills/agent-browser/SKILL.md"),
        ),
    ] {
        let dir = root.join(name);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("SKILL.md");
        if !file.exists() {
            fs::write(file, content).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn skill_discover(
    app: AppHandle,
    workspace_root: Option<String>,
) -> Result<SkillDiscovery, String> {
    let all_roots = roots(&app, workspace_root.as_deref())?;
    let global_root = all_roots
        .iter()
        .find(|(s, _)| *s == SkillScope::Global)
        .unwrap()
        .1
        .to_string_lossy()
        .to_string();
    let workspace_path = all_roots
        .iter()
        .find(|(s, _)| *s == SkillScope::Workspace)
        .map(|(_, p)| p.to_string_lossy().to_string());
    let mut by_name = HashMap::new();
    for (scope, root) in all_roots {
        for skill in discover_root(scope, &root) {
            by_name.insert(skill.reference.name.clone(), skill);
        }
    }
    let mut skills: Vec<_> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.reference.name.cmp(&b.reference.name));
    Ok(SkillDiscovery {
        skills,
        global_root,
        workspace_root: workspace_path,
    })
}

fn resolve_target(
    app: &AppHandle,
    reference: &SkillReference,
    workspace_root: Option<&str>,
    relative: Option<&str>,
) -> Result<PathBuf, String> {
    let root = root_for(app, &reference.scope, workspace_root)?;
    let base = root.join(safe_name(&reference.base_dir)?);
    let mut path = base.clone();
    if let Some(relative) = relative {
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => path.push(part),
                _ => return Err("Skill 资源路径无效".into()),
            }
        }
    }
    let canonical_base = fs::canonicalize(&base).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_base) {
        return Err("Skill 资源路径越界".into());
    }
    if fs::symlink_metadata(&canonical)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("禁止读取符号链接".into());
    }
    Ok(canonical)
}

fn read_limited(path: &Path) -> Result<(String, bool), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_TEXT_BYTES as usize;
    bytes.truncate(MAX_TEXT_BYTES as usize);
    Ok((
        String::from_utf8(bytes).map_err(|_| "Skill 文件必须是 UTF-8 文本")?,
        truncated,
    ))
}

#[tauri::command]
pub fn skill_read(
    app: AppHandle,
    workspace_root: Option<String>,
    reference: SkillReference,
) -> Result<SkillReadResult, String> {
    let path = resolve_target(
        &app,
        &reference,
        workspace_root.as_deref(),
        Some(&reference.skill_file),
    )?;
    let metadata = parse_metadata(&path)?;
    let (content, truncated) = read_limited(&path)?;
    Ok(SkillReadResult {
        reference,
        metadata,
        content,
        truncated,
    })
}

#[tauri::command]
pub fn skill_read_resource(
    app: AppHandle,
    workspace_root: Option<String>,
    reference: SkillReference,
    path: String,
) -> Result<SkillReadResult, String> {
    let target = resolve_target(&app, &reference, workspace_root.as_deref(), Some(&path))?;
    if !target.is_file() {
        return Err("Skill 资源不是文件".into());
    }
    let metadata_path = resolve_target(
        &app,
        &reference,
        workspace_root.as_deref(),
        Some(&reference.skill_file),
    )?;
    let metadata = parse_metadata(&metadata_path)?;
    let (content, truncated) = read_limited(&target)?;
    Ok(SkillReadResult {
        reference,
        metadata,
        content,
        truncated,
    })
}

#[tauri::command]
pub fn skill_validate(
    app: AppHandle,
    request: SkillTargetRequest,
) -> Result<SkillValidationResult, String> {
    let root = root_for(&app, &request.scope, request.workspace_root.as_deref())?;
    Ok(validate_dir(&root.join(safe_name(&request.name)?)))
}

#[tauri::command]
pub fn skill_create(app: AppHandle, request: SkillCreateRequest) -> Result<SkillSummary, String> {
    if request.scope == SkillScope::Builtin {
        return Err("不能创建内置 Skill".into());
    }
    let name = safe_name(&request.name)?;
    let root = root_for(&app, &request.scope, request.workspace_root.as_deref())?;
    let dir = root.join(&name);
    if dir.exists() {
        return Err("同名 Skill 已存在".into());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tools = if request.allowed_tools.is_empty() {
        String::new()
    } else {
        format!("allowed-tools: [{}]\n", request.allowed_tools.join(", "))
    };
    let body = format!("---\nname: {name}\ndescription: {}\n{tools}---\n\n# {}\n\nDescribe when and how the agent should use this skill.\n", request.description.trim(), request.description.trim());
    fs::write(dir.join("SKILL.md"), body).map_err(|e| e.to_string())?;
    discover_root(request.scope, &root)
        .into_iter()
        .find(|s| s.reference.name == name)
        .ok_or("创建 Skill 后无法读取".into())
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("安装源包含符号链接".into());
        }
        if meta.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), target.join(entry.file_name())).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, target: &Path) -> Result<(), String> {
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Skill 压缩包文件数量超过限制".into());
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut item = archive.by_index(i).map_err(|e| e.to_string())?;
        total = total.saturating_add(item.size());
        if total > MAX_ARCHIVE_BYTES {
            return Err("Skill 压缩包解压后超过 100MB".into());
        }
        let enclosed = item
            .enclosed_name()
            .ok_or("压缩包包含越界路径")?
            .to_path_buf();
        let output = target.join(enclosed);
        if item.is_dir() {
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(output).map_err(|e| e.to_string())?;
            std::io::copy(&mut item, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn install_from_path(
    app: &AppHandle,
    request: &SkillInstallRequest,
    source: &Path,
) -> Result<SkillSummary, String> {
    if request.scope == SkillScope::Builtin {
        return Err("不能覆盖内置 Skill".into());
    }
    let root = root_for(app, &request.scope, request.workspace_root.as_deref())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp = root.join(format!(".install-{stamp}"));
    if source.is_dir() {
        copy_tree(source, &temp)?;
    } else {
        fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
        extract_zip(source, &temp)?;
    }
    let candidate = if metadata_file(&temp).is_some() {
        temp.clone()
    } else {
        let dirs: Vec<_> = fs::read_dir(&temp)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect();
        if dirs.len() == 1 {
            dirs[0].path()
        } else {
            temp.clone()
        }
    };
    let validation = validate_dir(&candidate);
    if !validation.ok {
        let _ = fs::remove_dir_all(&temp);
        return Err(validation.errors.join("；"));
    }
    let name = validation.name.ok_or("无法确定 Skill 名称")?;
    let target = root.join(&name);
    if target.exists() && !request.overwrite {
        let _ = fs::remove_dir_all(&temp);
        return Err("同名 Skill 已存在".into());
    }
    let backups = root.join(".backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let backup = backups.join(&name);
    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|e| e.to_string())?;
    }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&candidate, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&temp);
        return Err(error.to_string());
    }
    if temp.exists() {
        let _ = fs::remove_dir_all(&temp);
    }
    discover_root(request.scope.clone(), &root)
        .into_iter()
        .find(|s| s.reference.name == name)
        .ok_or("安装后无法读取 Skill".into())
}

#[tauri::command]
pub fn skill_install(app: AppHandle, request: SkillInstallRequest) -> Result<SkillSummary, String> {
    install_from_path(&app, &request, Path::new(&request.source))
}

#[tauri::command]
pub fn skill_delete(app: AppHandle, request: SkillTargetRequest) -> Result<(), String> {
    if request.scope == SkillScope::Builtin {
        return Err("内置 Skill 不能删除".into());
    }
    let root = root_for(&app, &request.scope, request.workspace_root.as_deref())?;
    let target = root.join(safe_name(&request.name)?);
    if target.exists() {
        fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn zip_dir(root: &Path, current: &Path, zip: &mut ZipWriter<fs::File>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            zip_dir(root, &path, zip)?;
        } else {
            let name = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(name, SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn skill_package(
    app: AppHandle,
    request: SkillTargetRequest,
    destination: String,
) -> Result<String, String> {
    let root = root_for(&app, &request.scope, request.workspace_root.as_deref())?;
    let dir = root.join(safe_name(&request.name)?);
    let validation = validate_dir(&dir);
    if !validation.ok {
        return Err(validation.errors.join("；"));
    }
    let output = PathBuf::from(destination);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = fs::File::create(&output).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    zip_dir(&dir, &dir, &mut zip)?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(output.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn skill_market_search(query: String, limit: Option<usize>) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("tech-proposal-studio")
        .build()
        .map_err(|e| e.to_string())?;
    let path = if query.trim().is_empty() {
        "/api/v1/skills"
    } else {
        "/api/v1/search"
    };
    let limit_text = limit.unwrap_or(24).clamp(1, 50).to_string();
    let request = client.get(format!("{CLAWHUB}{path}")).query(&[
        (
            if query.trim().is_empty() { "sort" } else { "q" },
            if query.trim().is_empty() {
                "downloads"
            } else {
                query.trim()
            },
        ),
        ("limit", limit_text.as_str()),
        ("nonSuspiciousOnly", "true"),
    ]);
    let response = request
        .send()
        .await
        .map_err(|e| format!("ClawHub 请求失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("ClawHub 返回 HTTP {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skill_market_detail(
    slug: String,
    owner_handle: Option<String>,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(format!("{CLAWHUB}/api/v1/skills/{}", slug));
    if let Some(owner) = owner_handle {
        request = request.query(&[("ownerHandle", owner)]);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("ClawHub 返回 HTTP {}", response.status()));
    }
    response.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn skill_update(
    app: AppHandle,
    request: SkillInstallRequest,
    slug: String,
    owner_handle: Option<String>,
    version: Option<String>,
) -> Result<SkillSummary, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut url =
        reqwest::Url::parse(&format!("{CLAWHUB}/api/v1/download")).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("slug", &slug)
            .append_pair("tag", version.as_deref().unwrap_or("latest"));
        if let Some(owner) = owner_handle.as_deref() {
            q.append_pair("ownerHandle", owner);
        }
    }
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let temp = std::env::temp_dir().join(format!(
        "tech-proposal-skill-{}.zip",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    let install_request = SkillInstallRequest {
        source: temp.to_string_lossy().to_string(),
        overwrite: true,
        scope: request.scope.clone(),
        workspace_root: request.workspace_root.clone(),
    };
    let result = install_from_path(&app, &install_request, &temp);
    let _ = fs::remove_file(temp);
    let mut installed = result?;
    let root = root_for(&app, &request.scope, request.workspace_root.as_deref())?;
    let source = serde_json::json!({"registry":"clawhub","slug":slug,"ownerHandle":owner_handle,"version":version.clone().unwrap_or_else(||"latest".into())});
    fs::write(
        root.join(&installed.reference.base_dir)
            .join(".skill-source.json"),
        serde_json::to_vec_pretty(&source).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    installed.source = Some(source);
    Ok(installed)
}

#[tauri::command]
pub async fn skill_check_updates(
    app: AppHandle,
    workspace_root: Option<String>,
) -> Result<Vec<Value>, String> {
    let discovery = skill_discover(app, workspace_root)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut updates = Vec::new();
    for skill in discovery.skills {
        let Some(source) = skill.source.as_ref() else {
            continue;
        };
        if source.get("registry").and_then(Value::as_str) != Some("clawhub") {
            continue;
        }
        let Some(slug) = source.get("slug").and_then(Value::as_str) else {
            continue;
        };
        let mut request = client.get(format!("{CLAWHUB}/api/v1/skills/{slug}"));
        if let Some(owner) = source.get("ownerHandle").and_then(Value::as_str) {
            request = request.query(&[("ownerHandle", owner)]);
        }
        let json: Value = request
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let latest = json
            .get("latestVersion")
            .and_then(|v| v.get("version"))
            .and_then(Value::as_str)
            .or_else(|| json.get("version").and_then(Value::as_str));
        let installed = source
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("latest");
        updates.push(serde_json::json!({"name":skill.reference.name,"slug":slug,"installedVersion":installed,"latestVersion":latest,"updateAvailable":latest.is_some_and(|v|v!=installed&&installed!="latest")}));
    }
    Ok(updates)
}

fn program_suffixes() -> [&'static str; 4] {
    if cfg!(windows) {
        [".exe", ".cmd", ".bat", ""]
    } else {
        ["", ".exe", ".cmd", ".bat"]
    }
}

fn find_program(name: &str) -> Option<String> {
    let path = child_path_env()?;
    for dir in std::env::split_paths(&path) {
        // npm installs both a Unix shell shim without an extension and a Windows
        // .cmd shim. CreateProcess cannot launch the extensionless shell script.
        for suffix in program_suffixes() {
            let candidate = dir.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn is_windows_command_script(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

fn configure_skill_command(executable: &Path, args: &[String]) -> Command {
    if cfg!(windows) && is_windows_command_script(executable) {
        let mut command = Command::new("cmd.exe");
        command.arg("/D").arg("/S").arg("/C");
        let mut line = crate::process::quote_cmd_arg(&executable.to_string_lossy());
        for arg in args {
            line.push(' ');
            line.push_str(&crate::process::quote_cmd_arg(arg));
        }
        command.arg(line);
        command
    } else {
        let mut command = Command::new(executable);
        command.args(args);
        command
    }
}

#[tauri::command]
pub fn skill_runtime_status() -> Vec<SkillRuntimeItem> {
    [
        ("python", "安装 Python 3，并确保 python 或 py 位于 PATH"),
        ("node", "安装 Node.js LTS"),
        ("npm", "随 Node.js 安装 npm"),
        ("agent-browser", "运行 npm install -g agent-browser"),
    ]
    .into_iter()
    .map(|(name, hint)| {
        let path = find_program(name);
        SkillRuntimeItem {
            name: name.into(),
            available: path.is_some(),
            path,
            install_hint: hint.into(),
        }
    })
    .collect()
}

#[tauri::command]
pub async fn skill_run_command(request: SkillCommandRequest) -> Result<SkillCommandResult, String> {
    let allowed: HashSet<&str> = [
        "python",
        "python3",
        "py",
        "node",
        "npm",
        "npx",
        "agent-browser",
    ]
    .into_iter()
    .collect();
    let program_name = Path::new(&request.program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let program_name = program_name
        .strip_suffix(".exe")
        .or_else(|| program_name.strip_suffix(".cmd"))
        .or_else(|| program_name.strip_suffix(".bat"))
        .unwrap_or(&program_name);
    if !allowed.contains(program_name) {
        return Err("Skill 命令不在允许列表中".into());
    }
    let workspace = fs::canonicalize(&request.workspace_root).map_err(|e| e.to_string())?;
    let cwd = resolve_workdir(request.cwd.as_deref().unwrap_or(&request.workspace_root))?;
    let canonical_cwd = fs::canonicalize(&cwd).map_err(|e| e.to_string())?;
    if !canonical_cwd.starts_with(&workspace) {
        return Err("Skill 命令工作目录必须位于当前工作区".into());
    }
    let executable = PathBuf::from(find_program(&request.program).unwrap_or(request.program.clone()));
    let started = std::time::Instant::now();
    let mut command = configure_skill_command(&executable, &request.args);
    command
        .current_dir(canonical_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    if let Some(path) = child_path_env() {
        command.env("PATH", path);
    }
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"] {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Skill 命令失败: {e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法读取 stderr")?;
    let out_task = tokio::spawn(async move {
        let mut v = Vec::new();
        stdout
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut v)
            .await
            .map(|_| v)
    });
    let err_task = tokio::spawn(async move {
        let mut v = Vec::new();
        stderr
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut v)
            .await
            .map(|_| v)
    });
    let status = match timeout(
        Duration::from_millis(request.timeout_ms.clamp(1000, 600_000)),
        child.wait(),
    )
    .await
    {
        Ok(value) => value.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = child.kill().await;
            return Err("Skill 命令执行超时".into());
        }
    };
    let mut out = out_task
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let mut err = err_task
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let truncated = out.len() > MAX_OUTPUT_BYTES || err.len() > MAX_OUTPUT_BYTES;
    out.truncate(MAX_OUTPUT_BYTES);
    err.truncate(MAX_OUTPUT_BYTES);
    Ok(SkillCommandResult {
        exit_code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out).into(),
        stderr: String::from_utf8_lossy(&err).into(),
        truncated,
        duration_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_and_validation() {
        let root = std::env::temp_dir().join(format!(
            "skill-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.join("demo");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"),"---\nname: demo\ndescription: Demo skill\nallowed-tools: [read_file, web_search]\n---\nBody").unwrap();
        let result = validate_dir(&dir);
        assert!(result.ok, "{:?}", result.errors);
        assert_eq!(result.requested_tools.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_parent_path() {
        assert!(safe_name("../bad").is_err());
    }

    #[test]
    fn identifies_windows_command_shims() {
        assert!(is_windows_command_script(Path::new("agent-browser.cmd")));
        assert!(is_windows_command_script(Path::new("npm.BAT")));
        assert!(!is_windows_command_script(Path::new("agent-browser.exe")));
    }

    #[test]
    fn quotes_command_arguments_with_url_operators() {
        assert_eq!(
            crate::process::quote_cmd_arg("https://example.com/search?q=a&lang=zh"),
            "\"https://example.com/search?q=a&lang=zh\""
        );
        assert_eq!(crate::process::quote_cmd_arg("two words"), "\"two words\"");
    }

    #[cfg(windows)]
    #[test]
    fn program_discovery_prefers_windows_npm_shim() {
        assert_eq!(program_suffixes(), [".exe", ".cmd", ".bat", ""]);
    }
}
