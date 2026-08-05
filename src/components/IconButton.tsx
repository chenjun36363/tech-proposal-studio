import type { ReactNode } from "react";

export function IconButton({ title, children, onClick, active = false, disabled = false, className = "" }: {
  title: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return <button className={`icon-button ${active ? "active" : ""} ${className}`.trim()} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>;
}
