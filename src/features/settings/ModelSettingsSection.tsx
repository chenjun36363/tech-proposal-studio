import { useEffect, useState } from "react";
import { CheckCircle2, CircleX, Globe2, LoaderCircle, Plus, RefreshCw, TestTube, Trash2, Pencil, Download, X } from "lucide-react";
import type { LlmProvider, LlmProtocol, ModelOption, Project, ReasoningEffort, SelectedModel } from "../../core/types";
import { listModels, testModel as testModelConnection } from "../../services/model";
import { LLM_PROTOCOL_LABELS, PROVIDER_PRESETS, createDefaultProvider } from "../../services/llm/defaults";
import { REASONING_EFFORT_LABELS } from "../../services/llm/thinking";
import { deriveModelSnapshot, encodeModelValue, parseModelValue, repairSelectionForProviders, resolveActiveModelConfig, resolvedFromLegacy } from "../../services/llm/resolve";
import type { ResolvedModelConfig } from "../../core/types";
import { ModelSelect } from "../../components/ModelSelect";
import { FallbackModelSelect, type ModelTestResult } from "../../components/FallbackModelSelect";
import { ApiKeyField } from "../../components/ApiKeyField";
import { ccSwitchItemKey, isCcSwitchItemImportable, isCcSwitchItemImported, listCcSwitchProviders, mergeCcSwitchProviders, type CcSwitchProviderItem } from "./ccswitchImport";
import { isDesktop } from "../../services/runtime";

function CcSwitchImportModal({ items, providers, databasePath, close, apply }: {
  items: CcSwitchProviderItem[]; providers: LlmProvider[]; databasePath: string | null; close: () => void; apply: (items: CcSwitchProviderItem[]) => void;
}) {
  const selectable = items.filter(item => isCcSwitchItemImportable(item) && !isCcSwitchItemImported(item, providers));
  const [selected, setSelected] = useState(() => new Set(selectable.map(ccSwitchItemKey)));
  const toggle = (item: CcSwitchProviderItem) => setSelected(current => { const next = new Set(current); const key = ccSwitchItemKey(item); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  return <div className="modal-backdrop ccswitch-import-backdrop" onMouseDown={close}>
    <div className="modal ccswitch-import-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><Download size={19} /><span>从 CCSwitch 导入</span></div><button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={close}><X size={18} /></button></div>
      <p className="muted">选择要加入当前工作区的模型供应商。已有同名、同协议和同地址的配置不会重复导入。</p>
      {databasePath && <p className="ccswitch-database-path" title={databasePath}>{databasePath}</p>}
      {!items.length ? <div className="ccswitch-empty">未发现可读取的 CCSwitch 供应商。</div> : <div className="ccswitch-provider-list">
        {items.map(item => { const imported = isCcSwitchItemImported(item, providers); const importable = isCcSwitchItemImportable(item); const disabled = imported || !importable; return <label className={disabled ? "disabled" : ""} key={ccSwitchItemKey(item)}>
          <input type="checkbox" disabled={disabled} checked={!disabled && selected.has(ccSwitchItemKey(item))} onChange={() => toggle(item)} />
          <span><b>{item.name}</b><small>{item.protocol} · {item.baseUrl || "未配置接口地址"}</small></span>
          <em>{imported ? "已导入" : !importable ? "缺少模型或连接凭据" : `${item.models.length} 个模型`}</em>
        </label>; })}
      </div>}
      <div className="modal-actions"><button type="button" onClick={close}>取消</button><button type="button" className="primary" disabled={!selected.size} onClick={() => apply(items.filter(item => selected.has(ccSwitchItemKey(item))))}>导入 {selected.size} 项</button></div>
    </div>
  </div>;
}

function providerToResolved(provider: LlmProvider, model = ""): ResolvedModelConfig {
  return {
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: model || provider.activeModels[0] || "",
    timeoutMs: provider.timeoutMs,
    headers: { ...provider.headers },
    enabled: provider.enabled,
    reasoningEffort: provider.reasoningEffort,
  };
}

function modelSelectionKey(selection: SelectedModel): string {
  return `${selection.providerId}::${selection.model}`;
}

export function HeaderRows({ headers, onChange }: {
  headers: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<Array<[string, string]>>(() => {
    const entries = Object.entries(headers);
    return entries.length ? entries : [["", ""]];
  });
  const commit = (nextRows: Array<[string, string]>) => {
    setRows(nextRows);
    const next: Record<string, string> = {};
    for (const [key, value] of nextRows) {
      if (key.trim()) next[key.trim()] = value;
    }
    onChange(next);
  };
  return <div className="provider-header-rows">
    {rows.map(([key, value], index) => (
      <div className="provider-header-row" key={index}>
        <input placeholder="Header" value={key} onChange={e => {
          const next: Array<[string, string]> = rows.map((row, i) => i === index ? [e.target.value, row[1]] : row);
          commit(next);
        }} />
        <input placeholder="Value" value={value} onChange={e => {
          const next: Array<[string, string]> = rows.map((row, i) => i === index ? [row[0], e.target.value] : row);
          commit(next);
        }} />
        <button type="button" onClick={() => commit(rows.filter((_, i) => i !== index) as Array<[string, string]>)}>删除</button>
      </div>
    ))}
    <button type="button" className="linkish" onClick={() => setRows(current => [...current, ["", ""]])}>添加请求头</button>
  </div>;
}

function ProviderEditModal({
  initial,
  onClose,
  onSave,
}: {
  initial: LlmProvider | null;
  onClose: () => void;
  onSave: (provider: LlmProvider) => void;
}) {
  const [draft, setDraft] = useState<LlmProvider>(() => initial ? structuredClone(initial) : createDefaultProvider());
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);

  useEffect(() => {
    setDraft(initial ? structuredClone(initial) : createDefaultProvider());
    setModelsError("");
    setManualModel("");
    setModelFilter("");
    setOnlyActive(false);
  }, [initial]);

  const applyPreset = (protocol: LlmProtocol) => {
    const preset = PROVIDER_PRESETS.find(item => item.protocol === protocol);
    setDraft(current => ({
      ...current,
      protocol,
      name: current.name.trim() && current.name !== createDefaultProvider().name ? current.name : (preset?.name ?? current.name),
      baseUrl: preset?.baseUrl ?? current.baseUrl,
    }));
  };

  const refreshModels = async () => {
    setModelsLoading(true);
    setModelsError("");
    try {
      const catalog = await listModels(providerToResolved(draft));
      setDraft(current => {
        // Keep previously enabled models that still exist; on first fetch only enable a small default set.
        const stillActive = current.activeModels.filter(id => catalog.some(item => item.id === id));
        const active = stillActive.length
          ? stillActive
          : catalog.slice(0, 8).map(item => item.id);
        const ensured = active.length ? active : (catalog[0] ? [catalog[0].id] : []);
        return { ...current, catalog, activeModels: ensured };
      });
      setOnlyActive(false);
    } catch (error: any) {
      setModelsError(error?.message ?? "获取模型列表失败");
    } finally {
      setModelsLoading(false);
    }
  };

  const toggleActive = (id: string) => {
    setDraft(current => ({
      ...current,
      activeModels: current.activeModels.includes(id)
        ? current.activeModels.filter(item => item !== id)
        : [...current.activeModels, id],
    }));
  };

  const addManual = () => {
    const id = manualModel.trim();
    if (!id) return;
    setDraft(current => {
      const catalog = current.catalog?.some(item => item.id === id)
        ? current.catalog
        : [...(current.catalog ?? []), { id, displayName: id }];
      const activeModels = current.activeModels.includes(id) ? current.activeModels : [...current.activeModels, id];
      return { ...current, catalog, activeModels };
    });
    setManualModel("");
  };

  const allModels = draft.catalog?.length
    ? draft.catalog
    : draft.activeModels.map(id => ({ id, displayName: id } as ModelOption));
  const query = modelFilter.trim().toLowerCase();
  const filteredModels = allModels
    .filter(item => {
      if (onlyActive && !draft.activeModels.includes(item.id)) return false;
      if (!query) return true;
      return item.id.toLowerCase().includes(query)
        || item.displayName.toLowerCase().includes(query)
        || (item.ownedBy?.toLowerCase().includes(query) ?? false);
    })
    .slice()
    .sort((a, b) => {
      const aOn = draft.activeModels.includes(a.id) ? 0 : 1;
      const bOn = draft.activeModels.includes(b.id) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return a.displayName.localeCompare(b.displayName, "zh");
    });
  const allFilteredSelected = filteredModels.length > 0 && filteredModels.every(item => draft.activeModels.includes(item.id));
  const activeInFilter = draft.activeModels.filter(id => filteredModels.some(m => m.id === id)).length;

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      // 取消选中当前筛选的所有模型
      const idsToRemove = new Set(filteredModels.map(m => m.id));
      setDraft(current => ({
        ...current,
        activeModels: current.activeModels.filter(id => !idsToRemove.has(id)),
      }));
    } else {
      // 选中当前筛选的所有模型
      const newIds = filteredModels.map(m => m.id);
      setDraft(current => ({
        ...current,
        activeModels: [...new Set([...current.activeModels, ...newIds])],
      }));
    }
  };

  return <div className="modal-backdrop provider-edit-backdrop" onMouseDown={onClose}>
    <div className="modal provider-edit-modal" onMouseDown={e => e.stopPropagation()}>
      <div className="modal-title"><div><Globe2 size={18} /><span>{initial ? "编辑供应商" : "新增供应商"}</span></div></div>
      <div className="form-grid">
        <label>名称<input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label>协议
          <select value={draft.protocol} onChange={e => applyPreset(e.target.value as LlmProtocol)}>
            {(Object.keys(LLM_PROTOCOL_LABELS) as LlmProtocol[]).map(protocol => (
              <option value={protocol} key={protocol}>{LLM_PROTOCOL_LABELS[protocol]}</option>
            ))}
          </select>
        </label>
        <label className="wide">API 地址<input value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
        <label className="wide">API Key<ApiKeyField value={draft.apiKey} onChange={v => setDraft({ ...draft, apiKey: v })} placeholder="写入工作区 .gouan/connections.json" /></label>
        <label>超时（ms）<input type="number" min={5000} step={1000} value={draft.timeoutMs} onChange={e => setDraft({ ...draft, timeoutMs: Number(e.target.value) || 60000 })} /></label>
        <label>思考等级
          <select value={draft.reasoningEffort ?? "off"} onChange={e => setDraft({ ...draft, reasoningEffort: e.target.value as ReasoningEffort })}>
            {(Object.keys(REASONING_EFFORT_LABELS) as ReasoningEffort[]).map(level => (
              <option value={level} key={level}>{REASONING_EFFORT_LABELS[level]}</option>
            ))}
          </select>
        </label>
        <label className="checkbox-inline"><span>启用</span><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /></label>
        <div className="wide">
          <div className="provider-subsection-title">自定义请求头</div>
          <HeaderRows headers={draft.headers} onChange={headers => setDraft({ ...draft, headers })} />
        </div>
        <div className="wide">
          <div className="provider-subsection-title">
            <span>可用模型</span>
            <button type="button" className="model-fetch-button" onClick={() => void refreshModels()} disabled={modelsLoading}>
              <RefreshCw size={13} className={modelsLoading ? "model-fetch-spinning" : undefined} />
              {modelsLoading ? "获取中…" : "从上游获取"}
            </button>
          </div>
          {modelsError && <span className="model-list-error">{modelsError}</span>}
          <div className="provider-model-manual">
            <input value={manualModel} onChange={e => setManualModel(e.target.value)} placeholder="手动添加模型 id" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManual(); } }} />
            <button type="button" onClick={addManual}>添加</button>
          </div>
          {allModels.length > 0 && (
            <div className="provider-model-filter">
              <input
                value={modelFilter}
                onChange={e => setModelFilter(e.target.value)}
                placeholder="筛选模型 id / 名称 / 提供方…"
                className="filter-input"
              />
              <button
                type="button"
                className={`filter-chip ${onlyActive ? "active" : ""}`}
                onClick={() => setOnlyActive(value => !value)}
              >
                仅已选
              </button>
              <button
                type="button"
                className="select-all-button"
                onClick={toggleSelectAll}
                disabled={filteredModels.length === 0}
              >
                {allFilteredSelected ? "取消全选" : "全选当前"}
              </button>
              <span className="model-count">
                已选 {draft.activeModels.length} · 当前 {activeInFilter}/{filteredModels.length}
              </span>
            </div>
          )}
          <div className="provider-model-list" role="listbox" aria-label="可用模型">
            {filteredModels.map(item => {
              const active = draft.activeModels.includes(item.id);
              const showId = item.displayName !== item.id;
              return (
                <label key={item.id} className={active ? "selected" : ""} title={item.id}>
                  <input type="checkbox" checked={active} onChange={() => toggleActive(item.id)} />
                  <span className="model-meta">
                    <span className="model-name">{item.displayName || item.id}</span>
                    {(showId || item.ownedBy) && (
                      <span className="model-sub">
                        {showId && <span className="model-id">{item.id}</span>}
                        {item.ownedBy && <span className="model-owner">{item.ownedBy}</span>}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            {!allModels.length && <p className="muted">从上游获取模型，或手动添加模型 id。</p>}
            {allModels.length > 0 && filteredModels.length === 0 && (
              <p className="muted">
                {onlyActive && !query ? "尚未勾选可用模型。" : `没有匹配「${modelFilter || "已选"}」的模型。`}
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="primary" onClick={() => onSave({
          ...draft,
          name: draft.name.trim() || LLM_PROTOCOL_LABELS[draft.protocol],
          baseUrl: draft.baseUrl.trim(),
          activeModels: draft.activeModels,
        })}>保存供应商</button>
      </div>
    </div>
  </div>;
}

export function ModelSettingsSection({
  draft,
  setDraft,
}: {
  draft: Project;
  setDraft: (next: Project | ((current: Project) => Project)) => void;
}) {
  const providers = draft.providers ?? [];
  const aiEnabled = draft.model?.enabled !== false;
  const [editing, setEditing] = useState<LlmProvider | null | undefined>(undefined);
  const [ccSwitchItems, setCcSwitchItems] = useState<CcSwitchProviderItem[] | null>(null);
  const [ccSwitchDatabase, setCcSwitchDatabase] = useState<string | null>(null);
  const [ccSwitchLoading, setCcSwitchLoading] = useState(false);
  const [ccSwitchError, setCcSwitchError] = useState("");
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ModelTestResult>>({});

  const clearModelTests = () => {
    setTestingModelKey(null);
    setTestResults({});
  };

  const commitProviders = (nextProviders: LlmProvider[], selectedModel?: SelectedModel | null) => {
    clearModelTests();
    setDraft(current => {
      const selected = selectedModel !== undefined
        ? selectedModel
        : repairSelectionForProviders(nextProviders, current.selectedModel);
      return {
        ...current,
        providers: nextProviders,
        selectedModel: selected,
        model: deriveModelSnapshot(nextProviders, selected, current.model),
      };
    });
  };

  const commitFallbackModels = (next: SelectedModel[]) => {
    clearModelTests();
    setDraft(current => ({ ...current, fallbackModels: next.length ? next : undefined }));
  };

  const testSelection = async (selection: SelectedModel) => {
    const key = modelSelectionKey(selection);
    clearModelTests();
    setTestingModelKey(key);
    try {
      const config = resolveActiveModelConfig(providers, selection, { requireActive: false, aiEnabled });
      const result = await testModelConnection(config);
      const preview = result.output.replace(/\s+/g, " ").trim();
      const displayed = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
      setTestResults(current => ({ ...current, [key]: { status: "success", message: `模型可用：${displayed}` } }));
    } catch (error) {
      setTestResults(current => ({
        ...current,
        [key]: { status: "error", message: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      setTestingModelKey(current => current === key ? null : current);
    }
  };

  const setAiEnabled = (enabled: boolean) => {
    clearModelTests();
    setDraft(current => ({
      ...current,
      model: { ...current.model, enabled },
    }));
  };

  const toggleProviderEnabled = (id: string, enabled: boolean) => {
    const next = providers.map(item => item.id === id ? { ...item, enabled } : item);
    const selected = repairSelectionForProviders(next, draft.selectedModel);
    commitProviders(next, selected);
  };

  const saveProvider = (provider: LlmProvider) => {
    const exists = providers.some(item => item.id === provider.id);
    const next = exists
      ? providers.map(item => item.id === provider.id ? provider : item)
      : [...providers, provider];
    const selected = repairSelectionForProviders(next, draft.selectedModel)
      ?? (provider.activeModels[0] ? { providerId: provider.id, model: provider.activeModels[0] } : null);
    commitProviders(next, selected);
    setEditing(undefined);
  };

  const removeProvider = (id: string) => {
    if (providers.length <= 1) return;
    const next = providers.filter(item => item.id !== id);
    const selected = repairSelectionForProviders(next, draft.selectedModel?.providerId === id ? null : draft.selectedModel);
    commitProviders(next, selected);
  };

  const openCcSwitchImport = async () => {
    setCcSwitchLoading(true); setCcSwitchError("");
    try {
      const response = await listCcSwitchProviders();
      setCcSwitchItems(response.providers); setCcSwitchDatabase(response.databasePath);
      if (!response.databasePath) setCcSwitchError(`未找到 CCSwitch 数据库。已检查：${response.checkedPaths.join("；")}`);
    } catch (error) { setCcSwitchError(error instanceof Error ? error.message : String(error)); }
    finally { setCcSwitchLoading(false); }
  };

  const importCcSwitch = (items: CcSwitchProviderItem[]) => {
    const merged = mergeCcSwitchProviders(providers, items);
    commitProviders(merged.providers); setCcSwitchItems(null);
    setCcSwitchError(merged.imported ? `已加入 ${merged.imported} 个供应商，请保存设置以生效。` : "没有可导入的新供应商。");
  };

  const enabledProviderCount = providers.filter(p => p.enabled).length;

  const defaultModelKey = draft.selectedModel ? modelSelectionKey(draft.selectedModel) : null;
  const defaultTestResult = defaultModelKey ? testResults[defaultModelKey] : undefined;

  return <div className="settings-section-content model-settings-section">
    <div className="notice">
      <Globe2 size={18} />
      <div>
        <b>{aiEnabled ? "联网模型已启用" : "联网模型已关闭"}</b>
        <span>
          总开关只控制是否允许调用 AI；各供应商可单独启用。连接保存在工作区 <code>.gouan/connections.json</code>。
          {enabledProviderCount === 0 ? " 当前没有启用的供应商。" : ` 已启用 ${enabledProviderCount} 个供应商。`}
        </span>
      </div>
      <input
        type="checkbox"
        title="启用联网模型"
        checked={aiEnabled}
        onChange={e => setAiEnabled(e.target.checked)}
      />
    </div>

    <div className="wide model-default-field">
      <div className="model-field-label">默认模型</div>
      <div className="model-test-row">
        <ModelSelect
          providers={providers}
          value={draft.selectedModel}
          onChange={selectedModel => commitProviders(providers, selectedModel)}
          disabled={!aiEnabled}
        />
        <button
          type="button"
          className="model-test-button"
          title="测试默认模型"
          aria-label="测试默认模型"
          disabled={!aiEnabled || !draft.selectedModel || testingModelKey !== null}
          onClick={() => { if (draft.selectedModel) void testSelection(draft.selectedModel); }}
        >
          {testingModelKey === defaultModelKey ? <LoaderCircle size={13} className="model-test-spinning" /> : <TestTube size={13} />}
          {testingModelKey === defaultModelKey ? "测试中…" : "测试"}
        </button>
      </div>
      {defaultTestResult && <div className={`model-test-status ${defaultTestResult.status}`} aria-live="polite">
        {defaultTestResult.status === "success" ? <CheckCircle2 size={13} /> : <CircleX size={13} />}
        <span>{defaultTestResult.message}</span>
      </div>}
      {!aiEnabled && <small className="model-list-hint">总开关关闭时仍可配置供应商，但不会发起模型请求。</small>}
      {aiEnabled && enabledProviderCount === 0 && <small className="model-list-error">请至少启用一个供应商。</small>}
    </div>

    <FallbackModelSelect
      providers={providers}
      value={draft.fallbackModels ?? []}
      onChange={commitFallbackModels}
      disabled={!aiEnabled}
      exclude={draft.selectedModel}
      onTest={selection => void testSelection(selection)}
      testingKey={testingModelKey}
      testResult={selection => testResults[modelSelectionKey(selection)]}
    />

    <div className="provider-list-header">
      <b>供应商</b>
      <span>{isDesktop() && <button type="button" className="ccswitch-import-button" disabled={ccSwitchLoading} onClick={() => void openCcSwitchImport()}><Download size={14} />{ccSwitchLoading ? "读取中…" : "从 CCSwitch 导入"}</button>}<button type="button" className="primary" onClick={() => setEditing(null)}><Plus size={14} />新增</button></span>
    </div>
    {ccSwitchError && <p className="model-list-hint ccswitch-import-status">{ccSwitchError}</p>}

    {!providers.length && <p className="muted">尚未配置供应商，点击「新增」添加。</p>}

    <div className="provider-list">
      {providers.map(provider => (
        <div className={`provider-row ${provider.enabled ? "" : "disabled"}`} key={provider.id}>
          <div className="provider-row-main">
            <b>{provider.name}</b>
            <span className="provider-protocol-badge">{LLM_PROTOCOL_LABELS[provider.protocol]}</span>
            {provider.reasoningEffort && provider.reasoningEffort !== "off" && (
              <span className="provider-effort-badge" title="思考等级">思考 · {REASONING_EFFORT_LABELS[provider.reasoningEffort]}</span>
            )}
            <small>{provider.baseUrl || "未填写地址"}</small>
            <em>{provider.activeModels.length} 个可用模型</em>
          </div>
          <div className="provider-row-actions">
            <label className="provider-enable" title={provider.enabled ? "禁用此供应商" : "启用此供应商"}>
              <input
                type="checkbox"
                checked={provider.enabled}
                onChange={e => toggleProviderEnabled(provider.id, e.target.checked)}
              />
            </label>
            <button type="button" title="编辑" onClick={() => setEditing(provider)}><Pencil size={14} /></button>
            <button type="button" title="删除" disabled={providers.length <= 1} onClick={() => removeProvider(provider.id)}><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
    </div>

    {editing !== undefined && (
      <ProviderEditModal
        initial={editing}
        onClose={() => setEditing(undefined)}
        onSave={saveProvider}
      />
    )}
    {ccSwitchItems !== null && <CcSwitchImportModal items={ccSwitchItems} providers={providers} databasePath={ccSwitchDatabase} close={() => setCcSwitchItems(null)} apply={importCcSwitch} />}
  </div>;
}

// keep tree-shaking happy for transitional helpers referenced by tests later
void encodeModelValue;
void parseModelValue;
void resolvedFromLegacy;
