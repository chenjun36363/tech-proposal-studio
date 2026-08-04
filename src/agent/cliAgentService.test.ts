import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentBlock } from "../core/types";
import { buildLocalCliCommand, cliAgentRuntimeLabel, defaultCliAgentModels, normalizeCliAgentConnection, parseCliAgentResponse, parseLocalModelResponse, parseOpenCodeModelCatalog, resolveCliAgentModelOption } from "./cliAgentService";

const block: DocumentBlock = {
  id: "block-1",
  sectionId: "section-1",
  type: "text",
  content: "## 1 背景\n原始内容",
  order: 0,
  status: "draft",
  sourceRefs: [],
};

describe("OpenCode model catalog parsing", () => {
  it("parses provider/model rows and keeps the full provider prefix", () => {
    const models = parseOpenCodeModelCatalog([
      "opencode/deepseek-v4-flash-free",
      "vercel/openai/gpt-5.4",
      "vercel/openai/gpt-5.4",
      "invalid-row",
    ].join("\n"));
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      providerId: "opencode",
      modelId: "deepseek-v4-flash-free",
      modelName: "deepseek-v4-flash-free",
      isDefault: true,
    });
    expect(models[1]).toMatchObject({
      providerId: "vercel/openai",
      modelId: "gpt-5.4",
      providerName: "Vercel / Openai",
    });
  });
});

describe("本地 Agent response parsing", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "call-1" });
  });

  it("parses JSON and creates a safe section draft", () => {
    const result = parseCliAgentResponse(JSON.stringify({
      reply: "我已准备好修改稿。",
      edit: { after: "## 1 背景\n修改后的内容", instruction: "补充背景说明" },
    }), block);
    expect(result.reply).toBe("我已准备好修改稿。");
    expect(result.draft).toMatchObject({
      callId: "call-1",
      operation: "replace_section",
      before: block.content,
      after: "## 1 背景\n修改后的内容",
      target: { sectionId: "section-1", snapshot: block.content },
    });
  });

  it("accepts fenced or embedded JSON and does not create a draft for no-op edits", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const fenced = fence + "json\n{\"reply\":\"只回答不改文档\",\"edit\":null}\n" + fence;
    expect(parseCliAgentResponse(fenced, block)).toEqual({ reply: "只回答不改文档" });
    const embedded = "前置说明 {\"reply\":\"完成\",\"edit\":{\"after\":\"## 1 背景\\n原始内容\"}} 后置说明";
    expect(parseCliAgentResponse(embedded, block)).toEqual({ reply: "完成" });
  });

  it("unwraps Claude result envelopes and removes terminal color codes", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const inner = JSON.stringify({ content: "请确认修改提案", tool_calls: [] });
    const output = `\u001b[32m${fence}json\n${JSON.stringify({ type: "result", subtype: "success", result: inner })}\n${fence}\u001b[0m`;
    expect(parseLocalModelResponse(output).choices?.[0]?.message?.content).toBe("请确认修改提案");
  });

  it("collects text and tool calls from JSON event lines", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "先检查当前章节" } }),
      JSON.stringify({ type: "item.completed", item: { type: "function_call", id: "call-7", name: "read_document_section", arguments: { sectionId: "section-1" } } }),
    ].join("\n");
    const message = parseLocalModelResponse(output).choices?.[0]?.message;
    expect(message?.content).toContain("先检查当前章节");
    expect(message?.tool_calls).toMatchObject([{ id: "call-7", function: { name: "read_document_section" } }]);
  });
});


describe("本地 Agent runtime helpers", () => {
  it("uses local executable commands instead of an HTTP gateway", () => {
    const request = {
      connection: { provider: "codex" as const, model: "gpt-5.2-codex" },
      project: { name: "测试项目", markdown: "", sources: [], contextSourceRefs: [], model: {} as never, search: {} as never, commands: [] } as never,
      block,
      messages: [{ role: "user" as const, content: "请优化本节" }],
      pinnedContext: [],
    };
    const command = buildLocalCliCommand(request);
    expect(command.program).toBe("codex");
    expect(command.args).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--json", "--sandbox", "read-only", "--model", "gpt-5.2-codex", "-"]);
    expect(command.stdin).toContain("请优化本节");
  });

  it("keeps external CLI read-only even when the app enables full access", () => {
    const request = {
      connection: { provider: "codex" as const, model: "" },
      project: { name: "测试项目", markdown: "", sources: [], contextSourceRefs: [], model: {} as never, search: {} as never, commands: [] } as never,
      block,
      messages: [{ role: "user" as const, content: "请直接更新工作区文件" }],
      pinnedContext: [],
      fullAccess: true,
    };
    const command = buildLocalCliCommand(request);
    expect(command.args).toContain("read-only");
    expect(command.args).not.toContain("workspace-write");
    expect(command.stdin).toContain("完全访问");
  });

  it("keeps Claude stateless and never grants the CLI write permissions", () => {
    const base = {
      connection: { provider: "claude" as const, model: "sonnet" },
      project: { name: "测试项目", markdown: "", sources: [], contextSourceRefs: [], model: {} as never, search: {} as never, commands: [] } as never,
      block,
      messages: [{ role: "user" as const, content: "请优化本节" }],
      pinnedContext: [],
    };
    for (const request of [base, { ...base, fullAccess: true }]) {
      const args = buildLocalCliCommand(request).args;
      expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--tools", "", "--permission-mode", "plan"]));
      expect(args).not.toContain("acceptEdits");
    }
  });

  it("does not reuse provider sessions and keeps full access in the app runner", () => {
    const project = { name: "测试项目", markdown: "", sources: [], contextSourceRefs: [], model: {} as never, search: {} as never, commands: [] } as never;
    const messages = [{ role: "user" as const, content: "继续处理" }];
    const claude = buildLocalCliCommand({ connection: { provider: "claude", model: "sonnet" }, project, block, messages, pinnedContext: [], fullAccess: true });
    expect(claude.args).toEqual(expect.arrayContaining(["--no-session-persistence", "--tools", "", "--permission-mode", "plan"]));
    const opencode = buildLocalCliCommand({ connection: { provider: "opencode", model: "openai/gpt-4.1" }, project, block, messages, pinnedContext: [], fullAccess: true });
    expect(opencode.args).toEqual(expect.arrayContaining(["--format", "json", "--pure", "--model", "openai/gpt-4.1"]));
    expect(opencode.args).not.toEqual(expect.arrayContaining(["--continue", "--session", "--auto"]));
    const codex = buildLocalCliCommand({ connection: { provider: "codex", model: "" }, project, block, messages, pinnedContext: [], fullAccess: true });
    expect(codex.args).toEqual(expect.arrayContaining(["--ephemeral", "--json", "--sandbox", "read-only"]));
    expect(codex.args).not.toContain("workspace-write");
  });

  it("cleans up legacy HTTP connection data and placeholder models", () => {
    expect(normalizeCliAgentConnection("codex", { baseUrl: "http://127.0.0.1:8787/v1", model: "codex" })).toEqual({ provider: "codex", model: "" });
    expect(normalizeCliAgentConnection("claude", { baseUrl: "http://127.0.0.1:8788/v1", model: "claude" })).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("resolves a model selector value with a default fallback", () => {
    const model = resolveCliAgentModelOption(defaultCliAgentModels.claude, "");
    expect(model?.modelId).toBe("sonnet");
  });

  it("labels the same runtime phases as the long-task server row", () => {
    expect(cliAgentRuntimeLabel("healthy")).toBe("正常");
    expect(cliAgentRuntimeLabel("stopped")).toBe("已停止");
    expect(cliAgentRuntimeLabel("unknown")).toBe("未检测");
  });
});
