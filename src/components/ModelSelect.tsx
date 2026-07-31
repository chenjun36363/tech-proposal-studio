import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { LlmProvider, ModelOption, SelectedModel } from "../core/types";
import { fuzzyScore } from "../utils/fuzzy";

interface ModelEntry {
  providerId: string;
  providerName: string;
  protocol: string;
  model: string;
  displayName: string;
  ownedBy?: string;
}

function buildEntries(providers: LlmProvider[]): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const catalog: ModelOption[] = provider.catalog?.length
      ? provider.catalog
      : provider.activeModels.map(model => ({ id: model, displayName: model }));
    for (const item of catalog) {
      entries.push({
        providerId: provider.id,
        providerName: provider.name,
        protocol: provider.protocol,
        model: item.id,
        displayName: item.displayName || item.id,
        ownedBy: item.ownedBy,
      });
    }
  }
  return entries;
}

function searchText(entry: ModelEntry): string {
  return [entry.displayName, entry.model, entry.ownedBy ?? "", entry.providerName, entry.protocol]
    .filter(Boolean)
    .join(" ");
}

export function ModelSelect({
  providers,
  value,
  onChange,
  disabled,
  id,
  placeholder = "选择模型…",
}: {
  providers: LlmProvider[];
  value: SelectedModel | null;
  onChange: (next: SelectedModel | null) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  const allEntries = useMemo(() => buildEntries(providers), [providers]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const q = query.trim();
    if (!q) return allEntries;
    return allEntries
      .map(entry => ({ entry, score: fuzzyScore(q, searchText(entry)) }))
      .filter(result => result.score !== Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score)
      .map(result => result.entry);
  }, [allEntries, query]);

  const currentEntry = allEntries.find(
    entry => value?.providerId === entry.providerId && value?.model === entry.model,
  );

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onScroll = (event: Event) => {
      // Ignore scrolling inside the dropdown list itself (it has its own
      // overflow:auto). Only close when an ancestor container scrolls, which
      // would otherwise detach the floating list from its trigger.
      if (rootRef.current && rootRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    // Close while any ancestor scrolls so the floating list never detaches
    // from its trigger inside an overflow:auto container.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const select = (entry: ModelEntry) => {
    onChange({ providerId: entry.providerId, model: entry.model });
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(index => (visible.length ? (index + 1) % visible.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(index => (visible.length ? (index - 1 + visible.length) % visible.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = visible[highlight];
      if (entry) select(entry);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  if (disabled || allEntries.length === 0) {
    return (
      <select
        id={id}
        className="model-select"
        disabled
        value={currentEntry ? "selected" : ""}
      >
        <option value={currentEntry ? "selected" : ""}>
          {currentEntry
            ? `${currentEntry.providerName} / ${currentEntry.model}`
            : allEntries.length === 0 ? "暂无可用模型" : "选择模型…"}
        </option>
      </select>
    );
  }

  return (
    <div className="model-combobox" ref={rootRef}>
      <button
        type="button"
        id={id}
        className="model-combobox-trigger"
        onClick={() => setOpen(openValue => !openValue)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={currentEntry ? "model-combobox-value" : "model-combobox-value placeholder"}>
          {currentEntry ? `${currentEntry.providerName} / ${currentEntry.model}` : placeholder}
        </span>
        <ChevronDown size={14} className="model-combobox-caret" />
      </button>

      {open && (
        <div className="model-combobox-panel" role="listbox">
          <div className="model-combobox-search">
            <Search size={13} />
            <input
              ref={inputRef}
              className="model-combobox-input"
              type="text"
              value={query}
              placeholder="搜索模型 / 供应商…"
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="model-combobox-list">
            {visible.length === 0 && <div className="model-combobox-empty">无匹配的模型</div>}
            {visible.map((entry, index) => {
              const active = value?.providerId === entry.providerId && value?.model === entry.model;
              return (
                <button
                  type="button"
                  key={`${entry.providerId}::${entry.model}`}
                  role="option"
                  aria-selected={active}
                  className={`model-combobox-option${index === highlight ? " highlight" : ""}${active ? " selected" : ""}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => select(entry)}
                >
                  <span className="model-combobox-option-name">{entry.displayName}</span>
                  <span className="model-combobox-option-meta">
                    {entry.providerName}
                    {entry.ownedBy ? ` · ${entry.ownedBy}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
