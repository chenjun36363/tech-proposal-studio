# Authoring Patterns

## 顺序工作流

适合步骤固定的任务：

```markdown
## 工作流
1. 检查输入。
2. 读取需要的引用。
3. 执行受控工具动作。
4. 校验输出。
5. 报告结果和变更文件。
```

## 分支工作流

当处理方式取决于来源、文件类型或项目状态时，先明确判定条件，再分别给出流程，避免把所有分支混在同一组步骤中。

## 管理型 Skill

构案 Skills 的创建、安装、校验和打包统一使用 `skills_manager`：

- `action=create`：创建或明确覆盖 Skill。
- `action=install`：安装本地目录或 ZIP 包。
- `action=market_search` / `market_install`：搜索和安装 ClawHub Skill。
- `action=list`：查看当前会话可用的 Skills。
- `action=validate`：校验元数据和目录。
- `action=package`：校验通过后打包。

## 引用型 Skill

- 每个引用文件都从 `SKILL.md` 直接链接，不要形成多层引用链。
- 长文件写清章节标题和检索提示。
- 不在入口与引用文件中重复同一段说明。
- 仅在任务确实需要时读取引用，减少上下文占用。
