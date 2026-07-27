import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { titleFromMarkdown } from "../markdownDoc";
import { saveProject } from "../storage";
import type { Project } from "../types";

export type ProjectUpdater = (project: Project) => Project;

export function useProposalDocumentController(createInitialProject: () => Project) {
  const [project, setProject] = useState<Project>(createInitialProject);
  const history = useRef<Project[]>([]);
  const redoStack = useRef<Project[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveProject(project), 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [project]);

  const updateProject = (updater: ProjectUpdater, remember = true) => {
    setProject(current => {
      if (remember) {
        history.current.push(structuredClone(current));
        if (history.current.length > 100) history.current.shift();
        redoStack.current = [];
      }
      return updater(current);
    });
  };

  const undo = () => {
    setProject(current => {
      const previous = history.current.pop();
      if (!previous) return current;
      redoStack.current.push(structuredClone(current));
      return previous;
    });
  };

  const redo = () => {
    setProject(current => {
      const next = redoStack.current.pop();
      if (!next) return current;
      history.current.push(structuredClone(current));
      if (history.current.length > 100) history.current.shift();
      return next;
    });
  };

  const resetHistory = () => {
    history.current = [];
    redoStack.current = [];
  };

  const setMarkdown = (markdown: string, remember = true) => {
    updateProject(current => ({
      ...current,
      markdown,
      name: titleFromMarkdown(markdown, current.name),
      updatedAt: new Date().toISOString(),
    }), remember);
  };

  return {
    project,
    setProject: setProject as Dispatch<SetStateAction<Project>>,
    updateProject,
    setMarkdown,
    undo,
    redo,
    resetHistory,
  };
}
