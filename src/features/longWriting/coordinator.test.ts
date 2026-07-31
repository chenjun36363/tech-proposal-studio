import { describe, expect, it, vi } from "vitest";
import { runChapterWorkerPool } from "./coordinator";

describe("runChapterWorkerPool", () => {
  it("bounds generation and serializes commits while allowing out-of-order completion", async () => {
    let active = 0;
    let maxActive = 0;
    let committing = 0;
    let maxCommitting = 0;
    const commitOrder: string[] = [];
    const jobs = [0, 1, 2, 3].map(order => ({ id: `c${order}`, order, value: order }));
    const result = await runChapterWorkerPool(jobs, {
      concurrency: 3,
      run: async job => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, (4 - job.order) * 4));
        active -= 1;
        return `draft-${job.order}`;
      },
      validate: () => undefined,
      commit: async job => {
        committing += 1;
        maxCommitting = Math.max(maxCommitting, committing);
        await new Promise(resolve => setTimeout(resolve, 2));
        commitOrder.push(job.id);
        committing -= 1;
        return job.id;
      },
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxCommitting).toBe(1);
    expect(result.completed.size).toBe(4);
    expect(commitOrder).not.toEqual(["c0", "c1", "c2", "c3"]);
  });

  it("retries transient errors", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("429 rate limit")).mockResolvedValue("ok");
    const result = await runChapterWorkerPool([{ id: "a", order: 0, value: 1 }], {
      concurrency: 1,
      baseRetryMs: 1,
      run,
      validate: () => undefined,
      commit: async () => "done",
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.completed.get("a")).toBe("done");
  });

  it("cancels queued work", async () => {
    const controller = new AbortController();
    const result = await runChapterWorkerPool([0, 1, 2].map(order => ({ id: `${order}`, order, value: order })), {
      concurrency: 1,
      signal: controller.signal,
      run: async job => {
        controller.abort();
        return job.value;
      },
      validate: () => undefined,
      commit: async value => value.id,
    });
    expect(result.cancelled.length).toBeGreaterThan(0);
  });
});
