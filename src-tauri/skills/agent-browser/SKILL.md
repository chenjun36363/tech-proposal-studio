---
name: agent-browser
description: Automate browser navigation, snapshots, clicks, text input, screenshots, and session cleanup through the agent-browser CLI.
allowed-tools: [skills_manager, skill_run_command]
---

# Agent Browser

Use this skill when a task requires interactive browser automation rather than search-result text retrieval.

1. Check `agent-browser` availability through `skills_manager` with `action=runtime_status`. If missing, report `npm install -g agent-browser` followed by `agent-browser install`; do not install either automatically.
2. Create a short stable session name and pass `--session <name>` before every command. Never invent command aliases or flags: navigation is `agent-browser --session <name> open <url>`, not `nav`, `navigate`, or `open --url`.
3. After opening a page, run `agent-browser --session <name> wait --load domcontentloaded`, then `agent-browser --session <name> snapshot -i --json`. If the load wait times out but navigation succeeded, still try the snapshot because long-lived network requests can prevent an idle state.
4. Base selectors and `@ref` values only on the latest snapshot. Re-run the snapshot after navigation, form changes, dialogs, or any failed element lookup. Prefer semantic `find role`, `find text`, or `find label` commands when a ref is unstable.
5. Use `agent-browser --session <name> get url --json`, `get title --json`, `errors --json`, and `console --json` to diagnose an unexpected page before retrying. Retry a failed read operation at most once with a fresh snapshot; then report the concrete CLI error.
6. Reuse the named session for the whole task and always close it with `agent-browser --session <name> close` when finished or after an unrecoverable failure.
7. Execute requested browser steps directly without an additional Skill confirmation. Do not infer destructive or transactional actions that the user did not request.
8. Write screenshots and downloads under the workspace and report their paths. Use an absolute output path inside the workspace for screenshots.
9. Never place credentials, tokens, or cookies in command arguments or transcript output.

## Exact command sequence

```text
agent-browser --session <name> open <url>
agent-browser --session <name> wait --load domcontentloaded
agent-browser --session <name> snapshot -i --json
agent-browser --session <name> click @e1
agent-browser --session <name> snapshot -i --json
agent-browser --session <name> screenshot <workspace-path>
agent-browser --session <name> close
```
