import type { DocumentBlock, Project, WordExportPreferences } from "../../core/types";
import { createProject, DEFAULT_WORD_EXPORT_PREFERENCES } from "../../core/data";
import { defaultProposalMarkdown } from "../editor/markdownDoc";
import { normalizeAgentSettings } from "../../agent/settings";
const KEY = "tech-proposal-studio.project.v1";
const LEGACY_KEY = "schematic-writer.project.v1";
function ensureCommands(project: Project): Project {
  const hasAgentChecks = ["claude", "codex", "opencode", "codebuddy"].every(p => project.commands?.some(c => c.program === p));
  if (hasAgentChecks && project.commands?.length) return project;
  const base = createProject();
  const existing = project.commands ?? [];
  const extras = base.commands.filter(c => !existing.some(e => e.program === c.program && e.args.join(" ") === c.args.join(" ")));
  return { ...project, commands: [...existing, ...extras] };
}
interface LegacySection {
  title?: string;
  blocks?: DocumentBlock[];
}

type StoredProject = Omit<Project, "contextSourceRefs" | "wordExport"> & {
  contextSourceRefs?: string[];
  wordExport?: Partial<WordExportPreferences>;
  sections?: LegacySection[];
};

function ensureMarkdown(project: StoredProject): StoredProject {
  if (typeof project.markdown === "string" && project.markdown.trim()) return project;
  if (project.sections?.length) {
    const md = `# ${project.name || "未命名技术方案"}\n\n${project.sections.map(s => `## ${s.title ?? "未命名章节"}\n\n${(s.blocks ?? []).map(b => b.content).join("\n\n")}`).join("\n\n")}`;
    return { ...project, markdown: md };
  }
  return { ...project, markdown: defaultProposalMarkdown(project.name || "未命名技术方案") };
}
function ensureWordExport(project: Project): Project {
  const stored = project.wordExport as Partial<WordExportPreferences> | undefined;
  const value: Partial<WordExportPreferences> = stored && typeof stored === "object" ? stored : {};
  const text = (key: keyof Omit<WordExportPreferences, "showFooterPageNumbers">) =>
    typeof value[key] === "string" ? value[key] : DEFAULT_WORD_EXPORT_PREFERENCES[key];
  return {
    ...project,
    wordExport: {
      coverLogoDataUrl: text("coverLogoDataUrl"),
      companyNameZh: text("companyNameZh"),
      companyNameEn: text("companyNameEn"),
      companyAddress: text("companyAddress"),
      companyPhone: text("companyPhone"),
      companyFax: text("companyFax"),
      companyWebsite: text("companyWebsite"),
      companyEmail: text("companyEmail"),
      headerTitle: text("headerTitle"),
      showFooterPageNumbers: typeof value.showFooterPageNumbers === "boolean"
        ? value.showFooterPageNumbers
        : DEFAULT_WORD_EXPORT_PREFERENCES.showFooterPageNumbers,
    },
  };
}

function ensureMineru(project: Project): Project {
  if (project.mineru && typeof project.mineru === "object") {
    const base = createProject().mineru;
    return {
      ...project,
      mineru: {
        baseUrl: typeof project.mineru.baseUrl === "string" ? project.mineru.baseUrl : base.baseUrl,
        apiKey: typeof project.mineru.apiKey === "string" ? project.mineru.apiKey : "",
        modelVersion: typeof project.mineru.modelVersion === "string" ? project.mineru.modelVersion : base.modelVersion,
        language: typeof project.mineru.language === "string" ? project.mineru.language : base.language,
        isOcr: typeof project.mineru.isOcr === "boolean" ? project.mineru.isOcr : base.isOcr,
        enableTable: typeof project.mineru.enableTable === "boolean" ? project.mineru.enableTable : base.enableTable,
        enableFormula: typeof project.mineru.enableFormula === "boolean" ? project.mineru.enableFormula : base.enableFormula,
        timeoutSeconds: typeof project.mineru.timeoutSeconds === "number" ? project.mineru.timeoutSeconds : base.timeoutSeconds,
        pollIntervalSeconds: typeof project.mineru.pollIntervalSeconds === "number" ? project.mineru.pollIntervalSeconds : base.pollIntervalSeconds,
      },
    };
  }
  return { ...project, mineru: createProject().mineru };
}

function migrateLegacyStructure(raw: StoredProject): Project {
  const contextSourceRefs = Array.isArray(raw.contextSourceRefs)
    ? raw.contextSourceRefs.filter(id => typeof id === "string")
    : raw.sections?.[0]?.blocks?.[0]?.sourceRefs ?? [];
  const { sections: _legacySections, ...project } = raw;
  return { ...project, contextSourceRefs, wordExport: { ...DEFAULT_WORD_EXPORT_PREFERENCES, ...(project.wordExport ?? {}) } };
}

function ensureProviders(project: Project): Project {
  if (Array.isArray(project.providers) && project.providers.length) {
    const model = project.model ?? createProject().model;
    return {
      ...project,
      providers: project.providers,
      selectedModel: project.selectedModel ?? (model.model
        ? { providerId: project.providers[0].id, model: model.model }
        : null),
      model,
    };
  }
  const base = createProject();
  const legacyModel = project.model ?? base.model;
  const provider = {
    ...base.providers[0],
    baseUrl: legacyModel.baseUrl || base.providers[0].baseUrl,
    apiKey: "",
    timeoutMs: legacyModel.timeoutMs || 60000,
    headers: { ...(legacyModel.headers ?? {}) },
    enabled: legacyModel.enabled !== false,
    activeModels: legacyModel.model ? [legacyModel.model] : [...base.providers[0].activeModels],
    catalog: legacyModel.model ? [{ id: legacyModel.model, displayName: legacyModel.model }] : base.providers[0].catalog,
  };
  const selectedModel = legacyModel.model
    ? { providerId: provider.id, model: legacyModel.model }
    : null;
  return {
    ...project,
    providers: [provider],
    selectedModel,
    model: { ...legacyModel, apiKey: legacyModel.apiKey ?? "", headers: { ...(legacyModel.headers ?? {}) } },
  };
}

function normalizeProject(raw: StoredProject): Project {
  const markdownReady = ensureMarkdown(raw);
  const migrated = migrateLegacyStructure(markdownReady);
  return ensureCommands(ensureProviders(ensureWordExport(ensureMineru({ ...migrated, agent: normalizeAgentSettings(migrated.agent) }))));
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
    providers: (project.providers ?? []).map(provider => ({ ...provider, apiKey: "" })),
    search: { ...project.search, apiKey: "" },
    mineru: { ...(project.mineru ?? createProject().mineru), apiKey: "" },
  }));
}
export function exportMarkdown(project: Project) {
  if (typeof project.markdown === "string" && project.markdown.trim()) return project.markdown;
  return defaultProposalMarkdown(project.name || "未命名技术方案");
}
