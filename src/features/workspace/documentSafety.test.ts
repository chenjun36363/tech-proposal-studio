import { describe, expect, it, vi } from "vitest";
import { chooseDraftRecovery, deriveDocumentStatus, runDocumentChangeGuard, sameDocumentPath, type TextFileSnapshot, type WorkspaceDocumentDraft } from "./documentSafety";

const snapshot: TextFileSnapshot = { path: "C:\\work\\a.md", content: "disk", sha256: "base", updatedAt: "1" };
const draft = (overrides: Partial<WorkspaceDocumentDraft> = {}): WorkspaceDocumentDraft => ({
  draftId: "draft-1",
  workspaceRoot: "C:\\work",
  filePath: snapshot.path,
  projectId: "project-1",
  projectName: "A",
  markdown: "draft",
  baseHash: "base",
  runtimeLabel: "dev",
  updatedAt: "2026-07-31T10:00:00.000Z",
  ...overrides,
});

describe("document draft recovery", () => {
  it("treats equal paths case-insensitively on Windows", () => {
    expect(sameDocumentPath("C:/WORK/a.md", "c:\\work\\a.md")).toBe(true);
  });

  it("deletes identical stale drafts and keeps disk saved", () => {
    const result = chooseDraftRecovery([draft({ markdown: "disk" })], snapshot, snapshot.path, "project-1");
    expect(result.status).toBe("saved");
    expect(result.staleDraftIds).toEqual(["draft-1"]);
  });

  it("restores a draft based on the current disk version", () => {
    const result = chooseDraftRecovery([draft()], snapshot, snapshot.path, "project-1");
    expect(result.status).toBe("recovered");
    expect(result.draft?.markdown).toBe("draft");
  });

  it("marks a draft as conflicting after external disk changes", () => {
    const result = chooseDraftRecovery([draft({ baseHash: "older" })], snapshot, snapshot.path, "project-1");
    expect(result.status).toBe("conflict");
  });

  it("treats a migrated draft with an unknown disk baseline as a conflict", () => {
    const result = chooseDraftRecovery([draft({ baseHash: null })], snapshot, snapshot.path, "project-1");
    expect(result.status).toBe("conflict");
  });

  it("restores a missing-file draft as dirty", () => {
    const result = chooseDraftRecovery([draft()], null, snapshot.path, "project-1");
    expect(result.status).toBe("dirty");
  });

  it("selects the latest draft and preserves the remaining count", () => {
    const result = chooseDraftRecovery([
      draft({ draftId: "old", updatedAt: "2026-07-31T10:00:00.000Z" }),
      draft({ draftId: "new", updatedAt: "2026-07-31T11:00:00.000Z", runtimeLabel: "production" }),
    ], snapshot, snapshot.path, "project-1");
    expect(result.draft?.draftId).toBe("new");
    expect(result.otherDraftCount).toBe(1);
  });
});


describe("document status", () => {
  it("is saved only when markdown equals the disk baseline", () => {
    expect(deriveDocumentStatus("disk", snapshot, false, "none")).toEqual({ isDirty: false, status: "saved" });
    expect(deriveDocumentStatus("edited", snapshot, false, "none")).toEqual({ isDirty: true, status: "dirty" });
  });

  it("keeps recovered and conflict states while the draft differs from disk", () => {
    expect(deriveDocumentStatus("draft", snapshot, false, "recovered")).toEqual({ isDirty: true, status: "recovered" });
    expect(deriveDocumentStatus("draft", snapshot, false, "conflict")).toEqual({ isDirty: true, status: "conflict" });
  });

  it("returns to saved after undoing all changes to the baseline", () => {
    expect(deriveDocumentStatus("disk", snapshot, false, "recovered")).toEqual({ isDirty: false, status: "saved" });
  });

  it("keeps a missing-file conflict dirty even when content still equals the old baseline", () => {
    expect(deriveDocumentStatus("disk", snapshot, false, "conflict", true)).toEqual({ isDirty: true, status: "conflict" });
  });
});


describe("document change guard", () => {
  function setup(choice: "save" | "discard" | "cancel", saveResult = true) {
    const calls: string[] = [];
    return {
      calls,
      options: {
        isDirty: true,
        flushDraft: vi.fn(async () => { calls.push("flush"); }),
        choose: vi.fn(async () => { calls.push("choose"); return choice; }),
        save: vi.fn(async () => { calls.push("save"); return saveResult; }),
        discard: vi.fn(() => { calls.push("discard"); }),
        clearHandledDrafts: vi.fn(async () => { calls.push("clear"); }),
      },
    };
  }

  it("keeps all editor state when the user cancels", async () => {
    const { options, calls } = setup("cancel");
    expect(await runDocumentChangeGuard(options)).toBe(false);
    expect(calls).toEqual(["flush", "choose"]);
  });

  it("discards only after flushing and clears the handled draft", async () => {
    const { options, calls } = setup("discard");
    expect(await runDocumentChangeGuard(options)).toBe(true);
    expect(calls).toEqual(["flush", "choose", "discard", "clear"]);
  });

  it("continues only when save succeeds", async () => {
    const success = setup("save", true);
    expect(await runDocumentChangeGuard(success.options)).toBe(true);
    expect(success.calls).toEqual(["flush", "choose", "save"]);

    const failure = setup("save", false);
    expect(await runDocumentChangeGuard(failure.options)).toBe(false);
    expect(failure.calls).toEqual(["flush", "choose", "save"]);
  });

  it("does not prompt for a clean document", async () => {
    const { options, calls } = setup("cancel");
    options.isDirty = false;
    expect(await runDocumentChangeGuard(options)).toBe(true);
    expect(calls).toEqual(["flush"]);
  });
});
