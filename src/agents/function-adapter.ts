import { getConfig } from "../config.js";
import type { TaskNode, TaskResult } from "../planner/types.js";
import { log } from "../utils/logger.js";
import type { AgentAdapter } from "./adapter.js";

export type AgentFunction = (task: string, context: { id: string; config?: TaskNode["config"] }) => Promise<string>;

export type FunctionAdapterOptions = {
  name: string;
  fn: AgentFunction;
  description?: string;
  capabilities?: string[];
  /** Timeout in ms (default: 60000) */
  timeout?: number;
};

export class FunctionAdapter implements AgentAdapter {
  readonly name: string;
  readonly type = "function" as const;
  readonly description?: string;
  readonly capabilities?: string[];

  private fn: AgentFunction;
  private timeout: number;

  constructor(opts: FunctionAdapterOptions) {
    this.name = opts.name;
    this.fn = opts.fn;
    this.description = opts.description;
    this.capabilities = opts.capabilities;
    this.timeout = opts.timeout ?? getConfig().timeouts.adapterDefault;
  }

  async execute(task: TaskNode): Promise<TaskResult> {
    const start = Date.now();
    try {
      log.info(`[${this.name}] Running function for task "${task.id}"`);

      const result = await Promise.race([
        this.fn(task.task, { id: task.id, config: task.config }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Function timed out")), this.timeout),
        ),
      ]);

      return {
        status: "ok",
        output: result,
        metadata: { durationMs: Date.now() - start },
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "Function timed out";
      log.error(`[${this.name}] Task "${task.id}" failed`, { error: String(err) });
      return {
        status: isTimeout ? "timeout" : "error",
        output: String(err),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
