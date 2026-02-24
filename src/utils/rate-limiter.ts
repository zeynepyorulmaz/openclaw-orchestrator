import { getConfig } from "../config.js";
import { log } from "./logger.js";

export type RateLimiterOptions = {
  /** Maximum requests per window (default: 10) */
  maxRequests?: number;
  /** Window size in milliseconds (default: 1000ms = 1 second) */
  windowMs?: number;
  /** Whether to queue requests that exceed the limit (default: true) */
  queueExcess?: boolean;
  /** Maximum queue size (default: 100) */
  maxQueueSize?: number;
};

type QueuedRequest = {
  resolve: () => void;
  reject: (err: Error) => void;
  timestamp: number;
};

/**
 * Token bucket rate limiter with optional request queuing.
 * Prevents overwhelming agents or external APIs with too many concurrent requests.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private queue: QueuedRequest[] = [];
  private maxRequests: number;
  private windowMs: number;
  private queueExcess: boolean;
  private maxQueueSize: number;
  private processing = false;
  private stats = { allowed: 0, throttled: 0, queued: 0, rejected: 0 };

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRequests = opts.maxRequests ?? 10;
    this.windowMs = opts.windowMs ?? 1000;
    this.queueExcess = opts.queueExcess ?? true;
    this.maxQueueSize = opts.maxQueueSize ?? 100;
  }

  /**
   * Clean up old timestamps outside the current window.
   */
  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }

  /**
   * Check if a request can proceed immediately.
   */
  canProceed(): boolean {
    this.cleanup();
    return this.timestamps.length < this.maxRequests;
  }

  /**
   * Get remaining requests in the current window.
   */
  remaining(): number {
    this.cleanup();
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }

  /**
   * Get time until next available slot (in ms).
   */
  nextAvailableIn(): number {
    this.cleanup();
    if (this.timestamps.length < this.maxRequests) {
      return 0;
    }
    const oldest = this.timestamps[0];
    return Math.max(0, oldest + this.windowMs - Date.now());
  }

  /**
   * Acquire permission to proceed. Returns immediately if under limit,
   * otherwise queues or rejects based on configuration.
   */
  async acquire(): Promise<void> {
    this.cleanup();

    // Check if we can proceed immediately
    if (this.timestamps.length < this.maxRequests) {
      this.timestamps.push(Date.now());
      this.stats.allowed++;
      return;
    }

    // Rate limited
    this.stats.throttled++;

    if (!this.queueExcess) {
      this.stats.rejected++;
      throw new Error("Rate limit exceeded");
    }

    // Queue the request
    if (this.queue.length >= this.maxQueueSize) {
      this.stats.rejected++;
      throw new Error("Rate limit queue full");
    }

    this.stats.queued++;
    log.debug("Request queued due to rate limit", {
      queueSize: this.queue.length + 1,
      waitTime: this.nextAvailableIn(),
    });

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, timestamp: Date.now() });
      this.processQueue();
    });
  }

  /**
   * Try to acquire without blocking. Returns true if acquired, false otherwise.
   */
  tryAcquire(): boolean {
    this.cleanup();
    if (this.timestamps.length < this.maxRequests) {
      this.timestamps.push(Date.now());
      this.stats.allowed++;
      return true;
    }
    this.stats.throttled++;
    return false;
  }

  /**
   * Process queued requests.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.cleanup();

      if (this.timestamps.length < this.maxRequests) {
        const request = this.queue.shift()!;
        this.timestamps.push(Date.now());
        this.stats.allowed++;
        request.resolve();
      } else {
        // Wait for next available slot
        const waitTime = this.nextAvailableIn();
        await new Promise((r) => setTimeout(r, Math.min(waitTime + 10, 100)));
      }
    }

    this.processing = false;
  }

  /**
   * Get current rate limiter statistics.
   */
  getStats(): {
    allowed: number;
    throttled: number;
    queued: number;
    rejected: number;
    queueSize: number;
    remaining: number;
  } {
    return {
      ...this.stats,
      queueSize: this.queue.length,
      remaining: this.remaining(),
    };
  }

  /**
   * Reset the rate limiter state.
   */
  reset(): void {
    this.timestamps = [];
    this.queue.forEach((q) => q.reject(new Error("Rate limiter reset")));
    this.queue = [];
    this.stats = { allowed: 0, throttled: 0, queued: 0, rejected: 0 };
  }
}

/**
 * Rate limiter registry for managing per-agent rate limits.
 */
export class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>();
  private defaultOptions: RateLimiterOptions;

  constructor(defaultOptions: RateLimiterOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  /**
   * Get or create a rate limiter for a specific key (e.g., agent name).
   */
  get(key: string, opts?: RateLimiterOptions): RateLimiter {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter({ ...this.defaultOptions, ...opts });
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  /**
   * Acquire permission for a specific key.
   */
  async acquire(key: string): Promise<void> {
    return this.get(key).acquire();
  }

  /**
   * Get stats for all limiters.
   */
  getAllStats(): Record<string, ReturnType<RateLimiter["getStats"]>> {
    const stats: Record<string, ReturnType<RateLimiter["getStats"]>> = {};
    for (const [key, limiter] of this.limiters) {
      stats[key] = limiter.getStats();
    }
    return stats;
  }

  /**
   * Reset all rate limiters.
   */
  resetAll(): void {
    for (const limiter of this.limiters.values()) {
      limiter.reset();
    }
  }
}

/**
 * Global rate limiter registry for agents.
 */
export const agentRateLimiters = new RateLimiterRegistry({
  maxRequests: getConfig().rateLimit.maxRequestsPerSecond,
  windowMs: 1000,
  queueExcess: getConfig().rateLimit.queueExcess,
  maxQueueSize: getConfig().rateLimit.maxQueueSize,
});
