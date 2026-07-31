export type AgentResponseStyle = "concise" | "balanced" | "detailed";
export type AgentCitationMode = "required" | "preferred" | "off";

export interface AgentSettings {
  disabledTools: string[];
  enabledSkills: import("../features/skills/skills").SkillReference[];
  contextCompressionTokens: number;
  maxRounds: number;
  webSearchMaxCalls: number;
  recentMessages: number;
  pinnedContextChars: number;
  temperature: number;
  responseStyle: AgentResponseStyle;
  citationMode: AgentCitationMode;
  customInstructions: string;
  knowledgeToolsEnabled: boolean;
  memoryEnabled: boolean;
  memoryIndexLimit: number;
  autoRemember: boolean;
  planningEnabled: boolean;
  defaultPinnedContextOnly: boolean;
}

export const defaultAgentSettings: AgentSettings = {
  disabledTools: [],
  enabledSkills: [],
  contextCompressionTokens: 48000,
  maxRounds: 20,
  webSearchMaxCalls: 2,
  recentMessages: 20,
  pinnedContextChars: 24000,
  temperature: 0.3,
  responseStyle: "balanced",
  citationMode: "preferred",
  customInstructions: "",
  knowledgeToolsEnabled: true,
  memoryEnabled: true,
  memoryIndexLimit: 20,
  autoRemember: true,
  planningEnabled: true,
  defaultPinnedContextOnly: false,
};

const numberInRange = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function normalizeAgentSettings(value: Partial<AgentSettings> | null | undefined): AgentSettings {
  const source = value ?? {};
  return {
    disabledTools: Array.isArray(source.disabledTools) ? [...new Set(source.disabledTools.filter((name): name is string => typeof name === "string"))] : [],
    enabledSkills: Array.isArray(source.enabledSkills) ? source.enabledSkills.filter((skill): skill is import("../features/skills/skills").SkillReference => Boolean(
      skill && typeof skill.name === "string" && ["builtin", "global", "workspace"].includes(skill.scope)
      && typeof skill.baseDir === "string" && typeof skill.skillFile === "string",
    )) : [],
    contextCompressionTokens: Math.round(numberInRange(source.contextCompressionTokens, defaultAgentSettings.contextCompressionTokens, 8000, 200000)),
    maxRounds: Math.round(numberInRange(source.maxRounds, defaultAgentSettings.maxRounds, 4, 50)),
    webSearchMaxCalls: Math.round(numberInRange(source.webSearchMaxCalls, defaultAgentSettings.webSearchMaxCalls, 1, 10)),
    recentMessages: Math.round(numberInRange(source.recentMessages, defaultAgentSettings.recentMessages, 4, 100)),
    pinnedContextChars: Math.round(numberInRange(source.pinnedContextChars, defaultAgentSettings.pinnedContextChars, 2000, 100000)),
    temperature: numberInRange(source.temperature, defaultAgentSettings.temperature, 0, 2),
    responseStyle: ["concise", "balanced", "detailed"].includes(source.responseStyle ?? "") ? source.responseStyle! : defaultAgentSettings.responseStyle,
    citationMode: ["required", "preferred", "off"].includes(source.citationMode ?? "") ? source.citationMode! : defaultAgentSettings.citationMode,
    customInstructions: typeof source.customInstructions === "string" ? source.customInstructions.slice(0, 4000) : "",
    knowledgeToolsEnabled: typeof source.knowledgeToolsEnabled === "boolean" ? source.knowledgeToolsEnabled : true,
    memoryEnabled: typeof source.memoryEnabled === "boolean" ? source.memoryEnabled : true,
    memoryIndexLimit: Math.round(numberInRange(source.memoryIndexLimit, defaultAgentSettings.memoryIndexLimit, 5, 100)),
    autoRemember: typeof source.autoRemember === "boolean" ? source.autoRemember : true,
    planningEnabled: typeof source.planningEnabled === "boolean" ? source.planningEnabled : true,
    defaultPinnedContextOnly: typeof source.defaultPinnedContextOnly === "boolean" ? source.defaultPinnedContextOnly : false,
  };
}

export function buildAgentPreferencePrompt(settings: AgentSettings): string {
  const style = {
    concise: "回答保持简洁，优先给出结论和必要依据。",
    balanced: "回答详略均衡，清楚说明结论、依据和待确认项。",
    detailed: "回答应较为完整，说明关键推理、影响和可执行建议。",
  }[settings.responseStyle];
  const citations = {
    required: "使用资料中的事实时必须标注来源标题；无法找到依据时明确说明。",
    preferred: "使用资料中的事实时尽量标注来源标题。",
    off: "不强制在最终回答中标注来源标题。",
  }[settings.citationMode];
  return ["## 用户配置", style, citations, settings.customInstructions.trim() ? `附加指令：\n${settings.customInstructions.trim()}` : ""].filter(Boolean).join("\n");
}
