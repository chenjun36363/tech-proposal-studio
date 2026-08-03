import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export function ApiKeyField({
  value,
  onChange,
  placeholder,
  id,
  autoComplete = "off",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="api-key-field">
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
      />
      <button
        type="button"
        className="api-key-toggle"
        title={visible ? "隐藏密钥" : "显示密钥"}
        aria-label={visible ? "隐藏密钥" : "显示密钥"}
        onClick={() => setVisible(v => !v)}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
