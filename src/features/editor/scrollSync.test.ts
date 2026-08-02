import { describe, expect, it } from "vitest";
import { applyScrollRatio, scrollRatio } from "./scrollSync";

function makeEl(overrides: Partial<{ scrollTop: number; scrollHeight: number; clientHeight: number }> = {}): HTMLElement {
  return { scrollTop: 0, scrollHeight: 0, clientHeight: 0, ...overrides } as HTMLElement;
}

describe("scrollRatio", () => {
  it("returns 0 when there is no scrollable space", () => {
    expect(scrollRatio(makeEl({ scrollHeight: 100, clientHeight: 100, scrollTop: 50 }))).toBe(0);
  });

  it("computes progress as scrollTop / max", () => {
    expect(scrollRatio(makeEl({ scrollHeight: 300, clientHeight: 100, scrollTop: 100 }))).toBe(0.5);
    expect(scrollRatio(makeEl({ scrollHeight: 300, clientHeight: 100, scrollTop: 0 }))).toBe(0);
    expect(scrollRatio(makeEl({ scrollHeight: 300, clientHeight: 100, scrollTop: 200 }))).toBe(1);
  });

  it("clamps out-of-range scrollTop to [0, 1]", () => {
    expect(scrollRatio(makeEl({ scrollHeight: 300, clientHeight: 100, scrollTop: -5 }))).toBe(0);
    expect(scrollRatio(makeEl({ scrollHeight: 300, clientHeight: 100, scrollTop: 999 }))).toBe(1);
  });
});

describe("applyScrollRatio", () => {
  it("sets scrollTop to ratio * max", () => {
    const el = makeEl({ scrollHeight: 300, clientHeight: 100 });
    applyScrollRatio(el, 0.5);
    expect(el.scrollTop).toBe(100);
  });

  it("no-ops when there is no scrollable space", () => {
    const el = makeEl({ scrollHeight: 100, clientHeight: 100 });
    applyScrollRatio(el, 0.5);
    expect(el.scrollTop).toBe(0);
  });
});
