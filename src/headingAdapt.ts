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

const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
const numberedPattern = /^(?:第\s*[0-9一二三四五六七八九十百零〇两]+\s*章|(?:[0-9一二三四五六七八九十百零〇两]+[.．、])+(?:[0-9]+)?)/u;

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
    const rejected = /^(?:[-+*]\s|\d+[.)、]\s|>|\||!\[|<)/u.test(trimmed);
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
