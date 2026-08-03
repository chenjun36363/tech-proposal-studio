import { describe, it, expect } from "vitest";
import { applyInlineFormat } from "./inlineFormat";

describe("applyInlineFormat", () => {
  it("加粗：有选区时包裹 **", () => {
    const r = applyInlineFormat("hello world", 6, 11, "**", "**");
    expect(r.text).toBe("hello **world**");
    expect(r.selectionStart).toBe(8);
    expect(r.selectionEnd).toBe(13);
  });

  it("加粗：再点一次取消 **（toggle off）", () => {
    const r = applyInlineFormat("hello **world**", 6, 15, "**", "**");
    expect(r.text).toBe("hello world");
    expect(r.selectionStart).toBe(6);
    expect(r.selectionEnd).toBe(11);
  });

  it("加粗与斜体不互相误判（**x** 不被当成斜体剥离）", () => {
    const r = applyInlineFormat("**x**", 0, 5, "*", "*");
    expect(r.text).toBe("***x***");
    expect(r.selectionStart).toBe(1);
    expect(r.selectionEnd).toBe(6);
  });

  it("斜体：再点一次取消 *", () => {
    const r = applyInlineFormat("*x*", 0, 3, "*", "*");
    expect(r.text).toBe("x");
  });

  it("无选区：插入占位符并选中占位符", () => {
    const r = applyInlineFormat("ab", 1, 1, "**", "**", "粗体");
    expect(r.text).toBe("a**粗体**b");
    expect(r.selectionStart).toBe(3);
    expect(r.selectionEnd).toBe(5);
  });

  it("行内代码：包裹 `", () => {
    const r = applyInlineFormat("use x", 4, 5, "`", "`");
    expect(r.text).toBe("use `x`");
  });

  it("删除线：包裹 ~~", () => {
    const r = applyInlineFormat("text", 0, 4, "~~", "~~");
    expect(r.text).toBe("~~text~~");
  });
});
