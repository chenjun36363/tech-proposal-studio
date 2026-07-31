// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { acceptsUploadPath, fileExtension } from "./FileUploadPanel";

describe("FileUploadPanel path validation", () => {
  it("extracts a case-insensitive extension from Windows and POSIX paths", () => {
    expect(fileExtension("D:\\docs\\proposal.DOCX")).toBe(".docx");
    expect(fileExtension("/tmp/reference.markdown")).toBe(".markdown");
  });

  it("accepts only configured upload types", () => {
    expect(acceptsUploadPath("D:\\docs\\proposal.md", [".md", ".markdown"])).toBe(true);
    expect(acceptsUploadPath("D:\\docs\\proposal.PDF", ["pdf", "docx"])).toBe(true);
    expect(acceptsUploadPath("D:\\docs\\proposal.exe", ["pdf", "docx"])).toBe(false);
    expect(acceptsUploadPath("", ["md"])).toBe(false);
  });
});
