import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop } from "./services/runtime";
import { terminalClose, terminalOpen, terminalResize, terminalWrite } from "./services/system";

export function PowerShellTerminal({ active, cwd = "." }: { active: boolean; cwd?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("已停止");
  const [error, setError] = useState("");

  const fitNow = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      const sid = idRef.current;
      if (sid != null) void terminalResize(sid, term.cols, term.rows);
    } catch { /* layout not ready */ }
  }, []);

  // init xterm once
  useEffect(() => {
    if (!isDesktop() || !hostRef.current) return;
    const host = hostRef.current;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      theme: { background: "#1b221e", foreground: "#e7eee8", cursor: "#7ac9a7", selectionBackground: "#2f5c48" },
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    setStatus("已停止");

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(host);
    const onResize = () => { try { fit.fit(); } catch {} };
    window.addEventListener("resize", onResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      for (const off of unlistenersRef.current) void off();
      unlistenersRef.current = [];
      const sid = idRef.current;
      idRef.current = null;
      if (sid != null) void terminalClose(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd]);

  // start PTY session
  const start = useCallback(async () => {
    const term = termRef.current;
    if (!term || !isDesktop() || idRef.current != null) return;

    try {
      setStatus("连接中…");
      setError("");

      await new Promise(r => requestAnimationFrame(r));
      fitNow();

      const cols = Math.max(term.cols || 80, 40);
      const rows = Math.max(term.rows || 24, 12);
      const id = await terminalOpen(cols, rows, cwd);
      idRef.current = id;
      setRunning(true);
      setStatus(`PowerShell #${id}`);

      // listen for PTY output
      unlistenersRef.current.push(
        await listen<{ id: number; data: string }>("terminal://data", (event) => {
          if (event.payload.id !== idRef.current) return;
          termRef.current?.write(event.payload.data);
        }),
      );
      // listen for PTY exit
      unlistenersRef.current.push(
        await listen<{ id: number; code?: number | null }>("terminal://exit", (event) => {
          if (event.payload.id !== idRef.current) return;
          setStatus(`已退出${event.payload.code != null ? ` (${event.payload.code})` : ""}`);
          idRef.current = null;
          setRunning(false);
        }),
      );

      // forward keyboard input to PTY
      term.onData((data) => {
        const sid = idRef.current;
        if (sid == null) return;
        terminalWrite(sid, data).catch((e) => setError(String(e)));
      });

      fitNow();
      term.focus();
    } catch (e: any) {
      setRunning(false);
      setError(e?.message ?? String(e));
      setStatus("连接失败");
      term.writeln(`\r\n\x1b[31m${e?.message ?? e}\x1b[0m`);
    }
  }, [cwd, fitNow]);

  // stop PTY session
  const stop = useCallback(async () => {
    const sid = idRef.current;
    if (sid == null) return;
    idRef.current = null;
    setRunning(false);
    setStatus("已停止");
    setError("");
    for (const off of unlistenersRef.current) void off();
    unlistenersRef.current = [];
    await terminalClose(sid).catch(() => undefined);
  }, []);

  // auto-start when tab becomes active
  useEffect(() => {
    if (active && !idRef.current && !running) {
      const t = setTimeout(() => void start(), 100);
      return () => clearTimeout(t);
    }
  }, [active, start, running]);

  // refit/focus when tab becomes active (already running)
  useEffect(() => {
    if (active && idRef.current != null) {
      requestAnimationFrame(() => {
        fitNow();
        termRef.current?.focus();
      });
    }
  }, [active, fitNow]);

  if (!isDesktop()) {
    return <p className="muted">内置 PowerShell 终端仅在 Tauri 桌面端可用。</p>;
  }

  return (
    <div className={`terminal-shell docked ${active ? "is-active" : "is-idle"}`}>
      <div className="terminal-bar">
        <span>{status}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {error && <em>{error}</em>}
          {!running ? (
            <button className="terminal-bar-btn" onClick={start}>启动</button>
          ) : (
            <button className="terminal-bar-btn" onClick={stop}>关闭</button>
          )}
        </span>
      </div>
      <div className="terminal-host" ref={hostRef} onClick={() => termRef.current?.focus()} />
    </div>
  );
}
