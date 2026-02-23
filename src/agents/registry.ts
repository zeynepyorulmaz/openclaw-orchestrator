import { ValidationError } from "../errors.js";
import type { AgentAdapter } from "./adapter.js";

export class AgentRegistry {
  private agents = new Map<string, AgentAdapter>();

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
}
