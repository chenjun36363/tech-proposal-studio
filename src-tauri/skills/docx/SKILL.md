---
name: docx
description: Create, inspect, and edit Microsoft Word DOCX files with python-docx while preserving document structure.
allowed-tools: [skills_manager, skill_run_command]
---

# DOCX documents

Use this skill when the user needs to create, inspect, or modify a `.docx` file beyond the application's native Markdown export.

1. Call `skills_manager` with `action=runtime_status` and verify Python is available.
2. Keep all input and output paths inside the current workspace. Never overwrite an existing document unless the user explicitly approves it.
3. Use `python -c` only for short diagnostics. For document work, create a readable script under the workspace and run it with `skill_run_command`.
4. Import `docx` from `python-docx`. If unavailable, report `python -m pip install python-docx`; do not install it automatically.
5. After writing, reopen the generated file with `python-docx` and verify paragraphs, tables, relationships, and expected output path.
6. Report the artifact path and any formatting limitations. Do not claim Microsoft Word rendering was verified unless it was opened in Word.

