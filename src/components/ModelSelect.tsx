import type { LlmProvider, SelectedModel } from "../types";
import { encodeModelValue, parseModelValue } from "../services/llm/resolve";

export function ModelSelect({
  providers,
  value,
  onChange,
  disabled,
  id,
}: {
  providers: LlmProvider[];
  value: SelectedModel | null;
  onChange: (next: SelectedModel | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const options = providers
    .filter(provider => provider.enabled)
    .flatMap(provider => (provider.activeModels.length ? provider.activeModels : []).map(model => ({
      provider,
      model,
      value: encodeModelValue(provider.id, model),
      label: `${provider.name} / ${model}`,
    })));

  const current = value ? encodeModelValue(value.providerId, value.model) : "";
  const valid = options.some(option => option.value === current);

  return (
    <select
      id={id}
      className="model-select"
      disabled={disabled || !options.length}
      value={valid ? current : ""}
      onChange={event => onChange(parseModelValue(event.target.value))}
    >
      {!options.length && <option value="">暂无可用模型</option>}
      {options.length > 0 && !valid && <option value="">选择模型…</option>}
      {providers.filter(p => p.enabled && p.activeModels.length).map(provider => (
        <optgroup label={`${provider.name} · ${provider.protocol}`} key={provider.id}>
          {provider.activeModels.map(model => (
            <option value={encodeModelValue(provider.id, model)} key={`${provider.id}::${model}`}>
              {model}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
