import type { BlockType, Project, Section } from "./types";
export const blockLabels: Record<BlockType, string> = { text: "正文", table: "表格", code: "代码", mermaid: "架构图", quote: "引用", decision: "决策", evidence: "命令证据" };
const titles = ["背景与目标", "范围与约束", "总体架构", "详细设计", "接口与数据", "安全设计", "部署与迁移", "风险与应对", "测试与验收"];
export const makeId = () => crypto.randomUUID();
export const makeSection = (title: string, order: number): Section => ({ id: makeId(), title, order, blocks: [{ id: makeId(), sectionId: "", type: "text", content: "", order: 0, status: "draft", sourceRefs: [] }] });
export function createProject(): Project {
  const sections = titles.map(makeSection).map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, sectionId: s.id })) }));
  return {
    id: makeId(), name: "未命名技术方案", updatedAt: new Date().toISOString(), sections, sources: [],
    model: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini", timeoutMs: 60000, headers: {}, enabled: true },
    search: { provider: "searxng", endpoint: "", apiKey: "" },
    commands: [{ id: makeId(), name: "检查 Node 版本", program: "node", args: ["--version"], cwd: ".", timeoutMs: 10000, allowShell: false }]
  };
}
