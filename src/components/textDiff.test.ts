import { describe, expect, it } from "vitest";
import { buildTextDiff } from "./textDiff";

describe("buildTextDiff", () => {
  it("aligns added and deleted lines and highlights an inline Chinese edit", () => {
    const result = buildTextDiff("# 标题\n旧的技术方案。\n保留", "# 标题\n新的技术方案！\n保留\n补充");
    expect(result).toMatchObject({ addedLines: 2, deletedLines: 1, unchanged: false });
    const changed = result.rows.find(row => row.original.kind === "delete");
    expect(changed?.original.segments.filter(item => item.changed).map(item => item.text).join("")).toBe("旧。");
    expect(changed?.revised.segments.filter(item => item.changed).map(item => item.text).join("")).toBe("新！");
    expect(result.rows.at(-1)?.original.kind).toBe("placeholder");
    expect(result.rows.at(-1)?.revised.kind).toBe("add");
  });

  it("preserves consecutive blank lines", () => {
    const result = buildTextDiff("甲\n\n\n乙", "甲\n\n新增\n乙");
    expect(result.rows.some(row => row.revised.kind === "add" && row.revised.segments[0]?.text === "新增")).toBe(true);
    expect(result.rows.filter(row => row.original.lineNumber !== null)).toHaveLength(4);
    expect(result.rows.filter(row => row.revised.lineNumber !== null)).toHaveLength(4);
  });

  it("reports equal content without changes", () => {
    const result = buildTextDiff("正文\n", "正文\n");
    expect(result).toMatchObject({ addedLines: 0, deletedLines: 0, unchanged: true });
    expect(result.rows.every(row => row.original.kind === "context" && row.revised.kind === "context")).toBe(true);
  });

  it("detects a missing final newline", () => {
    expect(buildTextDiff("正文\n", "正文").unchanged).toBe(false);
  });

  it("marks complete insertion and deletion", () => {
    expect(buildTextDiff("", "新增\n两行")).toMatchObject({ addedLines: 2, deletedLines: 0 });
    expect(buildTextDiff("删除\n两行", "")).toMatchObject({ addedLines: 0, deletedLines: 2 });
  });
});
