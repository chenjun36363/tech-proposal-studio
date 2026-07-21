import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, terminalClose, terminalOpen, terminalResize, terminalWrite } from "./services";

/**
 * Single-session terminal. PTY starts on first `active=true` and stays until unmount or cwd change.
 * Keep the component mounted across tab switches (hide with CSS, do not unmount).
 */
export function PowerShellTerminal({ active, cwd = "." }: { active: boolean; cwd?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const unlistenersRef = useRef<UnlistenFn[]>([]);
  const [status, setStatus] = useState("未连接");
  const [error, setError] = useState("");

  const fitNow = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      const sid = idRef.current;
      if (sid != null) void terminalResize(sid, term.cols, term.rows);
    } catch {
      /* layout not ready */
    }
  };

  // Create xterm once per cwd; do not open PTY until first activation.
  useEffect(() => {
    if (!isDesktop() || !hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      theme: {
        background: "#1b221e",
        foreground: "#e7eee8",
        cursor: "#7ac9a7",
        selectionBackground: "#2f5c48",
      },
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    startedRef.current = false;
    idRef.current = null;
    setStatus("待连接");
    setError("");

    const onWinResize = () => fitNow();
    window.addEventListener("resize", onWinResize);

    return () => {
      window.removeEventListener("resize", onWinResize);
      for (const off of unlistenersRef.current) void off();
      unlistenersRef.current = [];
      const sid = idRef.current;
      idRef.current = null;
      startedRef.current = false;
      if (sid != null) void terminalClose(sid);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // Start / refit when tab becomes active
  useEffect(() => {
    if (!active || !isDesktop()) return;
    const term = termRef.current;
    if (!term) return;

    let cancelled = false;

    const boot = async () => {
      // ensure measurable size before fit/open
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      fitNow();

      if (startedRef.current || idRef.current != null) {
        fitNow();
        term.focus();
        return;
      }

      startedRef.current = true;
      try {
        setStatus("连接中…");
        const cols = Math.max(term.cols || 80, 40);
        const rows = Math.max(term.rows || 24, 12);
        const id = await terminalOpen(cols, rows, cwd);
        if (cancelled) {
          await terminalClose(id).catch(() => undefined);
          return;
        }
        idRef.current = id;
        setStatus(`PowerShell #${id}`);
        setError("");

        unlistenersRef.current.push(
          await listen<{ id: number; data: string }>("terminal://data", (event) => {
            if (event.payload.id !== idRef.current) return;
            termRef.current?.write(event.payload.data);
          }),
        );
        unlistenersRef.current.push(
          await listen<{ id: number; code?: number | null }>("terminal://exit", (event) => {
            if (event.payload.id !== idRef.current) return;
            setStatus(`已退出${event.payload.code != null ? ` (${event.payload.code})` : ""}`);
            idRef.current = null;
            startedRef.current = false;
          }),
        );

        term.onData((data) => {
          const sid = idRef.current;
          if (sid == null) return;
          terminalWrite(sid, data).catch((e) => setError(String(e)));
        });

        fitNow();
        term.focus();
      } catch (e: any) {
        startedRef.current = false;
        setError(e?.message ?? String(e));
        setStatus("连接失败");
        term.writeln(`\r\n\x1b[31m${e?.message ?? e}\x1b[0m`);
      }
    };

    void boot();

    const t1 = window.setTimeout(fitNow, 50);
    const t2 = window.setTimeout(fitNow, 250);
    const host = hostRef.current;
    let ro: ResizeObserver | undefined;
    if (host && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => fitNow());
      ro.observe(host);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cwd]);

  if (!isDesktop()) {
    return <p className="muted">内置 PowerShell 终端仅在 Tauri 桌面端可用。可在此直接运行 claude / codex / opencode。</p>;
  }

  return (
    <div className={`terminal-shell docked ${active ? "is-active" : "is-idle"}`} aria-hidden={!active}>
      <div className="terminal-bar">
        <span>{status}</span>
        {error && <em>{error}</em>}
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
