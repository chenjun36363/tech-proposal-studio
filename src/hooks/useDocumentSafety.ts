import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Project } from "../core/types";
import { titleFromMarkdown } from "../features/editor/markdownDoc";
import { saveProject } from "../features/workspace/storage";
import {
  chooseDraftRecovery,
  deriveDocumentStatus,
  deleteWorkspaceDocumentDraft,
  listWorkspaceDocumentDrafts,
  readTextFileSnapshot,
  sameDocumentPath,
  saveWorkspaceDocumentDraft,
  type TextFileSnapshot,
  type WorkspaceDocumentDraft,
} from "../features/workspace/documentSafety";

const runtimeLabel = import.meta.env.DEV ? "dev" : "production";

function newDraftId() {
  return `${runtimeLabel}-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function useDocumentSafety({
  project,
  setProject,
  resetHistory,
  desktop,
  notify,
}: {
  project: Project;
  setProject: Dispatch<SetStateAction<Project>>;
  resetHistory: () => void;
  desktop: boolean;
  notify: (message: string) => void;
}) {
  const [baseline, setBaseline] = useState<TextFileSnapshot | null>(null);
  const [checking, setChecking] = useState(desktop && Boolean(project.filePath));
  const [recoveryKind, setRecoveryKind] = useState<"none" | "recovered" | "conflict">("none");
  const [forceConflictDirty, setForceConflictDirty] = useState(false);
  const [otherDraftCount, setOtherDraftCount] = useState(0);
  const recoveredDraftIdRef = useRef<string | null>(null);
  const sessionDraftIdRef = useRef(newDraftId());
  const draftTimerRef = useRef<number | undefined>(undefined);
  const suppressUnloadDraftFlushRef = useRef(false);
  const projectRef = useRef(project);
  const baselineRef = useRef(baseline);
  const draftBaseHashRef = useRef<string | null>(baseline?.sha256 ?? null);
  const loadedKeyRef = useRef("");
  projectRef.current = project;
  baselineRef.current = baseline;

  const { isDirty, status } = deriveDocumentStatus(project.markdown, baseline, checking, recoveryKind, forceConflictDirty);

  const deleteDraftIds = useCallback(async (ids: Array<string | null | undefined>) => {
    await Promise.all([...new Set(ids.filter((id): id is string => Boolean(id)))].map(id => deleteWorkspaceDocumentDraft(id).catch(() => undefined)));
  }, []);

  const clearHandledDrafts = useCallback(async () => {
    window.clearTimeout(draftTimerRef.current);
    const recovered = recoveredDraftIdRef.current;
    recoveredDraftIdRef.current = null;
    await deleteDraftIds([sessionDraftIdRef.current, recovered]);
    setOtherDraftCount(0);
  }, [deleteDraftIds]);

  const flushDraft = useCallback(async () => {
    const current = projectRef.current;
    const currentBaseline = baselineRef.current;
    const root = current.workspace?.root;
    const dirty = forceConflictDirty || (currentBaseline ? current.markdown !== currentBaseline.content : true);
    saveProject(current);
    if (!desktop || !root || !dirty || checking) return;
    const draft: WorkspaceDocumentDraft = {
      draftId: sessionDraftIdRef.current,
      workspaceRoot: root,
      filePath: current.filePath ?? null,
      projectId: current.id,
      projectName: current.name,
      markdown: current.markdown,
      baseHash: draftBaseHashRef.current,
      runtimeLabel,
      updatedAt: new Date().toISOString(),
    };
    await saveWorkspaceDocumentDraft(draft);
  }, [checking, desktop, forceConflictDirty]);

  useEffect(() => {
    window.clearTimeout(draftTimerRef.current);
    if (status === "checking") return;
    if (status === "saved") {
      void clearHandledDrafts();
      return;
    }
    draftTimerRef.current = window.setTimeout(() => void flushDraft().catch(error => {
      notify(error instanceof Error ? `草稿缓存失败：${error.message}` : "草稿缓存失败");
    }), 500);
    return () => window.clearTimeout(draftTimerRef.current);
  }, [project.markdown, project.filePath, project.name, project.id, project.workspace?.root, status, flushDraft, clearHandledDrafts, notify]);

  const openWithRecovery = useCallback(async (path: string, seed: Project, migrateCachedProject = false): Promise<Project> => {
    const root = seed.workspace?.root;
    const key = `${root ?? ""}|${path}`.toLocaleLowerCase();
    loadedKeyRef.current = key;
    setChecking(true);
    let snapshot: TextFileSnapshot | null = null;
    let readError: unknown = null;
    try {
      snapshot = await readTextFileSnapshot(path);
    } catch (error) {
      readError = error;
    }
    let drafts: WorkspaceDocumentDraft[] = [];
    try {
      drafts = root ? await listWorkspaceDocumentDrafts(root) : [];
    } catch (error) {
      setChecking(false);
      throw error;
    }
    // Migrate this runtime's pre-upgrade localStorage body as its own candidate. Do not
    // suppress it merely because another dev/production instance already has a draft.
    const cachedBodyNeedsMigration = migrateCachedProject
      && Boolean(seed.filePath)
      && Boolean(seed.markdown.trim())
      && (!snapshot || seed.markdown !== snapshot.content)
      && !drafts.some(draft => sameDocumentPath(draft.filePath, path) && draft.markdown === seed.markdown);
    if (cachedBodyNeedsMigration) {
      const migrated: WorkspaceDocumentDraft = {
        draftId: sessionDraftIdRef.current,
        workspaceRoot: root ?? "",
        filePath: path,
        projectId: seed.id,
        projectName: seed.name,
        markdown: seed.markdown,
        // Pre-upgrade localStorage did not retain its disk baseline. Treat it as
        // unknown so an existing disk file requires explicit conflict resolution.
        baseHash: null,
        runtimeLabel,
        updatedAt: seed.updatedAt || new Date().toISOString(),
      };
      if (root) await saveWorkspaceDocumentDraft(migrated).catch(() => undefined);
      drafts = [migrated, ...drafts];
    }
    const decision = chooseDraftRecovery(drafts, snapshot, path, seed.id);
    await deleteDraftIds(decision.staleDraftIds);

    const recovered = decision.draft;
    if (!snapshot && !recovered) {
      setChecking(false);
      throw readError instanceof Error ? readError : new Error("文件不存在且没有可恢复草稿");
    }

    const markdown = recovered?.markdown ?? snapshot?.content ?? seed.markdown;
    setBaseline(snapshot);
    baselineRef.current = snapshot;
    draftBaseHashRef.current = recovered?.baseHash ?? snapshot?.sha256 ?? null;
    setForceConflictDirty(false);
    recoveredDraftIdRef.current = recovered?.draftId === sessionDraftIdRef.current ? null : (recovered?.draftId ?? null);
    const nextKind = recovered
      ? (!snapshot ? "recovered" : recovered.baseHash === snapshot.sha256 ? "recovered" : "conflict")
      : "none";
    setRecoveryKind(nextKind);
    setOtherDraftCount(decision.otherDraftCount);
    setChecking(false);
    return {
      ...seed,
      name: titleFromMarkdown(markdown, seed.name),
      markdown,
      filePath: snapshot?.path ?? recovered?.filePath ?? path,
      updatedAt: new Date().toISOString(),
    };
  }, [deleteDraftIds]);

  const markSaved = useCallback(async (snapshot: TextFileSnapshot) => {
    setBaseline(snapshot);
    baselineRef.current = snapshot;
    draftBaseHashRef.current = snapshot.sha256;
    setRecoveryKind("none");
    setForceConflictDirty(false);
    setChecking(false);
    await clearHandledDrafts();
  }, [clearHandledDrafts]);

  const markUnsaved = useCallback(() => {
    setBaseline(null);
    baselineRef.current = null;
    draftBaseHashRef.current = null;
    setRecoveryKind("none");
    setForceConflictDirty(false);
    setChecking(false);
    recoveredDraftIdRef.current = null;
  }, []);

  const markConflict = useCallback((snapshot?: TextFileSnapshot | null) => {
    if (snapshot) {
      setBaseline(snapshot);
      baselineRef.current = snapshot;
      setForceConflictDirty(false);
    } else {
      setBaseline(null);
      baselineRef.current = null;
      setForceConflictDirty(true);
    }
    // Keep draftBaseHashRef unchanged: it identifies the disk version the editor
    // content was actually based on, which is essential for conflict recovery.
    setRecoveryKind("conflict");
  }, []);

  const discardChanges = useCallback(() => {
    const currentBaseline = baselineRef.current;
    const current = projectRef.current;
    const next = !currentBaseline
      ? {
          ...current,
          name: "未命名文档",
          markdown: "# 未命名文档\n",
          filePath: undefined,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...current,
          markdown: currentBaseline.content,
          filePath: currentBaseline.path,
          name: titleFromMarkdown(currentBaseline.content, current.name),
          updatedAt: new Date().toISOString(),
        };
    projectRef.current = next;
    setRecoveryKind("none");
    setForceConflictDirty(false);
    setProject(next);
    resetHistory();
  }, [resetHistory, setProject]);

  const renameBaseline = useCallback((path: string) => {
    setBaseline(current => current ? { ...current, path } : current);
    if (baselineRef.current) baselineRef.current = { ...baselineRef.current, path };
  }, []);

  const getBaseline = useCallback(() => baselineRef.current, []);
  const suppressNextUnloadDraftFlush = useCallback(() => {
    suppressUnloadDraftFlushRef.current = true;
  }, []);

  useEffect(() => {
    if (!desktop || !project.filePath || !project.workspace?.root) {
      setChecking(false);
      return;
    }
    const key = `${project.workspace.root}|${project.filePath}`.toLocaleLowerCase();
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    void openWithRecovery(project.filePath, project, true)
      .then(next => {
        resetHistory();
        setProject(next);
        if (next.markdown !== project.markdown) {
          const count = otherDraftCount ? `，另有 ${otherDraftCount} 份草稿保留` : "";
          notify(`已恢复未保存草稿${count}`);
        }
      })
      .catch(error => {
        setChecking(false);
        notify(error instanceof Error ? error.message : "检查磁盘与草稿失败");
      });
    // Startup/path changes are intentionally keyed only by workspace and file path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, project.filePath, project.workspace?.root]);

  useEffect(() => {
    const flushLocal = () => {
      saveProject(projectRef.current);
      if (suppressUnloadDraftFlushRef.current) return;
      void flushDraft().catch(() => undefined);
    };
    window.addEventListener("pagehide", flushLocal);
    window.addEventListener("beforeunload", flushLocal);
    return () => {
      window.removeEventListener("pagehide", flushLocal);
      window.removeEventListener("beforeunload", flushLocal);
    };
  }, [flushDraft]);

  return useMemo(() => ({
    baseline,
    isDirty,
    status,
    otherDraftCount,
    openWithRecovery,
    markSaved,
    markUnsaved,
    markConflict,
    discardChanges,
    renameBaseline,
    getBaseline,
    suppressNextUnloadDraftFlush,
    flushDraft,
    clearHandledDrafts,
  }), [baseline, isDirty, status, otherDraftCount, openWithRecovery, markSaved, markUnsaved, markConflict, discardChanges, renameBaseline, getBaseline, suppressNextUnloadDraftFlush, flushDraft, clearHandledDrafts]);
}
