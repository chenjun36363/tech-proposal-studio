import type { Project } from "./types";
import { createProject } from "./data";
const KEY = "tech-proposal-studio.project.v1";
const LEGACY_KEY = "schematic-writer.project.v1";
export function loadProject(): Project { try { const current = localStorage.getItem(KEY); if (current) return JSON.parse(current); const legacy = localStorage.getItem(LEGACY_KEY); if (legacy) { localStorage.setItem(KEY, legacy); return JSON.parse(legacy); } return createProject(); } catch { return createProject(); } }
export function saveProject(project: Project) { localStorage.setItem(KEY, JSON.stringify({ ...project, updatedAt: new Date().toISOString(), model: { ...project.model, apiKey: "" }, search: { ...project.search, apiKey: "" } })); }
export function exportMarkdown(project: Project) { return `# ${project.name}\n\n${project.sections.map(s => `## ${s.title}\n\n${s.blocks.map(b => b.content).join("\n\n")}`).join("\n\n")}`; }
