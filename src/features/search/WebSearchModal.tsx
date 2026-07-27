import { useState } from "react";
import { ExternalLink, Globe2, Search, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { makeId } from "../../data";
import { importKnowledgeWeb } from "../../knowledge";
import { searchWeb } from "../../services/search";
import { openExternalUrl } from "../../services/system";
import type { Project, SearchResult } from "../../types";

type QuickLink = { id: string; title: string; url: string };

const QUICK_LINKS_KEY = "tech-proposal-studio.quicklinks.v1";
const DEFAULT_QUICK_LINKS: QuickLink[] = [
  { id: "mee-gov-cn", title: "生态环境部", url: "https://www.mee.gov.cn/" },
];

const loadQuickLinks = (): QuickLink[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUICK_LINKS_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed : DEFAULT_QUICK_LINKS;
  } catch {
    return DEFAULT_QUICK_LINKS;
  }
};

const saveQuickLinks = (links: QuickLink[]) => {
  try {
    localStorage.setItem(QUICK_LINKS_KEY, JSON.stringify(links));
  } catch {
    // Browser privacy settings may disable localStorage.
  }
};

export function WebSearchModal({
  project,
  notify,
  close,
}: {
  project: Project;
  notify: (message: string) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>(loadQuickLinks);
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLinkTitle, setNewLinkTitle] = useState("");
  const [newLinkUrl, setNewLinkUrl] = useState("");

  const persistQuickLinks = (next: QuickLink[]) => {
    setQuickLinks(next);
    saveQuickLinks(next);
  };

  const openUrl = async (url: string, fallback = "无法打开链接") => {
    try {
      await openExternalUrl(url);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : fallback);
    }
  };

  const addQuickLink = () => {
    const url = newLinkUrl.trim();
    const title = newLinkTitle.trim() || url;
    if (!url) return;
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (quickLinks.some(link => link.url === normalized)) {
      notify("该链接已在常用列表中");
      return;
    }
    persistQuickLinks([...quickLinks, { id: makeId(), title, url: normalized }]);
    setNewLinkTitle("");
    setNewLinkUrl("");
    setShowAddLink(false);
    notify("已添加到常用链接");
  };

  const runSearch = async () => {
    if (!query.trim()) return;
    if (!confirm(`即将向 ${project.search.provider} 发送查询：\n\n${query}`)) return;
    setSearching(true);
    setSearchAttempted(true);
    try {
      setResults(await searchWeb(query, project.search));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "联网搜索失败");
    } finally {
      setSearching(false);
    }
  };

  const saveToKnowledge = async (result: SearchResult) => {
    if (!project.workspace) {
      notify("请先配置工作目录");
      return;
    }
    setSaving(true);
    try {
      await importKnowledgeWeb(project.workspace, result.url);
      notify("网页全文已存入知识库");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "网页入库失败");
    } finally {
      setSaving(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={close}>
    <div className="modal wide web-search-modal" onMouseDown={event => event.stopPropagation()}>
      <div className="modal-title"><div><Globe2 size={19} /><span>联网搜索</span></div><IconButton title="关闭" onClick={close}><X size={18} /></IconButton></div>
      <div className="search-row">
        <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.key === "Enter" && void runSearch()} placeholder="联网搜索关键词" />
        <button onClick={() => void runSearch()}><Search size={16} /></button>
      </div>
      <section className="quick-links">
        <div className="quick-links-head">
          <span><Globe2 size={13} />常用链接</span>
          <button type="button" className="quick-link-add-btn" onClick={() => setShowAddLink(value => !value)}>{showAddLink ? "收起" : "添加"}</button>
        </div>
        <div className="quick-links-list">
          {quickLinks.map(link => {
            let host = link.url;
            try { host = new URL(link.url).hostname; } catch { /* keep raw URL */ }
            return <div key={link.id} className="quick-link-item" title={link.url}>
              <button type="button" className="quick-link-open" onClick={() => void openUrl(link.url)}><Globe2 size={13} /><span className="quick-link-title">{link.title}</span><span className="quick-link-host">{host}</span></button>
              <button type="button" className="quick-link-remove" title="移除" onClick={() => persistQuickLinks(quickLinks.filter(item => item.id !== link.id))}><X size={12} /></button>
            </div>;
          })}
          {!quickLinks.length && <p className="muted quick-links-empty">暂无常用链接，点击“添加”加入常用网站</p>}
        </div>
        {showAddLink && <div className="quick-link-form">
          <input value={newLinkTitle} onChange={event => setNewLinkTitle(event.target.value)} placeholder="名称（如 生态环境部）" />
          <input value={newLinkUrl} onChange={event => setNewLinkUrl(event.target.value)} onKeyDown={event => event.key === "Enter" && addQuickLink()} placeholder="网址 https://..." />
          <button type="button" className="primary" onClick={addQuickLink}>保存</button>
        </div>}
      </section>
      <div className="web-search-body">
        {searching && <div className="loading-line">正在联网检索…</div>}
        {!!results.length && <div className="source-list">
          {results.map(result => {
            let host = result.url;
            try { host = new URL(result.url).hostname; } catch { /* keep raw URL */ }
            return <article key={result.url}>
              <div><Globe2 size={15} /><span>{host}</span></div>
              <button type="button" className="result-title" onClick={() => void openUrl(result.url, "无法打开来源链接")}>{result.title}</button>
              <p>{result.excerpt}</p>
              <div className="source-item-actions">
                <button type="button" onClick={() => void openUrl(result.url, "无法打开来源链接")}><ExternalLink size={12} />打开网页</button>
                <button type="button" disabled={saving} onClick={() => void saveToKnowledge(result)}>存入知识库</button>
              </div>
            </article>;
          })}
        </div>}
        {!results.length && !searching && <p className="muted">{searchAttempted ? "搜索完成，没有返回结果（搜索引擎可能受限或超时）" : "输入关键词后按 Enter 或点击搜索图标"}</p>}
      </div>
    </div>
  </div>;
}
