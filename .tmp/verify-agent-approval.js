async (page) => {
  await page.evaluate(() => {
    const panel = document.querySelector('.proposal-agent-panel');
    if (!panel) throw new Error('Agent panel missing');
    let timeline = panel.querySelector('.agent-timeline');
    if (!timeline) {
      timeline = panel.querySelector('.agent-empty');
      if (!timeline) throw new Error('Agent timeline missing');
      timeline.className = 'agent-timeline';
    }
    timeline.innerHTML = Array.from({ length: 18 }, (_, index) =>
      `<article class="agent-tool-card done"><i>✓</i><div><b>执行步骤 ${index + 1}</b><span>这是一条较长的 Agent 工具执行结果</span></div></article>`,
    ).join('');
    const draft = document.createElement('section');
    draft.className = 'agent-draft';
    draft.innerHTML = `<header><div><span>章节修改待确认</span></div><small>补全功能描述、核心字段和业务流程</small></header>
      <div class="agent-diff-stats"><span class="removed">原文 198 字</span><span class="added">修改后 2,557 字</span></div>
      <details open><summary>查看完整修改稿</summary><pre>${'修改稿正文内容。'.repeat(500)}</pre></details>
      <div><button type="button">拒绝</button><button type="button" class="primary">接受修改</button></div>`;
    panel.appendChild(draft);
  });
  const button = page.getByRole('button', { name: '接受修改' });
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  return { visible: await button.isVisible(), box, viewport, insideViewport: Boolean(box && viewport && box.y >= 0 && box.y + box.height <= viewport.height) };
}
