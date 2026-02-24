import { getConfig } from "../config.js";
import type { TaskNode, TaskResult } from "../planner/types.js";
import { log } from "../utils/logger.js";
import type { AgentAdapter, StreamCallback } from "./adapter.js";

export type AgentFunction = (task: string, context: { id: string; config?: TaskNode["config"] }) => Promise<string>;

/**
 * A streaming agent function that yields chunks of output.
 * The function should call `emit` for each chunk of output.
 */
export type StreamingAgentFunction = (
  task: string,
  context: { id: string; config?: TaskNode["config"] },
  emit: (chunk: string) => void
) => Promise<string>;

export type FunctionAdapterOptions = {
  name: string;
  fn: AgentFunction;
  /** Optional streaming function. If provided, executeStream will use this. */
  streamFn?: StreamingAgentFunction;
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
  readonly supportsStreaming: boolean;

  private fn: AgentFunction;
  private streamFn?: StreamingAgentFunction;
  private timeout: number;

  constructor(opts: FunctionAdapterOptions) {
    this.name = opts.name;
    this.fn = opts.fn;
    this.streamFn = opts.streamFn;
    this.description = opts.description;
    this.capabilities = opts.capabilities;
    this.timeout = opts.timeout ?? getConfig().timeouts.adapterDefault;
    this.supportsStreaming = !!opts.streamFn;
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

  async executeStream(task: TaskNode, onChunk: StreamCallback): Promise<TaskResult> {
    if (!this.streamFn) {
      // Fall back to non-streaming execution
      const result = await this.execute(task);
      // Emit the full result as a single chunk
      onChunk({ content: result.output, done: true });
      return result;
    }

    const start = Date.now();
    try {
      log.info(`[${this.name}] Running streaming function for task "${task.id}"`);

      const result = await Promise.race([
        this.streamFn(
          task.task,
          { id: task.id, config: task.config },
          (chunk) => onChunk({ content: chunk, done: false })
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Function timed out")), this.timeout),
        ),
      ]);

      // Emit final chunk
      onChunk({ content: "", done: true });

      return {
        status: "ok",
        output: result,
        metadata: { durationMs: Date.now() - start, streamed: true },
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === "Function timed out";
      log.error(`[${this.name}] Streaming task "${task.id}" failed`, { error: String(err) });
      return {
        status: isTimeout ? "timeout" : "error",
        output: String(err),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }
}
