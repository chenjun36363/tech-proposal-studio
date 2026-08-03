import { useRef, useState } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import type { WordExportPreferences } from "../../core/types";

const MAX_LOGO_BYTES = 1_500_000;

export function WordExportSettingsSection({ value, onChange }: {
  value: WordExportPreferences;
  onChange: (next: WordExportPreferences) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState("");
  const update = (key: keyof WordExportPreferences, nextValue: string | boolean) => {
    onChange({ ...value, [key]: nextValue });
  };

  const selectLogo = (file?: File) => {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Logo 文件不能超过 1.5 MB，请压缩后重试。");
      return;
    }
    setLogoError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") update("coverLogoDataUrl", reader.result);
    };
    reader.onerror = () => setLogoError("Logo 读取失败，请重新选择图片。");
    reader.readAsDataURL(file);
  };

  return <div className="settings-section-content word-export-settings">
    <div className="agent-title"><ImagePlus size={15} /><span>封面 Logo 与公司信息</span></div>
    <p className="muted">封面 Logo 位于右上角；标题下方的公司名称和联系方式右对齐。Logo 仅保存在当前设备的项目设置中，支持 PNG、JPG、GIF、BMP，最大 1.5 MB。</p>
    <div className="word-logo-control">
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/bmp" hidden onChange={event => {
        selectLogo(event.currentTarget.files?.[0]);
        event.currentTarget.value = "";
      }} />
      {value.coverLogoDataUrl ? <div className="word-logo-preview">
        <img src={value.coverLogoDataUrl} alt="封面 Logo 预览" />
        <div><b>已设置封面右上角 Logo</b><span>导出时会按比例缩放，最大宽度 180 px。</span></div>
        <button type="button" className="danger-ghost" onClick={() => update("coverLogoDataUrl", "")}><Trash2 size={14} />移除</button>
      </div> : <button type="button" className="word-logo-upload" onClick={() => inputRef.current?.click()}><ImagePlus size={16} />上传 Logo</button>}
      {value.coverLogoDataUrl && <button type="button" className="word-logo-change" onClick={() => inputRef.current?.click()}>更换 Logo</button>}
      {logoError && <p className="word-logo-error">{logoError}</p>}
    </div>

    <div className="word-export-subtitle">公司联系信息</div>
    <p className="muted">中文公司名固定采用黑体二号蓝色；英文公司名采用 Arial 小五蓝色；其余联系信息采用宋体小四黑色。</p>
    <div className="form-grid">
      <label className="wide">中文公司名称<input value={value.companyNameZh} onChange={e => update("companyNameZh", e.target.value)} /></label>
      <label className="wide">英文公司名称<input value={value.companyNameEn} onChange={e => update("companyNameEn", e.target.value)} /></label>
      <label className="wide">地址<input value={value.companyAddress} onChange={e => update("companyAddress", e.target.value)} /></label>
      <label>电话<input value={value.companyPhone} onChange={e => update("companyPhone", e.target.value)} /></label>
      <label>传真<input value={value.companyFax} onChange={e => update("companyFax", e.target.value)} /></label>
      <label>网址<input value={value.companyWebsite} onChange={e => update("companyWebsite", e.target.value)} /></label>
      <label>邮箱<input value={value.companyEmail} onChange={e => update("companyEmail", e.target.value)} /></label>
    </div>

    <div className="word-export-subtitle">页眉与页脚</div>
    <div className="form-grid">
      <label className="wide">页眉标题<input value={value.headerTitle} onChange={e => update("headerTitle", e.target.value)} placeholder="例如：项目名称技术方案" /></label>
      <label className="wide word-page-number-option"><input type="checkbox" checked={value.showFooterPageNumbers} onChange={e => update("showFooterPageNumbers", e.target.checked)} /><span>在右下页脚显示“第 X 页 / 共 Y 页”</span></label>
    </div>

  </div>;
}
