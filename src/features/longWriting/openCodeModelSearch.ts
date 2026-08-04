import type { OpenCodeModelOption, OpenCodeModelRef } from "./opencodeService";

function isSelected(model: OpenCodeModelOption, selected: OpenCodeModelRef | null) {
  return model.providerId === selected?.providerId && model.modelId === selected.modelId;
}

export function filterOpenCodeModels(
  models: OpenCodeModelOption[],
  query: string,
  selected: OpenCodeModelRef | null,
): OpenCodeModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return models;

  const matches = models.filter(model =>
    [model.providerName, model.modelName, model.modelId]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
  const selectedModel = models.find(model => isSelected(model, selected));
  return selectedModel && !matches.some(model => isSelected(model, selected))
    ? [selectedModel, ...matches]
    : matches;
}
