import { describe, expect, it } from "vitest";
import { getLongWritingAvailability } from "./availability";

describe("getLongWritingAvailability", () => {
  it("distinguishes browser mode from missing workspace metadata", () => {
    expect(getLongWritingAvailability(false, {})).toMatchObject({
      issue: "browser",
      title: "当前为浏览器运行模式",
    });
  });

  it("reports a missing workspace before checking the open document", () => {
    expect(getLongWritingAvailability(true, { filePath: "D:\\workspace\\proposal.md" })).toMatchObject({
      issue: "workspace",
      title: "尚未配置桌面工作区",
    });
  });

  it("reports an unsaved or unopened workspace document", () => {
    expect(getLongWritingAvailability(true, {
      workspace: { root: "D:\\workspace", historyDir: "D:\\workspace\\knowledge" },
    })).toMatchObject({
      issue: "document",
      title: "尚未打开已保存的 Markdown",
    });
  });

  it("allows a desktop workspace Markdown document", () => {
    expect(getLongWritingAvailability(true, {
      workspace: { root: "D:\\workspace", historyDir: "D:\\workspace\\knowledge" },
      filePath: "D:\\workspace\\proposal.md",
    })).toBeNull();
  });
});
