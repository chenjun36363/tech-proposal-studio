import { describe, expect, it } from "vitest";
import { longWritingErrorMessage } from "./errors";

describe("longWritingErrorMessage", () => {
  it("keeps Error messages", () => {
    expect(longWritingErrorMessage(new Error("模型超时"), "规划失败")).toBe("模型超时");
  });

  it("keeps string rejections from Tauri invoke", () => {
    expect(longWritingErrorMessage("request timed out", "规划失败")).toBe("request timed out");
  });

  it("reads message-like rejection objects", () => {
    expect(longWritingErrorMessage({ message: "连接被拒绝" }, "规划失败")).toBe("连接被拒绝");
  });

  it("uses a fallback for empty or unknown values", () => {
    expect(longWritingErrorMessage(null, "生成目录规划失败")).toBe("生成目录规划失败");
  });
});
