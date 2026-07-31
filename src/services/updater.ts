import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./runtime";

export interface AppUpdateStatus {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string;
  date?: string;
  body?: string;
  message?: string;
}

export async function checkForAppUpdate(): Promise<AppUpdateStatus> {
  if (!isDesktop()) {
    return { configured: false, available: false, currentVersion: "browser", message: "在线升级仅在桌面应用中可用。" };
  }
  return invoke<AppUpdateStatus>("app_update_check");
}

export async function installAppUpdate(): Promise<void> {
  if (!isDesktop()) throw new Error("在线升级仅在桌面应用中可用。");
  await invoke("app_update_install");
}
