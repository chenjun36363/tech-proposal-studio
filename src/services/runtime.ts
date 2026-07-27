export function isDesktop(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
