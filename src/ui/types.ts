import type { TaskResult } from "../planner/types.js";
import type { Step } from "../orchestrator.js";

// --- REST Request/Response ---

export type SubmitGoalRequest = {
  goal: string;
  maxConcurrency?: number;
  maxSteps?: number;
};

export type RunStatus = {
  runId: string;
  goal: string;
  state: "thinking" | "executing" | "done" | "error";
  steps: Step[];
  finalAnswer?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

// --- SSE Event Types ---

export type SSEEvent =
  | { type: "run:started"; runId: string; goal: string }
  | { type: "step:thinking"; runId: string; stepNumber: number }
  | { type: "step:started"; runId: string; stepNumber: number; taskIds: string[]; tasks?: Array<{ id: string; task: string; agent?: string }> }
  | { type: "task:started"; runId: string; stepNumber: number; taskId: string }
  | { type: "task:chunk"; runId: string; stepNumber: number; taskId: string; content: string; done: boolean }
  | { type: "task:ended"; runId: string; stepNumber: number; taskId: string; result: TaskResult; status: string }
  | { type: "step:ended"; runId: string; stepNumber: number }
  | { type: "run:complete"; runId: string; answer?: string; durationMs: number }
  | { type: "run:error"; runId: string; error: string }
  | { type: "run:deleted"; runId: string };
