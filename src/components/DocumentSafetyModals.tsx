import type { ConflictChoice, UnsafeDocumentAction } from "../hooks/useProposalFileActions";

type GuardChoice = "save" | "discard" | "cancel";

const copy: Record<UnsafeDocumentAction, { title: string; message: string; save: string; discard: string }> = {
  open: { title: "当前文档有未保存修改", message: "打开其他文档会替换编辑器中的当前内容。", save: "保存并打开", discard: "放弃并打开" },
  create: { title: "当前文档有未保存修改", message: "新建文档会离开当前文档。", save: "保存并新建", discard: "放弃并新建" },
  import: { title: "当前文档有未保存修改", message: "导入并打开文档会替换编辑器中的当前内容。", save: "保存并导入", discard: "放弃并导入" },
  reload: { title: "重新加载会覆盖未保存内容", message: "将从磁盘重新读取当前 Markdown，请先决定如何处理编辑器中的修改。", save: "保存后重新加载", discard: "放弃并重新加载" },
  workspace: { title: "切换工作区前请保存", message: "切换工作区会离开当前文档。", save: "保存并切换", discard: "放弃并切换" },
  delete: { title: "删除当前文档", message: "当前文档有未保存修改。可先另存副本，再删除原文件。", save: "另存副本后删除", discard: "放弃并删除" },
  close: { title: "关闭前请保存", message: "当前文档有未保存修改。请选择保存、明确放弃，或取消关闭。", save: "保存并关闭", discard: "放弃并关闭" },
  knowledge: { title: "转入知识库前请保存", message: "当前文档将离开编辑器并移动到知识库。", save: "保存并继续", discard: "放弃并继续" },
};

export function UnsavedChangesModal({ reason, choose }: { reason: UnsafeDocumentAction; choose: (choice: GuardChoice) => void }) {
  const text = copy[reason];
  return <div className="modal-backdrop document-safety-backdrop" role="presentation">
    <div className="modal document-safety-modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
      <h3 id="unsaved-title">{text.title}</h3>
      <p>{text.message}</p>
      <p className="muted">自动草稿不是磁盘保存；选择“取消”会原样保留当前编辑内容。</p>
      <div className="modal-actions three-actions">
        <button onClick={() => choose("cancel")}>取消</button>
        <button className="danger-ghost" onClick={() => choose("discard")}>{text.discard}</button>
        <button className="primary" autoFocus onClick={() => choose("save")}>{text.save}</button>
      </div>
    </div>
  </div>;
}

export function DiskConflictModal({ choose }: { choose: (choice: ConflictChoice) => void }) {
  return <div className="modal-backdrop document-safety-backdrop" role="presentation">
    <div className="modal document-safety-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <h3 id="conflict-title">磁盘文件已在外部修改</h3>
      <p>为避免覆盖外部编辑，构案已停止本次保存。请选择如何处理当前编辑内容。</p>
      <div className="conflict-options">
        <b>另存为</b><span>保留外部修改，把当前内容保存到新文件并切换到新文件。</span>
        <b>强制覆盖</b><span>明确用当前编辑内容覆盖磁盘上的外部修改。</span>
      </div>
      <div className="modal-actions three-actions">
        <button onClick={() => choose("cancel")}>取消</button>
        <button onClick={() => choose("saveAs")}>另存为</button>
        <button className="danger" onClick={() => choose("force")}>强制覆盖</button>
      </div>
    </div>
  </div>;
}
