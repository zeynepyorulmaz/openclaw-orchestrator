import { getConfig } from "../config.js";

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const cfg = getConfig().retry;
  const maxAttempts = opts?.maxAttempts ?? cfg.maxAttempts;
  const baseDelayMs = opts?.baseDelayMs ?? cfg.baseDelayMs;
  const maxDelayMs = opts?.maxDelayMs ?? cfg.maxDelayMs;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
