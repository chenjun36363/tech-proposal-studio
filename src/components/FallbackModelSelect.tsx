import { useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, CircleX, Layers, LoaderCircle, Plus, TestTube, X } from "lucide-react";
import type { LlmProvider, SelectedModel } from "../core/types";
import { ModelSelect } from "./ModelSelect";

export type ModelTestResult = { status: "success" | "error"; message: string };

function labelOf(providers: LlmProvider[], selection: SelectedModel): string {
  const provider = providers.find(item => item.id === selection.providerId);
  return provider ? `${provider.name} / ${selection.model}` : selection.model;
}

function sameModel(a: SelectedModel, b: SelectedModel): boolean {
  return a.providerId === b.providerId && a.model === b.model;
}

function modelKey(selection: SelectedModel): string {
  return `${selection.providerId}::${selection.model}`;
}

export function FallbackModelSelect({
  providers,
  value,
  onChange,
  disabled,
  max = 3,
  exclude,
  id,
  onTest,
  testingKey,
  testResult,
}: {
  providers: LlmProvider[];
  value: SelectedModel[];
  onChange: (next: SelectedModel[]) => void;
  disabled?: boolean;
  max?: number;
  /** 主模型，避免被重复选为备用。 */
  exclude?: SelectedModel | null;
  id?: string;
  onTest?: (selection: SelectedModel) => void;
  testingKey?: string | null;
  testResult?: (selection: SelectedModel) => ModelTestResult | undefined;
}) {
  const [adding, setAdding] = useState<SelectedModel | null>(null);

  const add = (selection: SelectedModel | null) => {
    setAdding(null);
    if (!selection) return;
    if (exclude && sameModel(selection, exclude)) return;
    if (value.some(item => sameModel(item, selection))) return;
    if (value.length >= max) return;
    onChange([...value, selection]);
  };

  const removeAt = (index: number) => onChange(value.filter((_, i) => i !== index));
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const canAdd = !disabled && value.length < max;

  return (
    <div className="fallback-model-select" id={id}>
      <div className="fallback-model-select-head">
        <span><Layers size={13} />备用模型（按顺序，主模型失败时自动切换）</span>
        {value.length > 0 && <em>{value.length}/{max}</em>}
      </div>
      {value.length === 0 ? (
        <small className="fallback-model-empty">未配置备用模型；主模型失败时将直接报错。</small>
      ) : (
        <ul className="fallback-model-list">
          {value.map((item, index) => {
            const key = modelKey(item);
            const result = testResult?.(item);
            const testing = testingKey === key;
            return (
              <li key={key} className="fallback-model-item">
                <span className="fallback-model-order">{index + 1}</span>
                <span className="fallback-model-detail">
                  <span className="fallback-model-name">{labelOf(providers, item)}</span>
                  {result && <small className={`model-test-status ${result.status}`}>
                    {result.status === "success" ? <CheckCircle2 size={12} /> : <CircleX size={12} />}
                    {result.message}
                  </small>}
                </span>
                <span className="fallback-model-actions">
                  {onTest && <button type="button" title={testing ? "测试中…" : "测试模型"} aria-label={`测试${labelOf(providers, item)}`} disabled={disabled || testingKey != null} onClick={() => onTest(item)}>
                    {testing ? <LoaderCircle size={12} className="model-test-spinning" /> : <TestTube size={12} />}
                  </button>}
                  <button type="button" title="上移" disabled={disabled || testingKey != null || index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
                  <button type="button" title="下移" disabled={disabled || testingKey != null || index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
                  <button type="button" title="移除" disabled={disabled || testingKey != null} onClick={() => removeAt(index)}><X size={12} /></button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {canAdd && (
        <div className="fallback-model-add">
          <ModelSelect providers={providers} value={null} onChange={add} disabled={disabled} placeholder="添加备用模型…" />
          {adding && <Plus size={13} />}
        </div>
      )}
    </div>
  );
}
