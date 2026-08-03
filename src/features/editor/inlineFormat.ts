/**
 * 行内 Markdown 格式化（加粗/斜体/删除线/行内代码/高亮）的纯函数实现。
 * 抽离为纯函数便于单元测试，并由 App 的 wrapSelection 调用。
 *
 * 行为约定：
 * - 有选区：若选区已被相同标记包裹，则"取消"该格式（toggle off）；否则在两侧包裹标记。
 * - 无选区：插入 `before + placeholder + after`，并将选区落在 placeholder 上，便于直接输入覆盖。
 */

export interface InlineFormatResult {
  /** 应用后的完整文本 */
  text: string;
  /** 新的选区起点（相对整段文本） */
  selectionStart: number;
  /** 新的选区终点（相对整段文本） */
  selectionEnd: number;
}

function isAmbiguousMarker(selected: string, before: string, after: string): boolean {
  // 防止 `**x**` 被误判为斜体 `*`（或反之）而错误剥离。
  // 仅当标记字符后紧邻的字符与标记字符相同（说明是更长的标记）时，认为存在歧义。
  if (before.length > 0) {
    const afterMarker = selected[before.length];
    if (afterMarker === before[before.length - 1]) return true;
  }
  if (after.length > 0) {
    const beforeMarker = selected[selected.length - after.length - 1];
    if (beforeMarker === after[after.length - 1]) return true;
  }
  return false;
}

export function applyInlineFormat(
  value: string,
  selStart: number,
  selEnd: number,
  before: string,
  after: string = before,
  placeholder = "",
): InlineFormatResult {
  const selected = value.slice(selStart, selEnd);

  // 1) 切换：选区整体已被相同标记包裹 -> 取消格式
  if (
    selected.length >= before.length + after.length &&
    before.length + after.length > 0 &&
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    !isAmbiguousMarker(selected, before, after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    const text = value.slice(0, selStart) + inner + value.slice(selEnd);
    return { text, selectionStart: selStart, selectionEnd: selStart + inner.length };
  }

  // 2) 无选区：插入占位符并选中占位符
  if (selStart === selEnd) {
    const inserted = before + placeholder + after;
    const text = value.slice(0, selStart) + inserted + value.slice(selStart);
    const start = selStart + before.length;
    return { text, selectionStart: start, selectionEnd: start + placeholder.length };
  }

  // 3) 有选区：正常包裹
  const wrapped = before + selected + after;
  const text = value.slice(0, selStart) + wrapped + value.slice(selEnd);
  return {
    text,
    selectionStart: selStart + before.length,
    selectionEnd: selStart + before.length + selected.length,
  };
}
