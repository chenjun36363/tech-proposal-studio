// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "../../core/data";
import type { Project } from "../../core/types";
import { ToolSettingsSection } from "./ToolSettingsSection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ initial }: { initial: Project }) {
  const [draft, setDraft] = useState(initial);
  return <ToolSettingsSection draft={draft} setDraft={setDraft} />;
}

describe("ToolSettingsSection category permissions", () => {
  let container: HTMLDivElement | null = null;

  afterEach(() => { container?.remove(); container = null; });

  it("shows partial selection and toggles all tools in one category", () => {
    const project = createProject();
    project.agent.disabledTools = ["git_push"];
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<Harness initial={project} />));

    const group = container.querySelector<HTMLInputElement>('input[aria-label="Git 变更全部权限"]')!;
    expect(group.checked).toBe(false);
    expect(group.indeterminate).toBe(true);

    act(() => group.click());
    expect(group.checked).toBe(true);
    expect(group.indeterminate).toBe(false);
    const gitPush = container.querySelector<HTMLInputElement>('input[role="switch"]')?.closest(".tool-settings-list");
    expect(gitPush).not.toBeNull();

    act(() => group.click());
    expect(group.checked).toBe(false);
    const section = group.closest(".tool-settings-group")!;
    expect(Array.from(section.querySelectorAll<HTMLInputElement>('input[role="switch"]')).every(input => !input.checked)).toBe(true);
    act(() => root.unmount());
  });

  it("renders the refined categories in a stable order", () => {
    container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<Harness initial={createProject()} />));
    const labels = Array.from(container.querySelectorAll(".tool-group-toggle b")).map(node => node.textContent);
    expect(labels).toEqual(["规划与协作", "技能", "方案读取", "方案编辑", "知识库", "长期记忆", "联网访问", "工作区文档", "Git 读取", "Git 变更", "系统访问"]);
    act(() => root.unmount());
  });
});
