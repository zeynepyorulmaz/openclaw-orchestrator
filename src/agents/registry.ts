import { ValidationError } from "../errors.js";
import { log } from "../utils/logger.js";
import type { AgentAdapter } from "./adapter.js";

export type AgentHealth = {
  name: string;
  healthy: boolean;
  lastCheck: number;
  responseTimeMs?: number;
  error?: string;
};

export class AgentRegistry {
  private agents = new Map<string, AgentAdapter>();
  private healthCache = new Map<string, AgentHealth>();

  add(agent: AgentAdapter): void {
    if (this.agents.has(agent.name)) {
      throw new ValidationError("DUPLICATE_REGISTRATION", `Agent "${agent.name}" already registered`);
    }
    this.agents.set(agent.name, agent);
  }

  remove(name: string): boolean {
    return this.agents.delete(name);
  }

  get(name: string): AgentAdapter | undefined {
    return this.agents.get(name);
  }

  list(): AgentAdapter[] {
    return [...this.agents.values()];
  }

  names(): string[] {
    return [...this.agents.keys()];
  }

  /** Find agents that have a specific capability. */
  withCapability(cap: string): AgentAdapter[] {
    return this.list().filter((a) => a.capabilities?.includes(cap));
  }

  /** Pick an agent by name, or find one with matching capabilities. */
  pick(nameOrCapability: string): AgentAdapter | undefined {
    return this.get(nameOrCapability) ?? this.withCapability(nameOrCapability)[0];
  }

  /** Check health of a specific agent. */
  async checkHealth(name: string): Promise<AgentHealth> {
    const agent = this.get(name);
    if (!agent) {
      return { name, healthy: false, lastCheck: Date.now(), error: "Agent not found" };
    }

    const start = Date.now();
    try {
      if (agent.healthCheck) {
        const healthy = await agent.healthCheck();
        const result: AgentHealth = {
          name,
          healthy,
          lastCheck: Date.now(),
          responseTimeMs: Date.now() - start,
        };
        this.healthCache.set(name, result);
        return result;
      }
      // No health check method - assume healthy
      const result: AgentHealth = { name, healthy: true, lastCheck: Date.now() };
      this.healthCache.set(name, result);
      return result;
    } catch (err) {
      const result: AgentHealth = {
        name,
        healthy: false,
        lastCheck: Date.now(),
        responseTimeMs: Date.now() - start,
        error: String(err),
      };
      this.healthCache.set(name, result);
      log.warn(`Health check failed for agent "${name}"`, { error: String(err) });
      return result;
    }
  }

  /** Check health of all registered agents. */
  async checkAllHealth(): Promise<AgentHealth[]> {
    const results = await Promise.all(
      this.names().map((name) => this.checkHealth(name))
    );
    return results;
  }

  /** Get cached health status (without making new checks). */
  getCachedHealth(name: string): AgentHealth | undefined {
    return this.healthCache.get(name);
  }

  /** Get all cached health statuses. */
  getAllCachedHealth(): AgentHealth[] {
    return [...this.healthCache.values()];
  }
}
