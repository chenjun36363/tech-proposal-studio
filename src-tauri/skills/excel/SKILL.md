---
name: excel
description: Create, inspect, and edit Excel XLSX workbooks with openpyxl, including formulas, styles, sheets, and charts.
allowed-tools: [skills_manager, skill_run_command]
---

# Excel workbooks

Use this skill for `.xlsx` workbook creation, inspection, or modification.

1. Verify Python with `skills_manager` using `action=runtime_status`.
2. Keep files and scripts inside the workspace; use a new output name unless overwrite was explicitly approved.
3. Use `openpyxl`. If unavailable, report `python -m pip install openpyxl`; never install dependencies automatically.
4. Preserve formulas as formulas. Do not invent cached calculation results because openpyxl does not calculate formulas.
5. Apply number formats, column widths, frozen panes, and header styles when they materially improve usability.
6. Reopen the saved workbook with `openpyxl.load_workbook` and verify expected sheets, dimensions, formulas, and charts before reporting success.

