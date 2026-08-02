# 安装来源

## 本地目录

`source` 可以是绝对目录，也可以是相对当前工作区的目录。目录中必须存在 `SKILL.md`、`skill.md`、`skill.json` 或兼容的 `README.md`。

```text
skills_manager(action=install, scope=workspace, source="./skills/my-skill")
```

## ZIP 包

支持本地 `.zip` 包。压缩包可以直接包含 Skill 文件，也可以只有一个顶层 Skill 目录。安装器限制文件数量、解压总大小并拒绝越界路径和符号链接。

```text
skills_manager(action=install, scope=global, source="D:\\packages\\my-skill.zip")
```

## ClawHub

先搜索并记录返回的 `slug`、`ownerHandle` 和版本，再安装：

```text
skills_manager(action=market_search, query="document", limit=10)
skills_manager(action=market_install, scope=workspace, slug="example-skill", ownerHandle="owner", version="1.2.0")
```

ClawHub 操作需要当前会话开启联网搜索。

## 不支持的直接来源

当前 `action=install` 不直接下载普通 HTTP(S) URL，也不解析 GitHub tree URL。此类来源应先由用户下载为本地目录或 ZIP，再按本地来源安装。
