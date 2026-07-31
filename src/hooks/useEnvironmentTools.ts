import { useEffect, useState } from "react";
import { buildAgentInstallCommand, type AgentTool, type AgentToolId } from "../agent/presets";
import { detectTools, runCommand } from "../services/system";
import type { CommandPreset, CommandResult } from "../core/types";

type CommandOutcome = CommandResult | { error: string };

export interface EnvironmentToolsController {
  toolPaths: Record<string, string>;
  commandOutputs: Record<string, CommandOutcome>;
  runningId: string | null;
  installingAgentId: AgentToolId | null;
  installOutputs: Partial<Record<AgentToolId, CommandOutcome>>;
  installAgent: (tool: AgentTool) => Promise<void>;
  runTask: (command: CommandPreset) => Promise<void>;
}

interface UseEnvironmentToolsOptions {
  desktop: boolean;
  notify: (message: string) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}

export function useEnvironmentTools({ desktop, notify }: UseEnvironmentToolsOptions): EnvironmentToolsController {
  const [toolPaths, setToolPaths] = useState<Record<string, string>>({});
  const [commandOutputs, setCommandOutputs] = useState<Record<string, CommandOutcome>>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [installingAgentId, setInstallingAgentId] = useState<AgentToolId | null>(null);
  const [installOutputs, setInstallOutputs] = useState<Partial<Record<AgentToolId, CommandOutcome>>>({});

  useEffect(() => {
    if (!desktop) return;
    detectTools().then(setToolPaths).catch(() => setToolPaths({}));
  }, [desktop]);

  const installAgent = async (tool: AgentTool) => {
    if (!desktop) {
      notify("请在 Tauri 桌面端安装 CLI 工具");
      return;
    }

    setInstallingAgentId(tool.id);
    setInstallOutputs(current => ({ ...current, [tool.id]: undefined }));
    try {
      const result = await runCommand(buildAgentInstallCommand(tool));
      setInstallOutputs(current => ({ ...current, [tool.id]: result }));
      if (result.exitCode !== 0) {
        notify(`${tool.name} 安装失败，退出码 ${result.exitCode}`);
        return;
      }
      setToolPaths(await detectTools());
      notify(`${tool.name} 已安装`);
    } catch (error) {
      const message = errorMessage(error, "安装失败");
      setInstallOutputs(current => ({ ...current, [tool.id]: { error: message } }));
      notify(message);
    } finally {
      setInstallingAgentId(null);
    }
  };

  const runTask = async (command: CommandPreset) => {
    if (!desktop) {
      notify("请在 Tauri 桌面端运行此任务");
      return;
    }

    setRunningId(command.id);
    try {
      const result = await runCommand(command);
      setCommandOutputs(current => ({ ...current, [command.id]: result }));
      notify(result.exitCode === 0 ? `${command.name} 完成` : `${command.name} 退出码 ${result.exitCode}`);
    } catch (error) {
      const message = errorMessage(error, "任务执行失败");
      setCommandOutputs(current => ({ ...current, [command.id]: { error: message } }));
      notify(message);
    } finally {
      setRunningId(null);
    }
  };

  return { toolPaths, commandOutputs, runningId, installingAgentId, installOutputs, installAgent, runTask };
}
