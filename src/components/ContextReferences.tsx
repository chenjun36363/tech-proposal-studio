import type { ReactNode } from "react";
import { BookOpen } from "lucide-react";

export function ContextReferences({ labels, footer }: { labels: string[]; footer?: ReactNode }) {
  return <section className="agent-context-references" aria-label="已引用资料">
    <header><span><BookOpen size={13} />已引用资料</span><b>{labels.length} 条</b></header>
    {labels.length > 0
      ? <div>{labels.slice(0, 3).map((label, index) => <span key={`${index}-${label}`} title={label}>{label}</span>)}{labels.length > 3 && <em>另有 {labels.length - 3} 条</em>}</div>
      : <p>尚未加入引用资料</p>}
    {footer}
  </section>;
}
