import type { GitBranchInfo, GitCommitSummary, GitDiffResult, GitRepositoryStatus } from "../services/git";
import type { AgentGitApprovalRequest } from "./protocol";
import { AgentToolRegistry, objectSchema } from "./toolRegistry";

export const AGENT_GIT_CHANGED = "tech-proposal-studio:git-changed";

export interface AgentGitRuntime {
  status: () => Promise<GitRepositoryStatus>;
  diff: (path: string, staged: boolean) => Promise<GitDiffResult>;
  log: (limit: number) => Promise<GitCommitSummary[]>;
  showCommit: (commit: string) => Promise<GitDiffResult>;
  branches: () => Promise<GitBranchInfo[]>;
  stage: (path?: string) => Promise<void>;
  unstage: (path?: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
  createBranch: (branch: string) => Promise<void>;
  switchBranch: (branch: GitBranchInfo) => Promise<void>;
  stashPush: () => Promise<void>;
  stashPop: () => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  changed?: () => void;
}

const requiredText = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数：${field}`);
  return value.trim();
};

export function validateGitRelativePath(value: unknown): string {
  const path = requiredText(value, "path").replace(/\\/g, "/");
  if (/^(?:[a-zA-Z]:|\/)/.test(path) || path.split("/").some(part => part === "..")) throw new Error("Git 文件路径必须位于工作区内");
  return path;
}

const approvalResult = (request: AgentGitApprovalRequest, approved: boolean) => approved
  ? null
  : { content: `用户已拒绝 Git 操作：${request.title}。不得声称操作已执行。`, data: { operation: request.operation, approved: false }, isError: false };

export function registerAgentGitTools(registry: AgentToolRegistry, runtime: AgentGitRuntime, review: (request: AgentGitApprovalRequest, signal: AbortSignal) => Promise<boolean>) {
  const readResult = (data: unknown) => ({ content: JSON.stringify(data, null, 2), data, isError: false });
  const mutate = async (request: AgentGitApprovalRequest, signal: AbortSignal, execute: () => Promise<void>) => {
    const rejected = approvalResult(request, await review(request, signal));
    if (rejected) return rejected;
    await execute();
    runtime.changed?.();
    return { content: `Git 操作已完成：${request.title}`, data: { operation: request.operation, approved: true }, isError: false };
  };

  registry
    .register({ definition: { type: "function", function: { name: "git_status", description: "读取当前工作区 Git 状态、分支、远程跟踪和文件变更。", parameters: objectSchema({}) } }, execute: async () => readResult(await runtime.status()) })
    .register({ definition: { type: "function", function: { name: "git_diff", description: "读取工作区内单个文件的未暂存或已暂存差异。", parameters: objectSchema({ path: { type: "string" }, staged: { type: "boolean" } }, ["path"]) } }, execute: async args => readResult(await runtime.diff(validateGitRelativePath(args.path), args.staged === true)) })
    .register({ definition: { type: "function", function: { name: "git_log", description: "读取当前仓库最近提交记录。limit 为 1–200 的整数；历史调用的超界数值会安全截断。", parameters: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 200 } }) } }, normalizeArgs: args => ({ ...args, limit: typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : args.limit }), execute: async args => readResult(await runtime.log(typeof args.limit === "number" ? args.limit : 50)) })
    .register({ definition: { type: "function", function: { name: "git_show_commit", description: "读取指定提交的详情和补丁，仅接受十六进制提交标识。", parameters: objectSchema({ commit: { type: "string" } }, ["commit"]) } }, execute: async args => { const commit = requiredText(args.commit, "commit"); if (!/^[0-9a-fA-F]+$/.test(commit)) throw new Error("提交标识无效"); return readResult(await runtime.showCommit(commit)); } })
    .register({ definition: { type: "function", function: { name: "git_list_branches", description: "列出本地和远程 Git 分支。", parameters: objectSchema({}) } }, execute: async () => readResult(await runtime.branches()) })
    .register({ definition: { type: "function", function: { name: "git_stage", description: "暂存单个工作区文件或全部变更。执行前必须由用户审批。", parameters: objectSchema({ scope: { type: "string", enum: ["file", "all"] }, path: { type: "string" } }, ["scope"]) } }, execute: async (args, signal) => { const all = args.scope === "all"; if (!all && args.scope !== "file") throw new Error("scope 必须是 file 或 all"); const path = all ? undefined : validateGitRelativePath(args.path); const request: AgentGitApprovalRequest = { operation: "stage", title: all ? "暂存全部变更" : "暂存文件", description: "变更将加入 Git 暂存区。", details: [{ label: "范围", value: path ?? "全部变更" }] }; return mutate(request, signal, () => runtime.stage(path)); } })
    .register({ definition: { type: "function", function: { name: "git_unstage", description: "取消暂存单个文件或全部变更。执行前必须由用户审批。", parameters: objectSchema({ scope: { type: "string", enum: ["file", "all"] }, path: { type: "string" } }, ["scope"]) } }, execute: async (args, signal) => { const all = args.scope === "all"; if (!all && args.scope !== "file") throw new Error("scope 必须是 file 或 all"); const path = all ? undefined : validateGitRelativePath(args.path); const request: AgentGitApprovalRequest = { operation: "unstage", title: all ? "取消暂存全部变更" : "取消暂存文件", description: "变更将从 Git 暂存区移回工作区。", details: [{ label: "范围", value: path ?? "全部变更" }] }; return mutate(request, signal, () => runtime.unstage(path)); } })
    .register({ definition: { type: "function", function: { name: "git_commit", description: "使用指定说明提交当前暂存区。执行前必须由用户审批。", parameters: objectSchema({ message: { type: "string" } }, ["message"]) } }, execute: async (args, signal) => { const message = requiredText(args.message, "message"); const request: AgentGitApprovalRequest = { operation: "commit", title: "创建 Git 提交", description: "将使用当前暂存区创建本地提交。", details: [{ label: "提交说明", value: message }] }; return mutate(request, signal, () => runtime.commit(message)); } })
    .register({ definition: { type: "function", function: { name: "git_create_branch", description: "创建并切换到新的本地分支。执行前必须由用户审批。", parameters: objectSchema({ branch: { type: "string" } }, ["branch"]) } }, execute: async (args, signal) => { const branch = requiredText(args.branch, "branch"); const request: AgentGitApprovalRequest = { operation: "create_branch", title: "创建并切换分支", description: "将从当前 HEAD 创建本地分支。", details: [{ label: "分支", value: branch }] }; return mutate(request, signal, () => runtime.createBranch(branch)); } })
    .register({ definition: { type: "function", function: { name: "git_switch_branch", description: "切换到本地或远程分支。执行前必须由用户审批。", parameters: objectSchema({ branch: { type: "string" }, kind: { type: "string", enum: ["local", "remote"] } }, ["branch", "kind"]) } }, execute: async (args, signal) => { const branch = requiredText(args.branch, "branch"); if (args.kind !== "local" && args.kind !== "remote") throw new Error("kind 必须是 local 或 remote"); const kind = args.kind; const request: AgentGitApprovalRequest = { operation: "switch_branch", title: "切换 Git 分支", description: "工作区文件可能随分支切换而改变。", details: [{ label: "分支", value: branch }, { label: "类型", value: kind }] }; return mutate(request, signal, () => runtime.switchBranch({ name: branch, kind, current: false })); } })
    .register({ definition: { type: "function", function: { name: "git_stash_push", description: "暂存包含未跟踪文件在内的工作区变更。执行前必须由用户审批。", parameters: objectSchema({}) } }, execute: async (_args, signal) => mutate({ operation: "stash_push", title: "保存 Git stash", description: "当前工作区变更将保存到 stash。", details: [] }, signal, runtime.stashPush) })
    .register({ definition: { type: "function", function: { name: "git_stash_pop", description: "应用并移除最近的 stash。执行前必须由用户审批。", parameters: objectSchema({}) } }, execute: async (_args, signal) => mutate({ operation: "stash_pop", title: "应用最近的 Git stash", description: "可能产生需要手工解决的合并冲突。", details: [] }, signal, runtime.stashPop) })
    .register({ definition: { type: "function", function: { name: "git_fetch", description: "从 origin 获取并清理远程引用。执行前必须由用户审批。", parameters: objectSchema({}) } }, execute: async (_args, signal) => mutate({ operation: "fetch", title: "获取远程更新", description: "将连接 origin 并更新远程引用。", details: [] }, signal, runtime.fetch) })
    .register({ definition: { type: "function", function: { name: "git_pull", description: "以 fast-forward only 方式从 origin 拉取。执行前必须由用户审批。", parameters: objectSchema({}) } }, execute: async (_args, signal) => mutate({ operation: "pull", title: "拉取远程更新", description: "仅允许 fast-forward，不会自动创建合并提交。", details: [] }, signal, runtime.pull) })
    .register({ definition: { type: "function", function: { name: "git_push", description: "推送当前分支到 origin，必要时建立 upstream。执行前必须由用户审批。", parameters: objectSchema({}) } }, execute: async (_args, signal) => mutate({ operation: "push", title: "推送当前分支", description: "将本地提交发送到 origin，不使用强制推送。", details: [] }, signal, runtime.push) });
  return registry;
}
