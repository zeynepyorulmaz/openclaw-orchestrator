import { describe, expect, it, beforeEach } from "vitest";
import { RateLimiter, RateLimiterRegistry, agentRateLimiters } from "../src/utils/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 100, queueExcess: false });
  });

  it("allows requests under the limit", async () => {
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.remaining()).toBe(0);
  });

  it("rejects requests over the limit when queueExcess is false", async () => {
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    
    await expect(limiter.acquire()).rejects.toThrow("Rate limit exceeded");
  });

  it("tryAcquire returns false when over limit", async () => {
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it("canProceed reflects current state", async () => {
    expect(limiter.canProceed()).toBe(true);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.canProceed()).toBe(false);
  });

  it("resets after window expires", async () => {
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    
    expect(limiter.canProceed()).toBe(false);
    
    await new Promise((r) => setTimeout(r, 120));
    
    expect(limiter.canProceed()).toBe(true);
    expect(limiter.remaining()).toBe(3);
  });

  it("queues requests when queueExcess is true", async () => {
    const queueLimiter = new RateLimiter({ 
      maxRequests: 2, 
      windowMs: 50, 
      queueExcess: true 
    });
    
    const results: number[] = [];
    
    // All three should eventually succeed
    const p1 = queueLimiter.acquire().then(() => results.push(1));
    const p2 = queueLimiter.acquire().then(() => results.push(2));
    const p3 = queueLimiter.acquire().then(() => results.push(3));
    
    await Promise.all([p1, p2, p3]);
    
    expect(results).toContain(1);
    expect(results).toContain(2);
    expect(results).toContain(3);
  });

  it("rejects when queue is full", async () => {
    const smallQueueLimiter = new RateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      queueExcess: true,
      maxQueueSize: 1,
    });
    
    await smallQueueLimiter.acquire(); // Takes the slot
    
    // Start a queued request but don't await it yet
    const queuedPromise = smallQueueLimiter.acquire();
    
    // This should reject because queue is full
    await expect(smallQueueLimiter.acquire()).rejects.toThrow("Rate limit queue full");
    
    // Clean up: reset will reject the queued promise, so we need to catch it
    queuedPromise.catch(() => {}); // Ignore the rejection from reset
    smallQueueLimiter.reset();
  });

  it("getStats returns accurate statistics", async () => {
    await limiter.acquire();
    await limiter.acquire();
    limiter.tryAcquire();
    limiter.tryAcquire(); // Should be throttled
    
    const stats = limiter.getStats();
    expect(stats.allowed).toBe(3);
    expect(stats.throttled).toBe(1);
  });

  it("reset clears all state", async () => {
    await limiter.acquire();
    await limiter.acquire();
    limiter.reset();
    
    expect(limiter.remaining()).toBe(3);
    expect(limiter.getStats().allowed).toBe(0);
  });

  it("nextAvailableIn returns time until next slot", async () => {
    expect(limiter.nextAvailableIn()).toBe(0);
    
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    
    const waitTime = limiter.nextAvailableIn();
    expect(waitTime).toBeGreaterThan(0);
    expect(waitTime).toBeLessThanOrEqual(100);
  });
});

describe("RateLimiterRegistry", () => {
  let registry: RateLimiterRegistry;

  beforeEach(() => {
    registry = new RateLimiterRegistry({ maxRequests: 5, windowMs: 100 });
  });

  it("creates limiters on demand", () => {
    const limiter1 = registry.get("agent1");
    const limiter2 = registry.get("agent1");
    
    expect(limiter1).toBe(limiter2); // Same instance
  });

  it("creates separate limiters for different keys", () => {
    const limiter1 = registry.get("agent1");
    const limiter2 = registry.get("agent2");
    
    expect(limiter1).not.toBe(limiter2);
  });

  it("acquire works through registry", async () => {
    await registry.acquire("agent1");
    expect(registry.get("agent1").remaining()).toBe(4);
  });

  it("getAllStats returns stats for all limiters", async () => {
    await registry.acquire("agent1");
    await registry.acquire("agent2");
    await registry.acquire("agent2");
    
    const stats = registry.getAllStats();
    expect(stats["agent1"].allowed).toBe(1);
    expect(stats["agent2"].allowed).toBe(2);
  });

  it("resetAll clears all limiters", async () => {
    await registry.acquire("agent1");
    await registry.acquire("agent2");
    
    registry.resetAll();
    
    expect(registry.get("agent1").remaining()).toBe(5);
    expect(registry.get("agent2").remaining()).toBe(5);
  });
});

describe("agentRateLimiters", () => {
  it("is a singleton registry instance", () => {
    expect(agentRateLimiters).toBeInstanceOf(RateLimiterRegistry);
  });
});
