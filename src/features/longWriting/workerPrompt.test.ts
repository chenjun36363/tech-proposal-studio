import { describe, expect, it } from "vitest";
import { buildLongWritingWorkerPrompt } from "./workerPrompt";

describe("buildLongWritingWorkerPrompt", () => {
  it("只保留正式文件、目标范围和用户要求", () => {
    const prompt = buildLongWritingWorkerPrompt({
      filePath: "D:\\workspace\\proposal.md",
      targetTitlePath: ["总体设计", "技术路线"],
      targetLevel: 3,
      userInstruction: "重点补充离线部署、安全边界和验收指标。",
      referenceContext: "### 架构资料\n参考内容",
    });

    expect(prompt).toContain("## 正式文件\nD:\\workspace\\proposal.md");
    expect(prompt).toContain("## 修改范围\n总体设计 / 技术路线（H3）");
    expect(prompt).toContain("## 用户要求\n重点补充离线部署、安全边界和验收指标。");
    expect(prompt).toContain("## 参考资料\n### 架构资料\n参考内容");
    expect(prompt).toContain("可修正当前目标标题中的明显错别字或病句");
    expect(prompt).not.toContain("Coordinator");
    expect(prompt).not.toContain("当前目标子树");
    expect(prompt).not.toContain("heading-2");
  });

  it("没有引用资料时不输出空的参考资料区块", () => {
    const prompt = buildLongWritingWorkerPrompt({
      filePath: "D:\\workspace\\proposal.md",
      targetTitlePath: ["项目概述"],
      targetLevel: 2,
      userInstruction: "扩写本章。",
      referenceContext: "（无引用资料）",
    });

    expect(prompt).not.toContain("## 参考资料");
    expect(prompt).toContain("不需要先提交编辑计划");
  });
});
