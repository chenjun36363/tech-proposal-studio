# Agent Skill 格式

## 目录

```text
skill-name/
├── SKILL.md
├── references/
└── assets/
```

仅 `SKILL.md` 必需。`references/` 放按需读取的长说明，`assets/` 放模板、图标或其他输出资源。`action=create` 的 `files` 只接收 UTF-8 文本；包含二进制资源的 Skill 应从本地目录或 ZIP 安装。

## Frontmatter

```markdown
---
name: my-skill
description: 执行某个明确工作流。用户要求对应任务时使用。
allowed-tools: [skills_manager]
---
```

- `name`：只使用小写字母、数字和短横线，目录名与它一致。
- `description`：同时包含能力和触发条件；普通 Skill 的正文只有命中后才读取。
- `allowed-tools`：可选兼容字段。只有确实需要执行受控命令时才加入 `skill_run_command`。

## 运行规则

- 构案从内置、全局 app-data 和工作区 `.gouan/skills/` 三层发现 Skills；普通 Skill 同名时工作区优先，`skills-creator` 与 `skills-installer` 为受保护的内置名称。
- Markdown 入口优先使用 `SKILL.md`；扫描器也兼容 `skill.md`、`skill.json` 和回退 `README.md`。
- 引用文件路径必须相对 Skill 根目录，且不能包含 `..`、绝对路径或符号链接。
- Skill 只提供操作说明，不会授予额外权限；实际动作仍受 Agent 工具、会话开关和审批规则约束。

## 渐进披露

入口只保留决策流程和引用导航。长规范、提供商差异、检查清单和示例移入 `references/`，并在 `SKILL.md` 中明确何时读取。
