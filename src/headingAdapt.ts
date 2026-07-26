import { renumberHeadings } from "./markdownDoc";

export interface HeadingAdaptCandidate {
  line: number;
  text: string;
  currentLevel: number | null;
  contextBefore: string;
  contextAfter: string;
}

export interface HeadingAdaptDecision {
  line: number;
  selected: boolean;
  level: number;
}

type UnknownRecord = Record<string, unknown>;

const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
const numberedPattern = /^(?:第\s*[0-9一二三四五六七八九十百零〇两]+\s*章|(?:[0-9一二三四五六七八九十百零〇两]+[.．、])+(?:[0-9]+)?)/u;
const metadataPattern = /^(?:(?:申报|编制|建设|承建|项目|报告)?(?:单位|日期|时间|负责人|联系人|地址)|(?:申报|编制)部门)[：:]/u;

function cleanCandidateText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:\*{1,3}|_{1,3}|~~)(.*?)(?:\*{1,3}|_{1,3}|~~)$/u, "$1")
    .trim();
}

export function collectHeadingAdaptCandidates(markdown: string): HeadingAdaptCandidate[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const result: HeadingAdaptCandidate[] = [];
  let inCode = false;

  const nearby = (from: number, direction: -1 | 1) => {
    for (let index = from + direction; index >= 0 && index < lines.length; index += direction) {
      const text = lines[index].trim();
      if (text) return text.slice(0, 120);
    }
    return "";
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCode = !inCode;
      return;
    }
    if (inCode || !trimmed) return;

    const heading = trimmed.match(headingPattern);
    const text = cleanCandidateText(trimmed);
    const isolated = (index === 0 || !lines[index - 1].trim()) && (index === lines.length - 1 || !lines[index + 1].trim());
    const formatted = /^(?:\*{1,3}|_{1,3}|~~).+(?:\*{1,3}|_{1,3}|~~)$/u.test(trimmed);
    const shortPlain = isolated && text.length <= 40 && !/[。；，,：:]$/u.test(text);
    const rejected = /^(?:[-+*]\s|\d+[.)、]\s|>|\||!\[|<)/u.test(trimmed) || metadataPattern.test(text);
    if (!heading && (rejected || text.length > 100 || !(numberedPattern.test(text) || formatted || shortPlain))) return;

    result.push({
      line: index,
      text,
      currentLevel: heading?.[1].length ?? null,
      contextBefore: nearby(index, -1),
      contextAfter: nearby(index, 1),
    });
  });
  return result;
}

export function applyHeadingAdaptDecisions(markdown: string, decisions: HeadingAdaptDecision[]): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const byLine = new Map(decisions.map(item => [item.line, item]));
  for (const [line, decision] of byLine) {
    if (line < 0 || line >= lines.length) continue;
    const body = lines[line].trim().replace(/^#{1,6}\s+/, "");
    if (decision.selected) {
      const level = Math.min(6, Math.max(1, Math.trunc(decision.level)));
      lines[line] = `${"#".repeat(level)} ${body}`;
    } else if (headingPattern.test(lines[line].trim())) {
      lines[line] = body;
    }
  }
  return renumberHeadings(lines.join("\n"));
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function jsonObjectCandidates(value: string): string[] {
  const result: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) result.push(value.slice(start, index + 1));
    }
  }
  return result.reverse();
}

/** Parse common model JSON variants while only accepting decisions for requested lines. */
export function parseHeadingAdaptResponse(raw: string, candidateLines: ReadonlySet<number>): HeadingAdaptDecision[] {
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const payloads = [normalized, ...jsonObjectCandidates(normalized)];
  for (const payload of payloads) {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { continue; }
    const record = asRecord(parsed);
    const items = Array.isArray(record?.decisions) ? record.decisions : Array.isArray(parsed) ? parsed : [];
    const decisions: HeadingAdaptDecision[] = [];
    const seen = new Set<number>();
    for (const item of items) {
      const decision = asRecord(item);
      if (!decision) continue;
      const line = typeof decision.line === "number" ? decision.line : Number(decision.line);
      const level = typeof decision.level === "number" ? decision.level : Number(decision.level);
      const selected = typeof decision.selected === "boolean"
        ? decision.selected
        : decision.selected === "true" ? true : decision.selected === "false" ? false : null;
      if (!Number.isInteger(line) || !candidateLines.has(line) || !Number.isFinite(level) || selected === null || seen.has(line)) continue;
      seen.add(line);
      decisions.push({ line, selected, level: Math.min(6, Math.max(1, Math.trunc(level))) });
    }
    if (decisions.length) return decisions;
  }
  return [];
}
