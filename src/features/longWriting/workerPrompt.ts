export interface LongWritingWorkerPromptInput {
  filePath: string;
  targetTitlePath: string[];
  targetLevel: number;
  userInstruction: string;
  referenceContext: string;
}

export function buildLongWritingWorkerPrompt(input: LongWritingWorkerPromptInput): string {
  const references = input.referenceContext.trim();
  const referenceSection = references && references !== "（无引用资料）"
    ? `\n\n## 参考资料\n${references}`
    : "";

  return `## 任务
直接修改正式 Markdown 文件中的指定标题范围。

## 正式文件
${input.filePath}

## 修改范围
${input.targetTitlePath.join(" / ")}（H${input.targetLevel}）
从该标题行开始，到下一个同级或更高层级标题之前结束。

## 用户要求
${input.userInstruction.trim()}${referenceSection}

## 执行要求
1. 先重新读取正式文件，以磁盘最新内容为准。
2. 仅修改上述标题范围，不得修改其他章节或其他文件。
3. 保留原有事实、数字、业务范围和 Markdown 标题层级。
4. 可修正当前目标标题中的明显错别字或病句；不得修改子标题文本和标题父子关系。
5. 在本轮直接完成编辑并保存，不需要先提交编辑计划。`;
}
