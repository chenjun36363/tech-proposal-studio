import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentDraftReviewModal } from "./AgentDraftReviewModal";

describe("AgentDraftReviewModal", () => {
  it("renders original and revised content with review actions", () => {
    const html = renderToStaticMarkup(<AgentDraftReviewModal
      draft={{ callId: "call-1", before: "优化前正文", after: "优化后正文", instruction: "补全技术约束" }}
      close={vi.fn()}
      reject={vi.fn()}
      accept={vi.fn()}
    />);
    expect(html).toContain("优化前正文");
    expect(html).toContain("优化后正文");
    expect(html).toContain("同步滚动");
    expect(html).toContain("拒绝修改");
    expect(html).toContain("接受并插入");
  });
});

