import { describe, expect, it, beforeEach } from "vitest";
import { Cache, taskCache } from "../src/utils/cache.js";

describe("Cache", () => {
  let cache: Cache<string>;

  beforeEach(() => {
    cache = new Cache<string>({ ttlMs: 1000, maxEntries: 3 });
  });

  it("stores and retrieves values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
  });

  it("returns undefined for non-existent keys", () => {
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("respects TTL expiration", async () => {
    const shortCache = new Cache<string>({ ttlMs: 50 });
    shortCache.set("key", "value");
    expect(shortCache.get("key")).toBe("value");
    
    await new Promise((r) => setTimeout(r, 60));
    expect(shortCache.get("key")).toBeUndefined();
  });

  it("evicts oldest entries when at capacity", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    cache.set("d", "4"); // Should evict 'a'
    
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("updates LRU order on access", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    
    cache.get("a"); // Access 'a', making it most recent
    cache.set("d", "4"); // Should evict 'b' (oldest accessed)
    
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");
  });

  it("has() returns correct state", () => {
    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
    expect(cache.has("nonexistent")).toBe(false);
  });

  it("delete() removes specific entries", () => {
    cache.set("key", "value");
    expect(cache.delete("key")).toBe(true);
    expect(cache.get("key")).toBeUndefined();
    expect(cache.delete("key")).toBe(false);
  });

  it("clear() removes all entries", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  it("prune() removes expired entries", async () => {
    const shortCache = new Cache<string>({ ttlMs: 30, maxEntries: 10 });
    shortCache.set("a", "1");
    shortCache.set("b", "2");
    
    await new Promise((r) => setTimeout(r, 50));
    
    const pruned = shortCache.prune();
    expect(pruned).toBe(2);
    expect(shortCache.size).toBe(0);
  });

  it("getStats() returns correct statistics", () => {
    cache.set("key", "value");
    cache.get("key"); // hit
    cache.get("key"); // hit
    cache.get("nonexistent"); // miss
    
    const stats = cache.getStats();
    expect(stats.size).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.667, 2);
  });

  it("taskKey generates consistent keys", () => {
    const key1 = Cache.taskKey("do something", "agent1");
    const key2 = Cache.taskKey("do something", "agent1");
    const key3 = Cache.taskKey("do something else", "agent1");
    
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it("sliding expiration extends TTL on access", async () => {
    const slidingCache = new Cache<string>({ ttlMs: 80, slidingExpiration: true });
    slidingCache.set("key", "value");
    
    // Access before expiration multiple times
    await new Promise((r) => setTimeout(r, 40));
    expect(slidingCache.get("key")).toBe("value"); // Should extend TTL
    
    await new Promise((r) => setTimeout(r, 40));
    expect(slidingCache.get("key")).toBe("value"); // Should still be valid
    
    await new Promise((r) => setTimeout(r, 40));
    expect(slidingCache.get("key")).toBe("value"); // Should still be valid
  });
});

describe("taskCache", () => {
  it("is a singleton cache instance", () => {
    expect(taskCache).toBeInstanceOf(Cache);
  });
});
