import { describe, expect, it, vi } from "vitest";
import { AgentToolRegistry } from "./toolRegistry";
import { registerAgentGitTools, validateGitRelativePath, type AgentGitRuntime } from "./gitTools";

function runtime(): AgentGitRuntime {
  return {
    status: vi.fn().mockResolvedValue({ isRepository: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, stashCount: 0, remoteUrl: null, files: [] }),
    diff: vi.fn().mockResolvedValue({ path: "src/App.tsx", staged: false, patch: "diff" }),
    log: vi.fn().mockResolvedValue([{ hash: "abc", shortHash: "abc", subject: "test", author: "A", authoredAt: "now", refs: [] }]),
    showCommit: vi.fn().mockResolvedValue({ path: "abc", staged: false, patch: "show" }),
    branches: vi.fn().mockResolvedValue([{ name: "main", kind: "local", current: true }]),
    stage: vi.fn().mockResolvedValue(undefined), unstage: vi.fn().mockResolvedValue(undefined), commit: vi.fn().mockResolvedValue(undefined),
    createBranch: vi.fn().mockResolvedValue(undefined), switchBranch: vi.fn().mockResolvedValue(undefined),
    stashPush: vi.fn().mockResolvedValue(undefined), stashPop: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined), pull: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue(undefined), changed: vi.fn(),
  };
}

describe("Agent Git tools", () => {
  it("registers the supported safe tool set without destructive commands", () => {
    const registry = registerAgentGitTools(new AgentToolRegistry(), runtime(), vi.fn().mockResolvedValue(true));
    const names = registry.definitions().map(item => item.function.name);
    expect(names).toEqual(expect.arrayContaining(["git_status", "git_changes", "git_diff", "git_log", "git_show_commit", "git_list_branches", "git_stage", "git_commit", "git_pull", "git_push"]));
    expect(names.some(name => /reset|clean|force|discard|remote|init|delete/.test(name))).toBe(false);
  });

  it("maps read-only operations directly to the runtime", async () => {
    const git = runtime();
    const review = vi.fn();
    const registry = registerAgentGitTools(new AgentToolRegistry(), git, review);
    const signal = new AbortController().signal;
    const status = await registry.execute({ id: "s", name: "git_status", arguments: {} }, signal);
    const diff = await registry.execute({ id: "d", name: "git_diff", arguments: { path: "src/App.tsx", staged: true } }, signal);
    await registry.execute({ id: "l", name: "git_log", arguments: { limit: 500 } }, signal);
    expect(status.isError).toBe(false);
    expect(diff.data).toEqual(expect.objectContaining({ patch: "diff" }));
    expect(git.diff).toHaveBeenCalledWith("src/App.tsx", true);
    expect(git.log).toHaveBeenCalledWith(200);
    expect(review).not.toHaveBeenCalled();
  });

  it("collects staged, unstaged and untracked changes in one read-only call", async () => {
    const git = runtime();
    vi.mocked(git.status).mockResolvedValue({
      isRepository: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0, stashCount: 0, remoteUrl: null,
      files: [
        { path: "src/a.ts", indexStatus: "M", worktreeStatus: "M" },
        { path: "src/new.ts", indexStatus: "?", worktreeStatus: "?" },
      ],
    });
    vi.mocked(git.diff).mockImplementation(async (path, staged) => ({ path, staged, patch: `${staged ? "staged" : "unstaged"}:${path}` }));
    const review = vi.fn();
    const result = await registerAgentGitTools(new AgentToolRegistry(), git, review).execute(
      { id: "changes", name: "git_changes", arguments: {} }, new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.data).toEqual(expect.objectContaining({ scope: "all", truncated: false }));
    expect(result.content).toContain("staged:src/a.ts");
    expect(result.content).toContain("unstaged:src/new.ts");
    expect(git.diff).toHaveBeenCalledWith("src/a.ts", true);
    expect(git.diff).toHaveBeenCalledWith("src/a.ts", false);
    expect(git.diff).toHaveBeenCalledWith("src/new.ts", false);
    expect(review).not.toHaveBeenCalled();
  });

  it("executes Git mutations without approval in full access mode", async () => {
    const git = runtime();
    const review = vi.fn().mockResolvedValue(false);
    const result = await registerAgentGitTools(new AgentToolRegistry(), git, review, { fullAccess: true }).execute(
      { id: "full", name: "git_commit", arguments: { message: "feat: full access" } }, new AbortController().signal,
    );
    expect(review).not.toHaveBeenCalled();
    expect(git.commit).toHaveBeenCalledWith("feat: full access");
    expect(result.data).toEqual(expect.objectContaining({ approved: true, approvalMode: "full_access" }));
  });

  it("does not execute a rejected mutation", async () => {
    const git = runtime();
    const review = vi.fn().mockResolvedValue(false);
    const result = await registerAgentGitTools(new AgentToolRegistry(), git, review).execute(
      { id: "c", name: "git_commit", arguments: { message: "feat: add git tools" } }, new AbortController().signal,
    );
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ operation: "commit" }), expect.any(AbortSignal));
    expect(git.commit).not.toHaveBeenCalled();
    expect(git.changed).not.toHaveBeenCalled();
    expect(result.content).toContain("用户已拒绝");
  });

  it("executes an approved mutation and broadcasts a refresh", async () => {
    const git = runtime();
    const result = await registerAgentGitTools(new AgentToolRegistry(), git, vi.fn().mockResolvedValue(true)).execute(
      { id: "a", name: "git_stage", arguments: { scope: "all" } }, new AbortController().signal,
    );
    expect(git.stage).toHaveBeenCalledWith(undefined);
    expect(git.changed).toHaveBeenCalledOnce();
    expect(result.data).toEqual(expect.objectContaining({ operation: "stage", approved: true }));
  });

  it("propagates cancellation while waiting for approval", async () => {
    const git = runtime();
    const controller = new AbortController();
    const review = vi.fn((_request, signal: AbortSignal) => new Promise<boolean>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    const pending = registerAgentGitTools(new AgentToolRegistry(), git, review).execute(
      { id: "p", name: "git_push", arguments: {} }, controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(git.push).not.toHaveBeenCalled();
  });

  it("rejects paths outside the fixed workspace and invalid arguments", async () => {
    expect(() => validateGitRelativePath("../secret.txt")).toThrow("工作区内");
    expect(() => validateGitRelativePath("C:\\secret.txt")).toThrow("工作区内");
    const git = runtime();
    const registry = registerAgentGitTools(new AgentToolRegistry(), git, vi.fn().mockResolvedValue(true));
    const result = await registry.execute({ id: "x", name: "git_diff", arguments: { path: "/etc/passwd" } }, new AbortController().signal);
    const emptyCommit = await registry.execute({ id: "e", name: "git_commit", arguments: { message: "  " } }, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(emptyCommit.isError).toBe(true);
    expect(git.diff).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
  });
});
