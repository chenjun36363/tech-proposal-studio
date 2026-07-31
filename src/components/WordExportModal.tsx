import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, FileText, RefreshCw, X } from "lucide-react";
import type { Project } from "../core/types";
import {
  checkDocxImages,
  DEFAULT_DOCX_EXPORT_SETTINGS,
  downloadDocx,
  type DocxExportSettings,
  type DocxImageCheckResult,
} from "../features/export/docxExport";
import { IconButton } from "./IconButton";

const cloneDefaults = (): DocxExportSettings => ({
  ...DEFAULT_DOCX_EXPORT_SETTINGS,
  headingSizes: [...DEFAULT_DOCX_EXPORT_SETTINGS.headingSizes],
  headingBefore: [...DEFAULT_DOCX_EXPORT_SETTINGS.headingBefore],
  headingAfter: [...DEFAULT_DOCX_EXPORT_SETTINGS.headingAfter],
});

export function WordExportModal({ project, close, notify }: { project: Project; close: () => void; notify: (message: string) => void }) {
  const [settings, setSettings] = useState<DocxExportSettings>(cloneDefaults);
  const [check, setCheck] = useState<DocxImageCheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [exporting, setExporting] = useState(false);

  const runCheck = async () => {
    setChecking(true);
    try { setCheck(await checkDocxImages(project)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void runCheck(); }, [project.markdown, project.filePath, project.workspace?.root]);

  const setHeadingValue = (key: "headingSizes" | "headingBefore" | "headingAfter", index: number, value: number) => {
    setSettings(current => {
      const next = [...current[key]] as DocxExportSettings[typeof key];
      next[index] = value;
      return { ...current, [key]: next };
    });
  };

  const exportWord = async () => {
    setExporting(true);
    try {
      const path = await downloadDocx(project, settings);
      if (path) notify(`Word 已保存：${path}`);
      else if (path === undefined) notify("已取消导出");
      close();
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出 Word 失败");
      await runCheck();
    } finally { setExporting(false); }
  };

  const copyImageLink = async (source: string) => {
    try {
      await navigator.clipboard.writeText(source);
      notify("图片链接已复制");
    } catch {
      notify("复制图片链接失败");
    }
  };

  const blocked = checking || exporting || Boolean(check?.issues.length);
  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal word-export-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><FileText size={18} /><span>导出 Word</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      <div className="word-export-body">
        <section>
          <div className="word-export-section-title"><b>文档排版</b><span>当前导出规则已设为默认值</span></div>
          <div className="word-export-grid compact">
            <label>标题字体<input value={settings.headingFont} onChange={e => setSettings({ ...settings, headingFont: e.target.value })} /></label>
            <label>正文字体<input value={settings.bodyFont} onChange={e => setSettings({ ...settings, bodyFont: e.target.value })} /></label>
            <label>正文字号（pt）<input type="number" min="8" max="36" step="0.5" value={settings.bodySize} onChange={e => setSettings({ ...settings, bodySize: Number(e.target.value) })} /></label>
            <label>正文行距（倍）<input type="number" min="1" max="3" step="0.1" value={settings.lineSpacing} onChange={e => setSettings({ ...settings, lineSpacing: Number(e.target.value) })} /></label>
            <label>首行缩进（字符）<input type="number" min="0" max="8" step="0.5" value={settings.firstLineIndent} onChange={e => setSettings({ ...settings, firstLineIndent: Number(e.target.value) })} /></label>
            <label>图片最大宽度（px）<input type="number" min="120" max="1200" step="10" value={settings.maxImageWidth} onChange={e => setSettings({ ...settings, maxImageWidth: Number(e.target.value) })} /></label>
            <label>正文段前（pt）<input type="number" min="0" max="72" value={settings.bodyBefore} onChange={e => setSettings({ ...settings, bodyBefore: Number(e.target.value) })} /></label>
            <label>正文段后（pt）<input type="number" min="0" max="72" value={settings.bodyAfter} onChange={e => setSettings({ ...settings, bodyAfter: Number(e.target.value) })} /></label>
          </div>
          <div className="word-heading-table">
            <div><b>级别</b><b>字号（pt）</b><b>段前（pt）</b><b>段后（pt）</b></div>
            {settings.headingSizes.map((size, index) => <div key={index}>
              <span>标题 {index + 1}</span>
              <input type="number" min="8" max="48" step="0.5" value={size} onChange={e => setHeadingValue("headingSizes", index, Number(e.target.value))} />
              <input type="number" min="0" max="72" value={settings.headingBefore[index]} onChange={e => setHeadingValue("headingBefore", index, Number(e.target.value))} />
              <input type="number" min="0" max="72" value={settings.headingAfter[index]} onChange={e => setHeadingValue("headingAfter", index, Number(e.target.value))} />
            </div>)}
          </div>
        </section>
        <section>
          <div className="word-export-section-title"><b>图片链接检查</b><button type="button" title="重新检查图片" onClick={() => void runCheck()} disabled={checking}><RefreshCw size={14} />重新检查</button></div>
          <div className={`word-image-status ${check?.issues.length ? "error" : "ok"}`}>
            {checking ? <><RefreshCw className="spin" size={17} /><span>正在读取图片文件…</span></> : check?.issues.length ? <><AlertTriangle size={17} /><span>{check.ready}/{check.total} 张可嵌入，{check.issues.length} 个链接需要处理</span></> : <><Check size={17} /><span>{check?.total ? `${check.ready} 张图片均可嵌入` : "文档中没有图片链接"}</span></>}
          </div>
          {check?.issues.length ? <div className="word-image-issues">{check.issues.map((item, index) => <div key={`${item.source}-${index}`}>
            <code>{item.source}</code>
            <span>{item.message}</span>
            <IconButton title="复制图片链接" onClick={() => void copyImageLink(item.source)}><Copy size={14} /></IconButton>
          </div>)}</div> : null}
        </section>
      </div>
      <div className="modal-actions"><button onClick={close}>取消</button><button className="primary" disabled={blocked} onClick={() => void exportWord()}><FileText size={15} />{exporting ? "正在生成…" : "选择路径并导出"}</button></div>
    </div>
  </div>;
}
