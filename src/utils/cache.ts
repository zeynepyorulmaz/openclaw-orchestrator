import { createHash } from "node:crypto";
import { getConfig } from "../config.js";
import { log } from "./logger.js";

export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  hits: number;
};

export type CacheOptions = {
  /** Time-to-live in milliseconds (default: 5 minutes) */
  ttlMs?: number;
  /** Maximum number of entries (default: 1000) */
  maxEntries?: number;
  /** Whether to reset TTL on cache hit (default: true) */
  slidingExpiration?: boolean;
};

/**
 * Simple in-memory LRU cache with TTL support.
 * Used for caching agent task results to avoid redundant executions.
 */
export class Cache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  private ttlMs: number;
  private maxEntries: number;
  private slidingExpiration: boolean;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000; // 5 minutes default
    this.maxEntries = opts.maxEntries ?? 1000;
    this.slidingExpiration = opts.slidingExpiration ?? true;
  }

  /**
   * Generate a cache key from task description and optional agent name.
   */
  static taskKey(task: string, agent?: string): string {
    const input = agent ? `${agent}:${task}` : task;
    return createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  /**
   * Get a value from cache. Returns undefined if not found or expired.
   */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.stats.misses++;
      log.debug("Cache entry expired", { key: key.slice(0, 8) });
      return undefined;
    }

    // Update entry for LRU and optionally extend TTL
    this.stats.hits++;
    entry.hits++;
    if (this.slidingExpiration) {
      entry.expiresAt = Date.now() + this.ttlMs;
    }

    // Move to end (most recently used)
    this.entries.delete(key);
    this.entries.set(key, entry);

    log.debug("Cache hit", { key: key.slice(0, 8), hits: entry.hits });
    return entry.value;
  }

  /**
   * Store a value in cache.
   */
  set(key: string, value: T): void {
    // Evict oldest entries if at capacity
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
        this.stats.evictions++;
        log.debug("Cache eviction (LRU)", { key: oldestKey.slice(0, 8) });
      }
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      hits: 0,
    });
    log.debug("Cache set", { key: key.slice(0, 8) });
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete a specific entry.
   */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries.clear();
    log.debug("Cache cleared");
  }

  /**
   * Remove all expired entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      log.debug("Cache pruned", { count: pruned });
    }
    return pruned;
  }

  /**
   * Get current cache statistics.
   */
  getStats(): { size: number; hits: number; misses: number; evictions: number; hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.entries.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Get the number of entries in cache.
   */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Global task result cache instance.
 * Can be used across the application for caching agent outputs.
 */
export const taskCache = new Cache<string>({
  ttlMs: getConfig().cache.ttlMs,
  maxEntries: getConfig().cache.maxEntries,
});
