import { agentCompletion } from "../../services/model";
import { resolveActiveModelConfig } from "../../services/llm/resolve";
import type { AgentModelResponse } from "../../agent/protocol";
import type { Project } from "../../types";

export function normalizeCommitMessage(value: string): string {
  return value
    .replace(/^```(?:text)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
    .split(/\r?\n/)
    .find(line => line.trim())
    ?.trim()
    .replace(/^["'`]|["'`]$/g, "")
    .slice(0, 120) ?? "";
}

export async function generateCommitMessage(project: Project, stagedSummary: string): Promise<string> {
  const config = resolveActiveModelConfig(project.providers ?? [], project.selectedModel, {
    aiEnabled: project.model?.enabled !== false,
  });
  const response = await agentCompletion({
    model: config.model,
    messages: [
      { role: "system", content: "你是 Git 提交说明编辑器。只返回一行提交说明，不要解释、引号或 Markdown。使用 Conventional Commits 格式：type: 简洁中文描述。type 仅可为 feat、fix、docs、refactor、test、chore、style、perf、build、ci。描述具体改动和目的，不超过 72 个中文字符。" },
      { role: "user", content: stagedSummary },
    ],
    temperature: 0.2,
    max_tokens: 100,
    stream: false,
  }, config) as AgentModelResponse;
  const content = response.choices?.[0]?.message?.content;
  const message = normalizeCommitMessage(typeof content === "string" ? content : "");
  if (!message) throw new Error("模型未生成有效的提交说明");
  return message;
}
