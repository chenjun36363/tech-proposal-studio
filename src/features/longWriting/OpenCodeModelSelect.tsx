import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { filterOpenCodeModels } from "./openCodeModelSearch";
import type { OpenCodeModelOption, OpenCodeModelRef } from "./opencodeService";

function sameModel(left: OpenCodeModelRef | null, right: OpenCodeModelRef) {
  return left?.providerId === right.providerId && left.modelId === right.modelId;
}

export function OpenCodeModelSelect({ models, value, onChange, disabled, placeholder = "选择已连接模型…" }: {
  models: OpenCodeModelOption[];
  value: OpenCodeModelRef | null;
  onChange: (value: OpenCodeModelRef | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = models.find(model => sameModel(value, model));
  const visible = useMemo(() => filterOpenCodeModels(models, query, value), [models, query, value]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  const select = (model: OpenCodeModelOption) => {
    onChange({ providerId: model.providerId, modelId: model.modelId });
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(index => visible.length ? (index + 1) % visible.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(index => visible.length ? (index - 1 + visible.length) % visible.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visible[highlight]) select(visible[highlight]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  if (disabled || !models.length) {
    return <select className="model-select" disabled value=""><option value="">{current ? `${current.providerName} / ${current.modelName}` : placeholder}</option></select>;
  }

  return <div className="model-combobox" ref={rootRef}>
    <button type="button" className="model-combobox-trigger" onClick={() => setOpen(value => !value)} aria-haspopup="listbox" aria-expanded={open}>
      <span className={current ? "model-combobox-value" : "model-combobox-value placeholder"}>
        {current ? `${current.providerName} / ${current.modelName}` : placeholder}
      </span>
      <ChevronDown size={14} className="model-combobox-caret" />
    </button>
    {open && <div className="model-combobox-panel" role="listbox">
      <div className="model-combobox-search">
        <Search size={13} />
        <input ref={inputRef} className="model-combobox-input" type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="搜索供应商、模型名称或 ID" aria-label="搜索 OpenCode 模型" />
      </div>
      <div className="model-combobox-list">
        {!visible.length && <div className="model-combobox-empty">没有匹配的模型</div>}
        {visible.map((model, index) => {
          const selected = sameModel(value, model);
          return <button type="button" role="option" aria-selected={selected} key={`${model.providerId}/${model.modelId}`} className={`model-combobox-option${index === highlight ? " highlight" : ""}${selected ? " selected" : ""}`} onMouseEnter={() => setHighlight(index)} onClick={() => select(model)}>
            <span className="model-combobox-option-name">{model.modelName}{model.isDefault ? "（默认）" : ""}</span>
            <span className="model-combobox-option-meta">{model.providerName} · {model.modelId}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
