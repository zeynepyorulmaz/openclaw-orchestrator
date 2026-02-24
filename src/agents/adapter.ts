import type { TaskNode, TaskResult } from "../planner/types.js";

/**
 * Callback for receiving streaming chunks from an agent.
 */
export type StreamCallback = (chunk: StreamChunk) => void;

/**
 * A chunk of streaming output from an agent.
 */
export type StreamChunk = {
  /** The text content of this chunk */
  content: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Optional metadata (e.g., token count, model info) */
  metadata?: Record<string, unknown>;
};

export interface AgentAdapter {
  name: string;
  type: "openclaw" | "http" | "function" | string;
  description?: string;
  capabilities?: string[];
  /** Whether this adapter supports streaming output */
  supportsStreaming?: boolean;

  execute(task: TaskNode): Promise<TaskResult>;
  healthCheck?(): Promise<boolean>;
  
  /**
   * Execute a task with streaming output.
   * If not implemented, falls back to execute().
   */
  executeStream?(task: TaskNode, onChunk: StreamCallback): Promise<TaskResult>;
}
