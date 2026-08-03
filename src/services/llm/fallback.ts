import type { ResolvedModelConfig } from "../../core/types";

/** True when the error is a user/abort cancellation rather than a model failure. */
export function isAbortErrorLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断模型错误是否应通过切换到备用模型来恢复。
 *
 * 只覆盖“模型/网关不可用”这一类硬失败：
 * - 认证缺失或无效（auth_unavailable / no auth available / 401 / 403 鉴权类）
 * - 本地或远程网关不可达（failed to fetch / connection refused / 网络错误 / 503）
 * - 限流冷却（429 / rate limit / cooling down / 额度 / quota）
 *
 * 明确不覆盖：
 * - 用户取消（AbortError）
 * - 上下文超限（换模型通常仍超限，且浪费额度）
 * - 结构化输出无效（模型层已做两次重试，切模型收益低）
 * 这些由各自的调用方决定如何处理。
 */
export function isFallbackableModelError(error: unknown): boolean {
  if (isAbortErrorLike(error)) return false;
  const message = errorMessageOf(error);
  return /auth_unavailable|no auth available|authentication failed|invalid_api_key|api[ _-]?key|鉴权|认证失败|401|403|unauthor/i.test(message)
    || /error sending request|failed to fetch|connection (?:refused|reset|closed)|connect(?:ion)?[ _-]?(?:失败|拒绝|重置|关闭)|网络|network|unreachable|不可达|服务不可用|service unavailable|\b503\b|网关|gateway/i.test(message)
    || /\b429\b|rate[ _-]?limit|限流|cooling down|冷却|额度|quota|余额/i.test(message);
}

export interface FallbackRunOptions {
  signal?: AbortSignal;
  /** Called after a candidate fails and before switching to the next model. */
  onSwitch?: (failedIndex: number, from: ResolvedModelConfig, to: ResolvedModelConfig, reason: string) => void;
}

/**
 * Run `run` against an ordered model chain. Tries the primary first; on a
 * fallbackable error (auth/network/503/429) it switches to the next candidate
 * and resets. Non-fallbackable errors and user aborts rethrow immediately.
 */
export async function runWithModelFallback<T>(
  chain: ResolvedModelConfig[],
  run: (config: ResolvedModelConfig, index: number) => Promise<T>,
  options?: FallbackRunOptions,
): Promise<T> {
  if (!chain.length) throw new Error("没有可用的模型（主模型或备用模型）");
  let lastError: unknown;
  for (let i = 0; i < chain.length; i += 1) {
    const config = chain[i];
    try {
      return await run(config, i);
    } catch (error) {
      if (isAbortErrorLike(error)) throw error;
      lastError = error;
      if (i < chain.length - 1 && isFallbackableModelError(error)) {
        options?.onSwitch?.(i, config, chain[i + 1], errorMessageOf(error));
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("所有候选模型均失败");
}
