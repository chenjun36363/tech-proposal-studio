import type { Project } from "../../core/types";

export type LongWritingAvailabilityIssue = "browser" | "workspace" | "document";

export interface LongWritingAvailability {
  issue: LongWritingAvailabilityIssue;
  title: string;
  description: string;
}

export function getLongWritingAvailability(
  desktop: boolean,
  project: Pick<Project, "workspace" | "filePath">,
): LongWritingAvailability | null {
  if (!desktop) {
    return {
      issue: "browser",
      title: "当前为浏览器运行模式",
      description: "长任务需要桌面端的文件备份、SQLite 恢复和原子写入能力。请使用 TechProposal Studio 桌面端。",
    };
  }
  if (!project.workspace?.root) {
    return {
      issue: "workspace",
      title: "尚未配置桌面工作区",
      description: "请先在设置中选择工作区目录，再打开其中的 Markdown 文件。",
    };
  }
  if (!project.filePath) {
    return {
      issue: "document",
      title: "尚未打开已保存的 Markdown",
      description: "请从工作区文件列表打开 Markdown，或先将当前文档保存到工作区。",
    };
  }
  return null;
}
