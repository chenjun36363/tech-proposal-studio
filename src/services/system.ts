import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CommandPreset, CommandResult, Project } from "../types";
import { isDesktop } from "./runtime";

function commandPayload(preset: CommandPreset) {
  return {
    program: preset.program,
    args: preset.args,
    cwd: preset.cwd || ".",
    timeoutMs: preset.timeoutMs,
    allowShell: preset.allowShell,
    stdin: preset.stdin,
  };
}

export async function openExternalUrl(url: string): Promise<void> {
  const normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) throw new Error("仅允许打开 http/https 来源链接");
  if (isDesktop()) await invoke("open_external_url", { url: normalized });
  else window.open(normalized, "_blank", "noopener,noreferrer");
}

export async function saveMarkdown(project: Project, markdown: string): Promise<unknown> {
  if (isDesktop()) return invoke("save_markdown", { projectName: project.name, markdown });
  const blob = new Blob([markdown], { type: "text/markdown" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${project.name}.md`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export async function runCommand(preset: CommandPreset): Promise<CommandResult> {
  if (!isDesktop()) throw new Error("请在 Tauri 桌面端运行此任务");
  return invoke("run_command", { preset: commandPayload(preset) });
}

export async function runCommandStream(preset: CommandPreset, onUpdate: (channel: "stdout" | "stderr", content: string) => void): Promise<CommandResult> {
  if (!isDesktop()) throw new Error("请在 Tauri 桌面端运行此任务");
  const runId = crypto.randomUUID();
  const unlisten = await listen<{ runId: string; channel: "stdout" | "stderr"; content: string }>("session://command", event => {
    if (event.payload.runId === runId) onUpdate(event.payload.channel, event.payload.content);
  });
  try { return await invoke("run_command_stream", { runId, preset: commandPayload(preset) }); }
  finally { unlisten(); }
}

export async function detectTools(): Promise<Record<string, string>> {
  return isDesktop() ? invoke("detect_tools") : {};
}

export async function terminalOpen(cols: number, rows: number, cwd = "."): Promise<number> {
  if (!isDesktop()) throw new Error("请在 Tauri 桌面端使用终端");
  return invoke("terminal_open", { cols, rows, cwd });
}

export async function terminalWrite(id: number, data: string): Promise<void> {
  if (!isDesktop()) throw new Error("请在 Tauri 桌面端使用终端");
  await invoke("terminal_write", { id, data });
}

export async function terminalResize(id: number, cols: number, rows: number): Promise<void> {
  if (isDesktop()) await invoke("terminal_resize", { id, cols, rows });
}

export async function terminalClose(id: number): Promise<void> {
  if (isDesktop()) await invoke("terminal_close", { id });
}

export async function openWorkspacePowerShell(cwd: string, program?: string): Promise<void> {
  if (!isDesktop()) throw new Error("请在 Tauri 桌面端打开 PowerShell");
  await invoke("open_workspace_powershell", { cwd, program });
}
