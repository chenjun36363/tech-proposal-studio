# 项目长期记忆（tech-proposal-studio）

## 模型选择器约定
- `src/components/ModelSelect.tsx` 是 Agent/AI tab 与设置页「默认模型」共用的模型选择器，已升级为可搜索 combobox（模糊搜索覆盖 `catalog ∪ activeModels`）。
- 模糊匹配工具：`src/utils/fuzzy.ts`（`fuzzyScore` 子序列打分，无第三方依赖）。
- `resolveActiveModelConfig` 的 requireActive 校验认可 `catalog` 中的模型（不仅是 activeModels）。
- 改动 ModelSelect / resolve 时，务必保持 `SelectedModel { providerId, model }` 的语义，三处调用点（AgentConversationPanel、AiRewritePanel、ModelSettingsSection）共用同一组件。
