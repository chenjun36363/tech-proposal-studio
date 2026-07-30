import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./runtime";

export interface PrivilegedFileRequest {
  operation: "stat" | "list" | "read_text" | "write_text" | "create_directory" | "copy" | "move" | "rename" | "delete";
  path: string;
  destination?: string;
  content?: string;
  deleteMode?: "trash" | "permanent";
}

export interface PrivilegedFileResult {
  operation: string;
  path: string;
  destination?: string;
  kind?: string;
  size?: number;
  entries?: Array<{ name: string; path: string; kind: string; size: number }>;
  content?: string;
}

export interface PrivilegedPowerShellResult { runId: string; exitCode: number; logPath: string; outputTail: string; }

function requireDesktop() {
  if (!isDesktop()) throw new Error("系统级 Agent 工具仅在桌面端可用");
}

export async function privilegedFileOperation(request: PrivilegedFileRequest): Promise<PrivilegedFileResult> {
  requireDesktop();
  return invoke("privileged_file_operation", { request });
}

export async function runPrivilegedPowerShell(script: string, cwd: string | undefined, signal: AbortSignal): Promise<PrivilegedPowerShellResult> {
  requireDesktop();
  const runId = crypto.randomUUID();
  const cancel = () => { void invoke("privileged_cancel_powershell", { runId }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await invoke("privileged_run_powershell", { runId, script, cwd: cwd || null });
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
