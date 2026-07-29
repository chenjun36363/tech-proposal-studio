use serde::Serialize;
use std::{
    fs,
    path::{Component, Path},
    process::Command,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileStatus {
    path: String,
    index_status: String,
    worktree_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRepositoryStatus {
    is_repository: bool,
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    remote_url: Option<String>,
    files: Vec<GitFileStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitDiffResult {
    path: String,
    staged: bool,
    patch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitSummary {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    authored_at: String,
    refs: Vec<String>,
}

fn checked_root(root: &str) -> Result<&Path, String> {
    let path = Path::new(root);
    if root.trim().is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err("Git 工作区必须是已存在的绝对目录".into());
    }
    Ok(path)
}

fn checked_relative_path(path: &str) -> Result<&str, String> {
    let candidate = Path::new(path);
    if path.trim().is_empty()
        || candidate.is_absolute()
        || candidate.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Git 文件路径必须位于工作区内".into());
    }
    Ok(path)
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let root = checked_root(root)?;
    let output = Command::new("git")
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| format!("无法启动 Git：{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            "Git 命令执行失败".into()
        } else {
            error
        })
    }
}

#[tauri::command]
pub(crate) async fn git_status(root: String) -> Result<GitRepositoryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        checked_root(&root)?;
        if run_git(&root, &["rev-parse", "--is-inside-work-tree"]).is_err() {
            return Ok(GitRepositoryStatus {
                is_repository: false,
                branch: String::new(),
                upstream: None,
                ahead: 0,
                behind: 0,
                remote_url: None,
                files: vec![],
            });
        }
        let output = run_git(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
        )?;
        let mut branch = String::new();
        let mut upstream = None;
        let (mut ahead, mut behind) = (0, 0);
        let mut files = Vec::new();
        let remote_url = run_git(&root, &["remote", "get-url", "origin"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let records: Vec<&str> = output.split('\0').filter(|line| !line.is_empty()).collect();
        let mut index = 0;
        while index < records.len() {
            let line = records[index];
            if let Some(value) = line.strip_prefix("# branch.head ") {
                branch = value.to_string();
            } else if let Some(value) = line.strip_prefix("# branch.upstream ") {
                upstream = Some(value.to_string());
            } else if let Some(value) = line.strip_prefix("# branch.ab ") {
                for part in value.split_whitespace() {
                    if let Some(value) = part.strip_prefix('+') {
                        ahead = value.parse().unwrap_or(0);
                    }
                    if let Some(value) = part.strip_prefix('-') {
                        behind = value.parse().unwrap_or(0);
                    }
                }
            } else if line.starts_with("1 ") || line.starts_with("2 ") {
                let parts: Vec<&str> = line
                    .splitn(if line.starts_with("2 ") { 10 } else { 9 }, ' ')
                    .collect();
                let xy = parts.get(1).copied().unwrap_or("..");
                let path = parts.last().copied().unwrap_or("").to_string();
                files.push(GitFileStatus {
                    path,
                    index_status: xy.chars().next().unwrap_or('.').to_string(),
                    worktree_status: xy.chars().nth(1).unwrap_or('.').to_string(),
                });
                if line.starts_with("2 ") {
                    index += 1;
                }
            } else if let Some(path) = line.strip_prefix("? ") {
                files.push(GitFileStatus {
                    path: path.to_string(),
                    index_status: "?".into(),
                    worktree_status: "?".into(),
                });
            }
            index += 1;
        }
        Ok(GitRepositoryStatus {
            is_repository: true,
            branch,
            upstream,
            ahead,
            behind,
            remote_url,
            files,
        })
    })
    .await
    .map_err(|error| format!("读取 Git 状态失败：{error}"))?
}

fn validate_remote_url(remote_url: &str) -> Result<&str, String> {
    let value = remote_url.trim();
    if value.is_empty()
        || value.len() > 2048
        || value.contains(['\r', '\n', '\0'])
        || value.starts_with('-')
    {
        return Err("请输入有效的 Git 远程仓库地址".into());
    }
    if value.contains("::") {
        return Err("不支持 Git remote helper 地址".into());
    }
    Ok(value)
}

#[tauri::command]
pub(crate) async fn git_set_remote(root: String, remote_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let remote_url = validate_remote_url(&remote_url)?;
        if run_git(&root, &["remote", "get-url", "origin"]).is_ok() {
            run_git(&root, &["remote", "set-url", "origin", remote_url])?;
        } else {
            run_git(&root, &["remote", "add", "origin", remote_url])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_pull(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_git(&root, &["remote", "get-url", "origin"])
            .map_err(|_| "请先配置 origin 远程仓库".to_string())?;
        run_git(&root, &["pull", "--ff-only"]).map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_push(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_git(&root, &["remote", "get-url", "origin"])
            .map_err(|_| "请先配置 origin 远程仓库".to_string())?;
        let has_upstream = run_git(
            &root,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )
        .is_ok();
        if has_upstream {
            run_git(&root, &["push"])?;
        } else {
            let branch = run_git(&root, &["branch", "--show-current"])?;
            let branch = branch.trim();
            if branch.is_empty() {
                return Err("当前处于 detached HEAD，无法自动建立远程跟踪".into());
            }
            run_git(&root, &["push", "--set-upstream", "origin", branch])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_fetch(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_git(&root, &["remote", "get-url", "origin"])
            .map_err(|_| "请先配置 origin 远程仓库".to_string())?;
        run_git(&root, &["fetch", "--prune"]).map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_log(
    root: String,
    limit: Option<u32>,
) -> Result<Vec<GitCommitSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let count = limit.unwrap_or(50).clamp(1, 200).to_string();
        let output = run_git(
            &root,
            &[
                "log",
                "--date=iso-strict",
                "--decorate=short",
                "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e",
                "-n",
                &count,
            ],
        )?;
        Ok(output
            .split('\x1e')
            .filter_map(|record| {
                let fields: Vec<&str> = record.trim().split('\x1f').collect();
                if fields.len() < 6 {
                    return None;
                }
                Some(GitCommitSummary {
                    hash: fields[0].to_string(),
                    short_hash: fields[1].to_string(),
                    subject: fields[2].to_string(),
                    author: fields[3].to_string(),
                    authored_at: fields[4].to_string(),
                    refs: fields[5]
                        .split(',')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                        .collect(),
                })
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_commit_diff(root: String, commit: String) -> Result<GitDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let commit = commit.trim();
        if commit.is_empty() || !commit.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err("提交标识无效".into());
        }
        run_git(&root, &["cat-file", "-e", &format!("{commit}^{{commit}}")])?;
        let patch = run_git(
            &root,
            &[
                "show",
                "--format=fuller",
                "--no-ext-diff",
                "--stat",
                "--patch",
                commit,
            ],
        )?;
        Ok(GitDiffResult {
            path: commit.to_string(),
            staged: false,
            patch,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_staged_summary(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stat = run_git(&root, &["diff", "--cached", "--stat"])?;
        let patch = run_git(&root, &["diff", "--cached", "--no-ext-diff", "--unified=2"])?;
        if patch.trim().is_empty() {
            return Err("暂存区没有可用于生成提交说明的更改".into());
        }
        let truncated: String = patch.chars().take(16_000).collect();
        Ok(format!("变更统计：\n{stat}\n\n暂存区差异：\n{truncated}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_init(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_git(&root, &["init"]).map(|_| ()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_stage(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_relative_path(&path)?;
        run_git(&root, &["add", "--", path]).map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_stage_all(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_git(&root, &["add", "--all"]).map(|_| ()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_unstage(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_relative_path(&path)?;
        if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
            run_git(&root, &["restore", "--staged", "--", path])?;
        } else {
            run_git(&root, &["rm", "--cached", "--ignore-unmatch", "--", path])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_unstage_all(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if run_git(&root, &["rev-parse", "--verify", "HEAD"]).is_ok() {
            run_git(&root, &["restore", "--staged", ":/"])?;
        } else {
            run_git(&root, &["rm", "--cached", "-r", "--ignore-unmatch", "."])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_discard(root: String, path: String, untracked: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_relative_path(&path)?;
        if untracked {
            let root_path = checked_root(&root)?
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let file_path = root_path
                .join(path)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !file_path.starts_with(&root_path) || !file_path.is_file() {
                return Err("只能删除工作区内的未跟踪文件".into());
            }
            fs::remove_file(file_path).map_err(|error| format!("删除未跟踪文件失败：{error}"))?;
        } else {
            run_git(&root, &["restore", "--worktree", "--", path])?;
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_commit(root: String, message: String) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("请输入提交说明".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_git(&root, &["commit", "-m", &message]).map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn git_diff(
    root: String,
    path: String,
    staged: bool,
) -> Result<GitDiffResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = checked_relative_path(&path)?;
        let patch = if staged {
            run_git(&root, &["diff", "--cached", "--no-ext-diff", "--", path])?
        } else if run_git(&root, &["ls-files", "--error-unmatch", "--", path]).is_err() {
            let root_path = checked_root(&root)?.canonicalize().map_err(|error| error.to_string())?;
            let file_path = root_path.join(path).canonicalize().map_err(|error| format!("读取未跟踪文件失败：{error}"))?;
            if !file_path.starts_with(&root_path) { return Err("Git 文件路径必须位于工作区内".into()); }
            let bytes = fs::read(&file_path).map_err(|error| format!("读取未跟踪文件失败：{error}"))?;
            if bytes.len() > 1024 * 1024 { return Err("未跟踪文件超过 1 MB，暂不生成 diff".into()); }
            let content = String::from_utf8(bytes).map_err(|_| "未跟踪文件不是 UTF-8 文本，无法显示 diff".to_string())?;
            let line_count = content.lines().count();
            let additions = content.lines().map(|line| format!("+{line}")).collect::<Vec<_>>().join("\n");
            format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{line_count} @@\n{additions}\n")
        } else {
            run_git(&root, &["diff", "--no-ext-diff", "--", path])?
        };
        Ok(GitDiffResult { path: path.to_string(), staged, patch })
    }).await.map_err(|error| error.to_string())?
}
