import { diffArrays, diffChars } from "diff";

export type DiffSegment = { text: string; changed: boolean };
export type DiffCell = { lineNumber: number | null; kind: "context" | "add" | "delete" | "placeholder"; segments: DiffSegment[] };
export type DiffRow = { original: DiffCell; revised: DiffCell };
export type TextDiff = { rows: DiffRow[]; addedLines: number; deletedLines: number; unchanged: boolean };

const cell = (lineNumber: number | null, kind: DiffCell["kind"], text = "", segments?: DiffSegment[]): DiffCell => ({
  lineNumber,
  kind,
  segments: segments ?? [{ text, changed: false }],
});

function textLines(value: string) {
  if (!value) return [];
  return value.split("\n");
}

function changedSegments(original: string, revised: string) {
  const changes = diffChars(original, revised);
  return {
    original: changes.filter(change => !change.added).map(change => ({ text: change.value, changed: Boolean(change.removed) })),
    revised: changes.filter(change => !change.removed).map(change => ({ text: change.value, changed: Boolean(change.added) })),
  };
}

export function buildTextDiff(original: string, revised: string): TextDiff {
  if (original === revised) {
    let line = 0;
    const rows = textLines(original).map(text => {
      line += 1;
      return { original: cell(line, "context", text), revised: cell(line, "context", text) };
    });
    return { rows, addedLines: 0, deletedLines: 0, unchanged: true };
  }

  const changes = diffArrays(textLines(original), textLines(revised));
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let addedLines = 0;
  let deletedLines = 0;

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      for (const text of change.value) {
        rows.push({ original: cell(oldLine++, "context", text), revised: cell(newLine++, "context", text) });
      }
      continue;
    }

    const removed = change.removed ? change.value : [];
    const next = changes[index + 1];
    const added = change.removed && next?.added ? next.value : change.added ? change.value : [];
    if (change.removed && next?.added) index += 1;

    const count = Math.max(removed.length, added.length);
    for (let offset = 0; offset < count; offset += 1) {
      const oldText = removed[offset];
      const newText = added[offset];
      const inline = oldText !== undefined && newText !== undefined ? changedSegments(oldText, newText) : null;
      rows.push({
        original: oldText === undefined ? cell(null, "placeholder") : cell(oldLine++, "delete", oldText, inline?.original),
        revised: newText === undefined ? cell(null, "placeholder") : cell(newLine++, "add", newText, inline?.revised),
      });
    }
    deletedLines += removed.length;
    addedLines += added.length;
  }

  return { rows, addedLines, deletedLines, unchanged: false };
}
