import type { Project } from "./types";
import { createProject } from "./data";
import { defaultProposalMarkdown } from "./markdownDoc";
const KEY = "tech-proposal-studio.project.v1";
const LEGACY_KEY = "schematic-writer.project.v1";
function ensureCommands(project: Project): Project {
  const hasAgentChecks = ["claude", "codex", "opencode"].every(p => project.commands?.some(c => c.program === p));
  if (hasAgentChecks && project.commands?.length) return project;
  const base = createProject();
  const existing = project.commands ?? [];
  const extras = base.commands.filter(c => !existing.some(e => e.program === c.program && e.args.join(" ") === c.args.join(" ")));
  return { ...project, commands: [...existing, ...extras] };
}
function ensureMarkdown(project: Project): Project {
  if (typeof project.markdown === "string" && project.markdown.trim()) return project;
  if (project.sections?.length) {
    const md = `# ${project.name || "未命名技术方案"}\n\n${project.sections.map(s => `## ${s.title}\n\n${s.blocks.map(b => b.content).join("\n\n")}`).join("\n\n")}`;
    return { ...project, markdown: md };
  }
  return { ...project, markdown: defaultProposalMarkdown(project.name || "未命名技术方案") };
}
function normalizeProject(raw: Project): Project {
  return ensureCommands(ensureMarkdown(raw));
}
export function loadProject(): Project {
  try {
    const current = localStorage.getItem(KEY);
    if (current) return normalizeProject(JSON.parse(current));
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      localStorage.setItem(KEY, legacy);
      return normalizeProject(JSON.parse(legacy));
    }
    return createProject();
  } catch {
    return createProject();
  }
}
export function saveProject(project: Project) {
  localStorage.setItem(KEY, JSON.stringify({
    ...project,
    updatedAt: new Date().toISOString(),
    model: { ...project.model, apiKey: "" },
    search: { ...project.search, apiKey: "" },
  }));
}
export function exportMarkdown(project: Project) {
  if (typeof project.markdown === "string" && project.markdown.trim()) return project.markdown;
  return `# ${project.name}\n\n${project.sections.map(s => `## ${s.title}\n\n${s.blocks.map(b => b.content).join("\n\n")}`).join("\n\n")}`;
}
