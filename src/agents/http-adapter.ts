import { getConfig } from "../config.js";
import type { TaskNode, TaskResult } from "../planner/types.js";
import { log } from "../utils/logger.js";
import type { AgentAdapter } from "./adapter.js";

export type HttpAdapterOptions = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  capabilities?: string[];
  /** Timeout in ms (default: 60000) */
  timeout?: number;
};

export class HttpAdapter implements AgentAdapter {
  readonly name: string;
  readonly type = "http" as const;
  readonly capabilities?: string[];

  private url: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(opts: HttpAdapterOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.capabilities = opts.capabilities;
    this.timeout = opts.timeout ?? getConfig().timeouts.adapterDefault;
  }

  async execute(task: TaskNode): Promise<TaskResult> {
    const start = Date.now();
    try {
      log.info(`[${this.name}] Calling ${this.url} for task "${task.id}"`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers },
        body: JSON.stringify({ task: task.task, id: task.id, config: task.config }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text();
        return {
          status: "error",
          output: `HTTP ${res.status}: ${body}`,
          metadata: { durationMs: Date.now() - start },
        };
      }

      const body = await res.text();
      return {
        status: "ok",
        output: body,
        metadata: { durationMs: Date.now() - start, httpStatus: res.status },
      };
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      log.error(`[${this.name}] Task "${task.id}" failed`, { error: String(err) });
      return {
        status: isTimeout ? "timeout" : "error",
        output: String(err),
        metadata: { durationMs: Date.now() - start },
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(this.url, {
        method: "HEAD",
        signal: AbortSignal.timeout(getConfig().timeouts.httpHealth),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
