import type { AgentRegistry } from "../agents/registry.js";
import { getConfig } from "../config.js";
import { isComplete, readyNodes, skipDownstream } from "../planner/task-graph.js";
import type { TaskGraph, TaskNode, TaskResult } from "../planner/types.js";
import { Cache, taskCache } from "../utils/cache.js";
import { log } from "../utils/logger.js";
import { agentRateLimiters } from "../utils/rate-limiter.js";
import { withRetry } from "../utils/retry.js";
import type { ExecutionOptions, ExecutionResult } from "./types.js";

export class Executor {
  private agents: AgentRegistry;

  constructor(agents: AgentRegistry) {
    this.agents = agents;
  }

  async execute(graph: TaskGraph, opts?: ExecutionOptions): Promise<ExecutionResult> {
    const start = Date.now();
    const maxConcurrency = opts?.maxConcurrency ?? getConfig().limits.maxConcurrency;
    const nodeResults: Record<string, TaskResult> = {};

    while (!isComplete(graph)) {
      if (opts?.abortSignal?.aborted) {
        // Mark remaining pending as skipped
        for (const n of graph.nodes) {
          if (n.status === "pending") n.status = "skipped";
        }
        break;
      }

      const ready = readyNodes(graph);
      if (ready.length === 0) {
        // Deadlock — nodes remain but none are ready
        log.error("Execution deadlock: no ready nodes but graph not complete");
        break;
      }

      // Dispatch up to maxConcurrency in parallel
      const batch = ready.slice(0, maxConcurrency);
      const promises = batch.map((node) => this.executeNode(node, opts));
      const results = await Promise.allSettled(promises);

      for (let i = 0; i < batch.length; i++) {
        const node = batch[i];
        const settled = results[i];

        if (settled.status === "fulfilled") {
          const result = settled.value;
          node.result = result;
          nodeResults[node.id] = result;

          if (result.status === "ok") {
            node.status = "done";
            opts?.onNodeEnd?.(node.id, result);
          } else {
            node.status = "failed";
            opts?.onNodeEnd?.(node.id, result);
            skipDownstream(graph, node.id);
          }
        } else {
          const result: TaskResult = { status: "error", output: String(settled.reason) };
          node.result = result;
          node.status = "failed";
          nodeResults[node.id] = result;
          opts?.onNodeEnd?.(node.id, result);
          skipDownstream(graph, node.id);
        }
      }
    }

    const success = graph.nodes.every((n) => n.status === "done");

    return {
      graph,
      success,
      durationMs: Date.now() - start,
      nodeResults,
    };
  }

  private async executeNode(node: TaskNode, opts?: ExecutionOptions): Promise<TaskResult> {
    node.status = "running";
    opts?.onNodeStart?.(node.id);

    const agent = node.assignTo
      ? this.agents.pick(node.assignTo)
      : this.agents.list()[0]; // fallback to first registered agent

    if (!agent) {
      return {
        status: "error",
        output: `No agent available for task "${node.id}" (requested: ${node.assignTo ?? "any"})`,
      };
    }

    log.info(`Dispatching "${node.id}" to agent "${agent.name}"`);

    const cfg = getConfig();

    // Cache check — skip execution if we have a fresh result for this task+agent
    const cacheKey = Cache.taskKey(node.task, agent.name);
    if (cfg.cache.enabled) {
      const cached = taskCache.get(cacheKey);
      if (cached !== undefined) {
        log.debug(`Cache hit for task "${node.id}" (agent: ${agent.name})`);
        return { status: "ok", output: cached };
      }
    }

    // Rate limiting — throttle per-agent call rate
    if (cfg.rateLimit.enabled) {
      await agentRateLimiters.acquire(agent.name);
    }

    const run = (): Promise<TaskResult> => agent.execute(node);
    const retries = node.config?.retries ?? 0;
    const result = await (retries > 0 ? withRetry(run, { maxAttempts: retries + 1 }) : run());

    // Store successful result in cache
    if (cfg.cache.enabled && result.status === "ok") {
      taskCache.set(cacheKey, result.output);
    }

    return result;
  }
}
