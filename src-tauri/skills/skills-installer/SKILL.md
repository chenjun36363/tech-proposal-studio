---
name: skills-installer
description: 安装、搜索、更新、校验或打包构案 Agent Skills。用户要求从本地目录、ZIP 包或 ClawHub 获取 Skill，或处理同名冲突和升级时使用。
allowed-tools: [skills_manager]
---

# Skills Installer

把 Agent Skills 安装到构案的全局或当前工作区作用域，并避免静默覆盖用户数据。

## 工作流

1. 判断来源：本地 Skill 目录、`.zip` 包，或 ClawHub 搜索结果。
2. 判断作用域：`workspace` 写入当前工作区 `.gouan/skills/`；`global` 写入构案 app-data Skills 目录。
3. 安装前读取：
   - `skills_manager(action=read_resource, name=skills-installer, path=references/install-sources.md)`
   - `skills_manager(action=read_resource, name=skills-installer, path=references/safety-and-conflicts.md)`
4. 必要时先用 `skills_manager(action=list)` 查看当前会话可用的 Skills。
5. 本地来源使用 `action=install`；相对路径按当前工作区解析。
6. ClawHub 使用 `action=market_search` 搜索，再用 `action=market_install` 安装返回的 `slug`。
7. 安装后调用 `action=validate`。升级前可调用 `action=check_updates`，确认后再调用 `action=update`。

## 示例

```text
skills_manager(action=install, scope=workspace, source="./skills/my-skill")
skills_manager(action=install, scope=global, source="D:\\packages\\my-skill.zip")
skills_manager(action=market_search, query="proposal", limit=10)
skills_manager(action=market_install, scope=workspace, slug="example-skill", ownerHandle="owner")
skills_manager(action=validate, scope=workspace, name=my-skill)
skills_manager(action=check_updates)
skills_manager(action=update, scope=workspace, slug="example-skill")
```

## 规则

- 安装、更新和覆盖属于文件写入，只有会话开启“完全访问”后才能执行。
- ClawHub 搜索、安装与更新还要求当前会话已开启联网搜索。
- 默认 `overwrite=false`；只有用户明确接受替换时才启用覆盖。覆盖时构案会将旧目录移入 `.backups/`。
- 不自动删除备份。
- 本地安装源必须是包含有效 Skill 入口的目录或 ZIP 包；不把普通网页 URL 当作安装源。
- 不覆盖或删除 `builtin` 作用域。
- 安装完成后如需在当前会话立即使用，提示用户在技能设置中确认启用状态；两个管理 Skill 本身始终启用。
