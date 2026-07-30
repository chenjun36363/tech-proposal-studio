import type { DiffCell, TextDiff } from "./textDiff";

function DiffLine({ value }: { value: DiffCell }) {
  return <div className={`agent-review-diff-line ${value.kind}`} role="row">
    <span className="line-number" aria-hidden="true">{value.lineNumber ?? ""}</span>
    <code>{value.segments.map((segment, index) => segment.changed
      ? <mark key={index}>{segment.text || " "}</mark>
      : <span key={index}>{segment.text}</span>)}{value.segments.every(segment => !segment.text) ? " " : null}</code>
  </div>;
}

export function MarkdownDiffPane({ diff, side }: { diff: TextDiff; side: "original" | "revised" }) {
  return <div className="agent-review-diff" role="table" aria-label={side === "original" ? "原稿差异" : "修订稿差异"}>
    {diff.rows.map((row, index) => <DiffLine key={index} value={row[side]} />)}
  </div>;
}
