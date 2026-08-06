import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "../services/runtime";

const BROWSER_KEY = "tech-proposal-studio.agent-tool-metrics.v1";

export type ToolQualityResultKind = "parse_failure" | "validation_failure" | "execution_success" | "execution_failure" | "circuit_breaker";
export interface ToolQualityMetricInput {
  protocol: string;
  model: string;
  toolName: string;
  resultKind: ToolQualityResultKind;
  errorCode?: string;
  round: number;
  repaired: boolean;
  durationMs: number;
}
export interface ToolQualityMetricRow extends ToolQualityMetricInput { day: string; roundBucket: string; durationBucket: string; count: number; }

function dayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function roundBucket(round: number) { return round <= 1 ? "1" : round === 2 ? "2" : round <= 5 ? "3-5" : "6+"; }
function durationBucket(durationMs: number) { return durationMs < 100 ? "<100ms" : durationMs < 500 ? "100-499ms" : durationMs < 2000 ? "500ms-2s" : durationMs < 10000 ? "2-10s" : "10s+"; }
function localRows(): ToolQualityMetricRow[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BROWSER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") as ToolQualityMetricRow[] : [];
  } catch { return []; }
}
function saveLocalRows(rows: ToolQualityMetricRow[]) { localStorage.setItem(BROWSER_KEY, JSON.stringify(rows)); }

/** Records aggregate-only metadata. Arguments, prompts, results, paths, and keys never enter this payload. */
export async function recordToolQualityMetric(metric: ToolQualityMetricInput): Promise<void> {
  const safe: ToolQualityMetricInput = {
    protocol: metric.protocol.slice(0, 80), model: metric.model.slice(0, 160), toolName: metric.toolName.slice(0, 120),
    resultKind: metric.resultKind, errorCode: metric.errorCode?.slice(0, 120), round: Math.max(1, Math.floor(metric.round)),
    repaired: metric.repaired === true, durationMs: Math.max(0, Math.floor(metric.durationMs)),
  };
  if (isDesktop()) {
    await invoke("record_agent_tool_quality_metric", { metric: safe });
    return;
  }
  const row: ToolQualityMetricRow = { ...safe, day: dayKey(), roundBucket: roundBucket(safe.round), durationBucket: durationBucket(safe.durationMs), count: 1 };
  const rows = localRows();
  const existing = rows.find(item => item.day === row.day && item.protocol === row.protocol && item.model === row.model
    && item.toolName === row.toolName && item.resultKind === row.resultKind && item.errorCode === row.errorCode
    && item.roundBucket === row.roundBucket && item.repaired === row.repaired && item.durationBucket === row.durationBucket);
  if (existing) existing.count += 1;
  else rows.push(row);
  saveLocalRows(rows.slice(-2000));
}

export async function listToolQualityMetrics(days = 30): Promise<ToolQualityMetricRow[]> {
  if (isDesktop()) return invoke("list_agent_tool_quality_metrics", { days });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - Math.max(1, Math.min(365, days)) + 1);
  const start = dayKey(cutoff);
  return localRows().filter(row => row.day >= start).sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count);
}

export async function clearToolQualityMetrics(): Promise<void> {
  if (isDesktop()) { await invoke("clear_agent_tool_quality_metrics"); return; }
  localStorage.removeItem(BROWSER_KEY);
}
