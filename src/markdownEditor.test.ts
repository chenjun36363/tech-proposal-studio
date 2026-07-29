import { describe, expect, it } from "vitest";
import { decodeLocalImagePath } from "./markdownEditor";

describe("local Markdown image paths", () => {
  it("decodes paths encoded by marked before filesystem resolution", () => {
    expect(decodeLocalImagePath("assets/import-%E5%B8%B8%E5%B7%9E/image%201.png"))
      .toBe("assets/import-常州/image 1.png");
  });

  it("preserves decoded and malformed paths", () => {
    expect(decodeLocalImagePath("assets/import-demo/image.png")).toBe("assets/import-demo/image.png");
    expect(decodeLocalImagePath("assets/import-%E5/image.png")).toBe("assets/import-%E5/image.png");
  });
});
