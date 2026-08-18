import { Command, Download, X } from "lucide-react";
import { agentTools } from "../../agent/presets";
import { IconButton } from "../../components/IconButton";
import type { EnvironmentToolsController } from "../../hooks/useEnvironmentTools";
import type { Project } from "../../core/types";

interface EnvironmentModalProps {
  project: Project;
  controller: EnvironmentToolsController;
  close: () => void;
}

export function EnvironmentModal({ project, controller, close }: EnvironmentModalProps) {
  const { toolPaths, commandOutputs, runningId, installingAgentId, installOutputs, installAgent, runTask } = controller;

  return <div className="modal-backdrop environment-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal env-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title">
        <div><Command size={18} /><span>环境检查</span></div>
        <IconButton title="关闭" onClick={close}><X size={17} /></IconButton>
      </div>
      <div className="env-modal-body">
        <div className="agent-title"><Download size={15} />本地 Agent</div>
        <div className="installer-list">
          {agentTools.map(tool => {
            const installed = Boolean(toolPaths[tool.program]);
            const output = installOutputs[tool.id];
            const installing = installingAgentId === tool.id;
            return <div className={`installer-item ${installed ? "ready" : "missing"}`} key={tool.id}>
              <div className="installer-status"><span /><b>{tool.name}</b><em>{installed ? "已安装" : "未检测"}</em></div>
              <code title={installed ? toolPaths[tool.program] : undefined}>{installed ? toolPaths[tool.program] : `npm i -g ${tool.installPackage}`}</code>
              <button type="button" onClick={() => void installAgent(tool)} disabled={Boolean(installingAgentId)}>{installing ? "安装中…" : installed ? "更新" : "一键安装"}</button>
              {output && !("error" in output) && <pre className={`command-output ${output.exitCode === 0 ? "" : "error"}`}>{(output.stdout || output.stderr || `exit ${output.exitCode}`).trim()}</pre>}
              {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
            </div>;
          })}
        </div>
        <div className="agent-title"><Command size={15} />环境命令</div>
        {project.commands.length === 0 && <p className="muted">暂无环境检查任务</p>}
        {project.commands.map(command => {
          const output = commandOutputs[command.id];
          return <div className="command-item" key={command.id}><Command size={16} /><div><b>{command.name}{toolPaths[command.program] ? "" : " · 未检测"}</b><code>{command.program} {command.args.join(" ")}</code>
            {output && !("error" in output) && <pre className="command-output">exit {output.exitCode} · {output.durationMs}ms{"\n"}{(output.stdout || output.stderr || "(无输出)").trim()}</pre>}
            {output && "error" in output && <pre className="command-output error">{output.error}</pre>}
          </div><button onClick={() => void runTask(command)} disabled={runningId === command.id}>{runningId === command.id ? "运行中…" : "运行"}</button></div>;
        })}
      </div>
    </div>
  </div>;
}
