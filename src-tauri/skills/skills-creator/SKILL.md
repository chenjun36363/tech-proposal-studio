---
name: skills-creator
description: 创建、更新、校验和打包构案 Agent Skills。用户要求把工作流沉淀为 Skill、完善 SKILL.md 或生成带 references/assets 的技能包时使用。
allowed-tools: [skills_manager]
---

# Skills Creator

为 TechProposal Studio（构案）创建可渐进披露的 Agent Skill。保持入口简洁，把长说明放入 `references/`，仅在确有需要时加入辅助文件。

## 工作流

1. 确认 Skill 名称、触发描述、安装作用域（`global` 或 `workspace`）及需要的引用/资源文件。
2. 在设计格式前读取：
   - `skills_manager(action=read_resource, name=skills-creator, path=references/agent-skill-format.md)`
   - `skills_manager(action=read_resource, name=skills-creator, path=references/authoring-patterns.md)`
3. 编写完整 `SKILL.md`。名称使用小写字母、数字和短横线；描述同时说明“做什么”和“何时使用”。
4. 调用 `skills_manager(action=create, ...)`，通过 `content` 提交完整 `SKILL.md`，通过 `files` 提交可选的 UTF-8 文本引用或资源文件。
5. 调用 `skills_manager(action=validate, name=..., scope=...)`；修复所有错误后才算完成。
6. 用户需要分发包时，调用 `skills_manager(action=package, name=..., scope=..., destination=...)`。

## 示例

```text
skills_manager(
  action=create,
  scope=workspace,
  name=my-skill,
  description="处理指定工作流。用户要求……时使用。",
  content="---\nname: my-skill\ndescription: ...\n---\n\n# My Skill\n...",
  files={"references/checklist.md":"# Checklist\n..."}
)
skills_manager(action=validate, scope=workspace, name=my-skill)
skills_manager(action=package, scope=workspace, name=my-skill, destination="D:\\exports\\my-skill.zip")
```

## 规则

- 创建、覆盖或打包属于文件写入，只有会话开启“完全访问”后才能执行。
- 默认 `overwrite=false`。仅在用户明确要求替换同名 Skill 时设为 `true`；覆盖前构案会保留备份。
- `workspace` 作用域写入当前工作区 `.gouan/skills/`；`global` 写入构案 app-data Skills 目录。
- 只创建任务所需文件；引用文件优先放 `references/`，文本输出模板可放 `assets/`。`files` 不用于提交图片等二进制资源。
- 不创建 README、CHANGELOG、安装说明等与运行无关的附加文档。
- `skills-creator` 与 `skills-installer` 是受保护的内置名称；为自定义 Skill 使用其他名称。
- 不使用 `skill_run_command` 绕过 `skills_manager` 管理 Skill 文件。
