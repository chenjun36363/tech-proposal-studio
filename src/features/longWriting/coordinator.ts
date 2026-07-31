export type PoolJobState = "queued" | "running" | "validating" | "committing" | "completed" | "retryable" | "failed" | "cancelled";

export interface PoolJob<T> {
  id: string;
  order: number;
  value: T;
  attempts?: number;
}

export interface PoolProgress<T, R> {
  job: PoolJob<T>;
  state: PoolJobState;
  attempt: number;
  result?: R;
  error?: string;
}

export interface ChapterPoolOptions<T, R, C> {
  concurrency: number;
  signal?: AbortSignal;
  maxAttempts?: number;
  baseRetryMs?: number;
  isPaused?: () => boolean;
  onProgress?: (progress: PoolProgress<T, R>) => void;
  run: (job: PoolJob<T>, signal: AbortSignal) => Promise<R>;
  validate: (job: PoolJob<T>, result: R) => Promise<void> | void;
  commit: (job: PoolJob<T>, result: R) => Promise<C>;
  retryable?: (error: unknown) => boolean;
}

export interface ChapterPoolResult<C> {
  completed: Map<string, C>;
  failed: Map<string, string>;
  cancelled: string[];
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
  const timer = globalThis.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    globalThis.clearTimeout(timer);
    reject(new DOMException("Aborted", "AbortError"));
  }, { once: true });
});

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaultRetryable = (error: unknown) => /429|rate|timeout|timed out|temporar|网络|超时|限流/i.test(errorText(error));

/**
 * Bounded worker pool with a single serialized commit lane. Jobs may finish generation out of
 * outline order, but only one validated result can touch disk at a time.
 */
export async function runChapterWorkerPool<T, R, C>(
  jobs: PoolJob<T>[],
  options: ChapterPoolOptions<T, R, C>,
): Promise<ChapterPoolResult<C>> {
  const concurrency = Math.max(1, Math.min(3, Math.floor(options.concurrency || 1)));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryable = options.retryable ?? defaultRetryable;
  const controller = new AbortController();
  const signal = controller.signal;
  const externalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", externalAbort, { once: true });

  const queue = [...jobs].sort((a, b) => a.order - b.order);
  const activeOrders = new Set<number>();
  const completed = new Map<string, C>();
  const failed = new Map<string, string>();
  const cancelled: string[] = [];
  let commitLane: Promise<void> = Promise.resolve();

  const takeNext = () => {
    const nonAdjacent = queue.findIndex(job => !activeOrders.has(job.order - 1) && !activeOrders.has(job.order + 1));
    const index = nonAdjacent >= 0 ? nonAdjacent : 0;
    return queue.splice(index, 1)[0];
  };

  const waitWhilePaused = async () => {
    while (!signal.aborted && options.isPaused?.()) await sleep(100, signal);
  };

  const processJob = async (job: PoolJob<T>) => {
    activeOrders.add(job.order);
    let attempt = job.attempts ?? 0;
    try {
      while (!signal.aborted && attempt < maxAttempts) {
        await waitWhilePaused();
        attempt += 1;
        options.onProgress?.({ job, state: "running", attempt });
        try {
          const result = await options.run(job, signal);
          options.onProgress?.({ job, state: "validating", attempt, result });
          await options.validate(job, result);
          commitLane = commitLane.then(async () => {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            await waitWhilePaused();
            options.onProgress?.({ job, state: "committing", attempt, result });
            const committed = await options.commit(job, result);
            completed.set(job.id, committed);
            options.onProgress?.({ job, state: "completed", attempt, result });
          });
          await commitLane;
          return;
        } catch (error) {
          if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            cancelled.push(job.id);
            options.onProgress?.({ job, state: "cancelled", attempt, error: "已取消" });
            return;
          }
          const message = errorText(error);
          if (attempt < maxAttempts && retryable(error)) {
            options.onProgress?.({ job, state: "retryable", attempt, error: message });
            await sleep((options.baseRetryMs ?? 700) * (2 ** (attempt - 1)), signal);
            continue;
          }
          failed.set(job.id, message);
          options.onProgress?.({ job, state: "failed", attempt, error: message });
          return;
        }
      }
    } finally {
      activeOrders.delete(job.order);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !signal.aborted) {
      const job = takeNext();
      if (!job) break;
      await processJob(job);
    }
  });
  await Promise.all(workers);
  if (signal.aborted) {
    for (const job of queue) {
      cancelled.push(job.id);
      options.onProgress?.({ job, state: "cancelled", attempt: job.attempts ?? 0, error: "已取消" });
    }
  }
  options.signal?.removeEventListener("abort", externalAbort);
  return { completed, failed, cancelled };
}
