import { useEffect, useState } from "react";
import type { AgentDraft, AgentEditorSelection } from "../agent/protocol";
import type { AgentSearchHighlight, AgentWorkspaceRuntime } from "../agent/proposalTools";
import type { DocumentBlock, Project } from "../core/types";
import { AgentConversationPanel } from "./AgentConversationPanel";
import {
  defaultCliAgentConnections,
  defaultCliAgentModels,
  inspectCliAgent,
  listCliAgentModels,
  normalizeCliAgentConnection,
  type CliAgentConnection,
  type CliAgentProvider,
  type CliAgentRuntimeStatus,
} from "../agent/cliAgentService";

const STORAGE_KEY = "tech-proposal-studio.cli-agent-connections.v1";

function readConnections(): Record<CliAgentProvider, CliAgentConnection> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<Record<CliAgentProvider, CliAgentConnection>> | null;
    return (Object.keys(defaultCliAgentConnections) as CliAgentProvider[]).reduce((result, provider) => {
      result[provider] = normalizeCliAgentConnection(provider, raw?.[provider]);
      return result;
    }, {} as Record<CliAgentProvider, CliAgentConnection>);
  } catch {
    return { ...defaultCliAgentConnections };
  }
}

export function CliAgentConversationPanel({
  project,
  block,
  pinnedContext,
  editorSelection,
  clearEditorSelection,
  applyDraft,
  workspaceRuntime,
  onDocumentSearch,
  notify,
}: {
  project: Project;
  block: DocumentBlock;
  pinnedContext: import("../agent/contextBuilder").ResolvedAgentContext[];
  editorSelection?: AgentEditorSelection;
  clearEditorSelection: () => void;
  applyDraft: (draft: AgentDraft) => void;
  workspaceRuntime?: AgentWorkspaceRuntime;
  onDocumentSearch?: (search: AgentSearchHighlight) => void;
  notify: (message: string) => void;
}) {
  const [connections, setConnections] = useState(readConnections);
  const [provider, setProvider] = useState<CliAgentProvider>("opencode");
  const [runtimeStatus, setRuntimeStatus] = useState<CliAgentRuntimeStatus>({ provider: "opencode", phase: "unknown" });
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [models, setModels] = useState(defaultCliAgentModels.opencode);
  const connection = connections[provider];

  const refreshRuntime = async () => {
    if (runtimeBusy) return;
    setRuntimeBusy(true);
    try {
      const status = await inspectCliAgent(connection);
      setRuntimeStatus(status);
      setModels(await listCliAgentModels(provider, project.workspace?.root || "."));
    } catch (error) {
      notify(error instanceof Error ? error.message : "本地 Agent 检测失败");
    } finally {
      setRuntimeBusy(false);
    }
  };


  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
  }, [connections]);

  useEffect(() => {
    setRuntimeStatus({ provider, phase: "unknown" });
    setModels(defaultCliAgentModels[provider]);
    void refreshRuntime();
    // 模式一不监听或管理 OpenCode Server；每次发送均由应用启动一次性 CLI。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const onConnectionChange = (next: CliAgentConnection) => {
    setConnections(current => {
      // 切换供应商时恢复该供应商自己的模型配置，避免把 OpenCode 的 provider/model
      // 或 Codex 的别名误传给另一个 CLI。
      const target = next.provider === provider
        ? next
        : current[next.provider] ?? defaultCliAgentConnections[next.provider];
      return { ...current, [next.provider]: normalizeCliAgentConnection(next.provider, target) };
    });
    if (next.provider !== provider) setProvider(next.provider);
  };

  return <AgentConversationPanel
    project={project}
    block={block}
    pinnedContext={pinnedContext}
    editorSelection={editorSelection}
    clearEditorSelection={clearEditorSelection}
    applyDraft={applyDraft}
    workspaceRuntime={workspaceRuntime}
    onDocumentSearch={onDocumentSearch}
    notify={notify}
    localAgent={{
      connection,
      onConnectionChange,
      models,
      runtimeStatus,
      runtimeBusy,
      onRefreshRuntime: () => void refreshRuntime(),
    }}
  />;
}
