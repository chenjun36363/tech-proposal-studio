import { describe, expect, it } from "vitest";
import { Packer } from "docx";
import { createProject } from "./data";
import { buildDocx } from "./docxExport";

describe("Word export", () => {
  it("creates a valid DOCX package", async () => {
    const project = createProject(); project.name = "架构方案"; project.sections[0].blocks[0].content = "目标正文";
    const bytes = await Packer.toBuffer(buildDocx(project));
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
  });
});
