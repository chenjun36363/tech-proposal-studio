# -*- coding: utf-8 -*-
"""One-shot MinerU import test for workspace/测试文档.docx"""
from __future__ import annotations

import json
import re
import sys
import time
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
import http.client
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(r"D:\nas\myproject\tech-proposal-studio\workspace")
SOURCE = ROOT / "测试文档.docx"
CONN = ROOT / ".gouan" / "connections.json"


def http_json(method: str, url: str, api_key: str, body: dict | None = None, timeout: int = 300):
    data = None
    headers = {
        "Accept": "*/*",
        "Authorization": f"Bearer {api_key}",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            status = resp.status
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"MinerU HTTP {e.code}: {raw}") from e
    except URLError as e:
        raise RuntimeError(f"MinerU 调用失败: {e}") from e
    if status < 200 or status >= 300:
        raise RuntimeError(f"MinerU HTTP {status}: {raw}")
    obj = json.loads(raw)
    if int(obj.get("code", 0) or 0) != 0:
        raise RuntimeError(f"MinerU 返回错误: {obj.get('msg', raw)}")
    return obj


def http_bytes(method: str, url: str, body: bytes | None = None, api_key: str | None = None, timeout: int = 300):
    """PUT/GET raw bytes. Avoid default form Content-Type — OSS pre-signed URLs reject it."""
    parsed = urlparse(url)
    conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    # Do NOT set Content-Type — MinerU OSS signature is computed without it (same as Java/reqwest raw body).
    if body is not None:
        headers["Content-Length"] = str(len(body))
    conn = conn_cls(parsed.hostname, parsed.port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        status = resp.status
        if status < 200 or status >= 300:
            raise RuntimeError(f"HTTP {status}: {data[:500]!r}")
        return status, data
    finally:
        conn.close()


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def strip_heading_prefix(title: str) -> str:
    title = re.sub(r"^第\s*\d+\s*章[\s、.．:：\-]*", "", title, flags=re.UNICODE)
    title = re.sub(r"^(?:\d+\.)+\d*[\s、.．:：\-]*", "", title, flags=re.UNICODE)
    title = re.sub(r"^\d+[\s、.．:：\-]+", "", title, flags=re.UNICODE)
    return title.strip()


def format_heading_prefix(level: int, counters: list[int]) -> str:
    safe = min(max(level, 1), 6)
    if safe == 1:
        return ""
    if safe == 2:
        return f"第{counters[0]}章"
    return ".".join(str(x) for x in counters[: safe - 1])


def renumber_headings(markdown: str) -> str:
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    counters = [0, 0, 0, 0, 0, 0]
    in_code = False
    for i, raw in enumerate(lines):
        if raw.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        m = HEADING_RE.match(raw)
        if not m:
            continue
        level = min(len(m.group(1)), 6)
        if level == 1:
            continue
        plain = strip_heading_prefix(m.group(2).strip()) or "未命名"
        counters[level - 2] += 1
        for j in range(level - 1, 6):
            counters[j] = 0
        if counters[0] == 0:
            counters[0] = 1
        prefix = format_heading_prefix(level, counters)
        hashes = "#" * level
        lines[i] = f"{hashes} {prefix} {plain}".rstrip() if prefix else f"{hashes} {plain}"
        if prefix:
            lines[i] = f"{hashes} {prefix} {plain}"
    return "\n".join(lines)


def rewrite_image_paths(markdown: str, asset_rel: str) -> str:
    asset = asset_rel.replace("\\", "/").strip("/")
    out = markdown.replace("](./images/", f"]({asset}/")
    out = out.replace("](images/", f"]({asset}/")
    out = out.replace("](./Images/", f"]({asset}/")
    out = out.replace("](Images/", f"]({asset}/")
    return out


def unique_md_name(source_name: str, existing: set[str]) -> str:
    stem = re.sub(r"\.(pdf|docx?)$", "", source_name, flags=re.I).strip() or "导入文档"
    safe = re.sub(r'[<>:"/\\|?*]', "_", stem) + ".md"
    used = {n.lower() for n in existing}
    if safe.lower() not in used:
        return safe
    base = safe[:-3]
    n = 1
    while True:
        cand = f"{base} ({n}).md"
        if cand.lower() not in used:
            return cand
        n += 1


def main() -> int:
    if not SOURCE.is_file():
        print(f"源文件不存在: {SOURCE}", file=sys.stderr)
        return 1
    if not CONN.is_file():
        print(f"缺少 connections: {CONN}", file=sys.stderr)
        return 1

    cfg_all = json.loads(CONN.read_text(encoding="utf-8"))
    mineru = cfg_all.get("mineru") or {}
    api_key = (mineru.get("apiKey") or "").strip()
    if not api_key:
        print("请先配置 MinerU API Key", file=sys.stderr)
        return 1

    base_url = (mineru.get("baseUrl") or "https://mineru.net").rstrip("/")
    model_version = mineru.get("modelVersion") or "vlm"
    language = mineru.get("language") or "ch"
    is_ocr = bool(mineru.get("isOcr", False))
    enable_table = bool(mineru.get("enableTable", True))
    enable_formula = bool(mineru.get("enableFormula", True))
    timeout = int(mineru.get("timeoutSeconds") or 300)
    poll = int(mineru.get("pollIntervalSeconds") or 3)

    file_name = SOURCE.name
    file_bytes = SOURCE.read_bytes()
    print(f"源文件: {SOURCE} ({len(file_bytes)} bytes)")
    print(f"MinerU: {base_url} model={model_version}")

    data_id = f"gouan-{uuid.uuid4()}"
    body = {
        "files": [{"name": file_name, "data_id": data_id, "is_ocr": is_ocr}],
        "model_version": model_version,
        "language": language,
        "enable_table": enable_table,
        "enable_formula": enable_formula,
    }
    print("1) 申请上传链接…")
    create = http_json("POST", f"{base_url}/api/v4/file-urls/batch", api_key, body, timeout)
    batch_id = ((create.get("data") or {}).get("batch_id")) or ""
    urls = ((create.get("data") or {}).get("file_urls")) or []
    upload_url = urls[0] if urls else ""
    if not batch_id or not upload_url:
        raise RuntimeError(f"MinerU 未返回上传链接: {create}")
    print(f"   batch_id={batch_id}")

    print("2) 上传文件…")
    status, _ = http_bytes("PUT", upload_url, file_bytes, timeout=timeout)
    if status < 200 or status >= 300:
        raise RuntimeError(f"MinerU 文件上传失败 HTTP {status}")
    print("   上传完成")

    print("3) 轮询解析结果…")
    deadline = time.time() + timeout
    item = None
    while time.time() < deadline:
        resp = http_json(
            "GET",
            f"{base_url}/api/v4/extract-results/batch/{batch_id}",
            api_key,
            None,
            timeout,
        )
        results = ((resp.get("data") or {}).get("extract_result")) or []
        item = results[0] if isinstance(results, list) and results else results
        state = str((item or {}).get("state") or "").lower()
        print(f"   state={state}")
        if state == "done":
            break
        if state == "failed":
            raise RuntimeError(f"MinerU 解析失败: {(item or {}).get('err_msg', '未知错误')}")
        time.sleep(poll)
    else:
        raise RuntimeError(f"MinerU 解析超时，最后状态: {item}")

    zip_url = (item or {}).get("full_zip_url") or ""
    if not zip_url:
        raise RuntimeError(f"MinerU 未返回解析结果压缩包: {item}")

    print("4) 下载并解压结果…")
    status, zip_bytes = http_bytes("GET", zip_url, timeout=timeout)
    if status < 200 or status >= 300:
        raise RuntimeError(f"MinerU 结果下载失败 HTTP {status}")

    markdown = None
    images: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace("\\", "/")
            lower = name.lower()
            data = zf.read(info)
            if lower.endswith("full.md"):
                markdown = data.decode("utf-8", errors="replace")
                continue
            is_image_path = "/images/" in lower or lower.startswith("images/")
            ext = Path(lower).suffix
            is_image_ext = ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
            if is_image_path or (is_image_ext and not lower.endswith(".md")):
                images.append((Path(name).name, data))

    if not markdown or not markdown.strip():
        raise RuntimeError("MinerU 返回的 Markdown 为空 / 未找到 full.md")

    asset_rel = None
    if images:
        stem = re.sub(r'[<>:"/\\|?*]', "_", SOURCE.stem).strip(" .") or "document"
        stem = stem[:80]
        asset_rel = f"assets/import-{stem}"
        dest = ROOT / "assets" / f"import-{stem}"
        dest.mkdir(parents=True, exist_ok=True)
        used: set[str] = set()
        for fname, data in images:
            final = fname
            key = final.lower()
            if key in used:
                p = Path(fname)
                n = 1
                while True:
                    cand = f"{p.stem}-{n}{p.suffix}"
                    if cand.lower() not in used:
                        final = cand
                        break
                    n += 1
            used.add(final.lower())
            (dest / final).write_bytes(data)
        markdown = rewrite_image_paths(markdown, asset_rel)
        print(f"   图片 {len(images)} 张 → {asset_rel}")

    print("5) 标题重编号并写入工作区…")
    markdown = renumber_headings(markdown)
    existing = {p.name for p in ROOT.glob("*.md")}
    out_name = unique_md_name(file_name, existing)
    out_path = ROOT / out_name
    out_path.write_text(markdown, encoding="utf-8")

    preview = "\n".join(markdown.splitlines()[:40])
    print(f"\n完成: {out_path}")
    print(f"字符数: {len(markdown)}, 图片目录: {asset_rel or '(无)'}")
    print("--- 预览前 40 行 ---")
    print(preview)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"导入失败: {e}", file=sys.stderr)
        raise
