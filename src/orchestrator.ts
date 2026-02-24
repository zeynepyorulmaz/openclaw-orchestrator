import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./agents/adapter.js";
import { AgentRegistry } from "./agents/registry.js";
import { getConfig } from "./config.js";
import { ParseError, ValidationError } from "./errors.js";
import { OrchestratorActionSchema } from "./schemas.js";
import { GatewayRegistry } from "./gateway/registry.js";
import type { GatewayConfig } from "./gateway/types.js";
import type { TaskResult } from "./planner/types.js";
import { log } from "./utils/logger.js";

function buildSystemPrompt(agents: AgentAdapter[]): string {
  const hasMultipleAgents = agents.length > 1;

  const agentSection = hasMultipleAgents
    ? `\n\nAvailable agents:\n${agents.map((a) => {
        let line = `- "${a.name}"`;
        if (a.description) line += `: ${a.description}`;
        if (a.capabilities?.length) line += ` [${a.capabilities.join(", ")}]`;
        return line;
      }).join("\n")}\n\nAssign each task to the most appropriate agent using the "agent" field. If omitted, the first available agent is used.`
    : "";

  const taskFormat = hasMultipleAgents
    ? `{ "id": "short-kebab-id", "task": "description", "agent": "agent-name-or-capability" }`
    : `{ "id": "short-kebab-id", "task": "clear description of what to do" }`;

  return `You are an orchestrator that breaks down goals and executes them step by step.

Given a goal and any results collected so far, decide what to do next.

Respond with ONLY valid JSON in one of these formats:

To execute tasks (they will run in parallel):
{ "action": "execute", "tasks": [${taskFormat}] }

When you have enough information to provide the final answer:
{ "action": "finish", "answer": "your comprehensive final answer here" }
${agentSection}

Rules:
- Tasks in the same response run in parallel — only group truly independent tasks
- Use results from previous steps to inform your next decision
- Don't repeat tasks that already succeeded
- Include relevant context from prior results in task descriptions when a downstream task needs it
- When all needed info is gathered, use "finish" to provide the final answer`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepTask = {
  id: string;
  task: string;
  agent?: string;
  status: "pending" | "running" | "done" | "failed";
  result?: TaskResult;
};

export type Step = {
  stepNumber: number;
  tasks: StepTask[];
};

export type RunState = {
  runId: string;
  goal: string;
  steps: Step[];
  status: "thinking" | "executing" | "done" | "error";
  finalAnswer?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type OrchestratorAction =
  | { action: "execute"; tasks: Array<{ id: string; task: string; agent?: string }> }
  | { action: "finish"; answer: string };

export type RunCallbacks = {
  onThinking?: (stepNumber: number) => void;
  onStepStart?: (stepNumber: number, taskIds: string[], tasks: Array<{ id: string; task: string; agent?: string }>) => void;
  onTaskStart?: (stepNumber: number, taskId: string) => void;
  onTaskChunk?: (stepNumber: number, taskId: string, content: string, done: boolean) => void;
  onTaskEnd?: (stepNumber: number, taskId: string, result: TaskResult) => void;
  onStepEnd?: (stepNumber: number) => void;
  onFinish?: (answer: string) => void;
  onError?: (error: string) => void;
};

export type RunOptions = {
  maxConcurrency?: number;
  maxSteps?: number;
};

export type OrchestratorOptions = {
  /** Override the think step (for testing). Takes a context string, returns raw JSON. */
  thinker?: (context: string) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  readonly gateways = new GatewayRegistry();
  readonly agents = new AgentRegistry();
  private thinker?: (context: string) => Promise<string>;

  constructor(opts?: OrchestratorOptions) {
    this.thinker = opts?.thinker;
  }

  addGateway(config: GatewayConfig): void {
    this.gateways.add(config);
  }

  addAgent(adapter: AgentAdapter): void {
    this.agents.add(adapter);
  }

  /** Adaptive agent loop: think → execute → repeat until done. */
  async run(goal: string, opts?: RunOptions, callbacks?: RunCallbacks): Promise<RunState> {
    const state: RunState = {
      runId: randomUUID(),
      goal,
      steps: [],
      status: "thinking",
      startedAt: Date.now(),
    };

    const { maxSteps: defaultMaxSteps, maxConcurrency: defaultMaxConcurrency } = getConfig().limits;
    const maxSteps = opts?.maxSteps ?? defaultMaxSteps;
    const maxConcurrency = opts?.maxConcurrency ?? defaultMaxConcurrency;

    try {
      for (let i = 0; i < maxSteps; i++) {
        const nextStep = i + 1;

        // Phase 1: Think
        state.status = "thinking";
        callbacks?.onThinking?.(nextStep);
        log.info(`Step ${nextStep}: thinking...`);

        const action = await this.think(state);

        if (action.action === "finish") {
          state.finalAnswer = action.answer;
          state.status = "done";
          state.finishedAt = Date.now();
          log.info("Orchestrator finished", { steps: state.steps.length });
          callbacks?.onFinish?.(action.answer);
          return state;
        }

        // Phase 2: Execute
        state.status = "executing";
        const step: Step = {
          stepNumber: nextStep,
          tasks: action.tasks.map((t) => ({
            id: t.id,
            task: t.task,
            agent: t.agent,
            status: "pending" as const,
          })),
        };
        state.steps.push(step);
        callbacks?.onStepStart?.(nextStep, step.tasks.map((t) => t.id), step.tasks.map((t) => ({ id: t.id, task: t.task, agent: t.agent })));
        log.info(`Step ${nextStep}: executing ${step.tasks.length} tasks`);

        await this.executeStep(step, maxConcurrency, callbacks);
        callbacks?.onStepEnd?.(nextStep);
      }

      // Hit max steps — force a finish
      state.status = "thinking";
      log.info("Max steps reached, forcing finish");
      const finalAnswer = await this.forceFinish(state);
      state.finalAnswer = finalAnswer;
      state.status = "done";
      state.finishedAt = Date.now();
      callbacks?.onFinish?.(finalAnswer);
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      state.finishedAt = Date.now();
      log.error("Orchestrator error", { error: state.error });
      callbacks?.onError?.(state.error);
    }

    return state;
  }

  /** Preview: do one think step without executing (dry-run). */
  async plan(goal: string): Promise<OrchestratorAction> {
    const state: RunState = {
      runId: randomUUID(),
      goal,
      steps: [],
      status: "thinking",
      startedAt: Date.now(),
    };
    return this.think(state);
  }

  private async think(state: RunState): Promise<OrchestratorAction> {
    const context = this.buildContext(state);

    // Retry once if the LLM returns unparseable output
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.callThinker(
        attempt === 0
          ? context
          : context + "\n\nIMPORTANT: Respond with ONLY a JSON object, no other text.",
      );
      try {
        return this.parseAction(raw);
      } catch (err) {
        if (attempt === 0) {
          log.warn("Retrying think step after parse failure");
          continue;
        }
        throw err;
      }
    }
    throw new Error("Unreachable");
  }

  private async forceFinish(state: RunState): Promise<string> {
    const forcePrompt =
      this.buildContext(state) +
      "\n\nYou have reached the maximum number of steps. You MUST respond with a \"finish\" action now, synthesizing everything collected so far.";
    try {
      const raw = await this.callThinker(forcePrompt);
      const action = this.parseAction(raw);
      if (action.action === "finish") return action.answer;
    } catch {
      // Fall through to emergency synthesize
    }
    return this.emergencySynthesize(state);
  }

  private emergencySynthesize(state: RunState): string {
    const parts = state.steps.flatMap((s) =>
      s.tasks
        .filter((t) => t.status === "done" && t.result)
        .map((t) => `## ${t.id}\n${t.result!.output}`),
    );
    return parts.join("\n\n") || "No results collected.";
  }

  private buildContext(state: RunState): string {
    let ctx = `${buildSystemPrompt(this.agents.list())}\n\nGoal: ${state.goal}\n`;

    if (state.steps.length === 0) {
      ctx += "\nNo steps executed yet. Decide what to do first.";
    } else {
      ctx += "\n## Results so far:\n";
      for (const step of state.steps) {
        ctx += `\n### Step ${step.stepNumber}:\n`;
        for (const task of step.tasks) {
          ctx += `- **${task.id}** [${task.status}]: ${task.task}\n`;
          if (task.result) {
            const maxLen = getConfig().limits.outputTruncation;
            const output =
              task.result.output.length > maxLen
                ? task.result.output.slice(0, maxLen) + "...(truncated)"
                : task.result.output;
            ctx += `  Output: ${output}\n`;
          }
        }
      }
      ctx += "\nDecide what to do next based on these results.";
    }

    return ctx;
  }

  private async callThinker(context: string): Promise<string> {
    if (this.thinker) {
      return this.thinker(context);
    }
    const gateway = await this.gateways.pick();
    return gateway.chat(context, {
      sessionKey: `orch-${randomUUID().slice(0, 8)}`,
    });
  }

  private parseAction(raw: string): OrchestratorAction {
    // Try to extract JSON from the response — the LLM sometimes wraps it in
    // markdown fences or prefixes it with explanatory prose.
    const jsonStr = raw
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();

    let parsed: OrchestratorAction;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // LLM may have returned text before/after the JSON — try to extract it
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // JSON may be truncated — try to salvage a finish action
          const salvaged = this.salvageTruncatedFinish(raw);
          if (salvaged) return salvaged;

          log.error("Failed to parse orchestrator action", { raw: raw.slice(0, 500) });
          throw new ParseError(`Orchestrator returned invalid JSON`);
        }
      } else {
        // No {…} found at all — JSON may be truncated without a closing brace
        const salvaged = this.salvageTruncatedFinish(raw);
        if (salvaged) return salvaged;

        log.error("Failed to parse orchestrator action", { raw: raw.slice(0, 500) });
        throw new ParseError("Orchestrator returned no JSON object");
      }
    }

    const result = OrchestratorActionSchema.safeParse(parsed);
    if (!result.success) {
      // Map Zod errors to the legacy messages tests expect
      const raw_action = (parsed as Record<string, unknown>).action;
      if (raw_action !== "execute" && raw_action !== "finish") {
        throw new ValidationError("VALIDATION_FAILED", `Unknown orchestrator action: ${raw_action}`);
      }
      const msg = result.error.issues.map((i) => i.message).join("; ");
      throw new ValidationError("VALIDATION_FAILED", msg);
    }

    return result.data;
  }

  /** Try to extract a usable answer from truncated JSON (e.g. gateway cut off the response). */
  private salvageTruncatedFinish(raw: string): OrchestratorAction | null {
    const finishMatch = raw.match(/"action"\s*:\s*"finish"/);
    if (!finishMatch) return null;

    const answerMatch = raw.match(/"answer"\s*:\s*"([\s\S]*)/);
    if (!answerMatch) return null;

    // Take everything after "answer": " and strip trailing junk
    let answer = answerMatch[1];
    // Remove trailing incomplete JSON (unmatched quotes, braces, fences)
    answer = answer.replace(/["}\s`]*$/, "");
    // Unescape JSON string escapes
    answer = answer.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

    if (answer.length < 10) return null;

    log.warn("Salvaged truncated finish action", { answerLength: answer.length });
    return { action: "finish", answer };
  }

  private async executeStep(step: Step, maxConcurrency: number, callbacks?: RunCallbacks): Promise<void> {
    for (let i = 0; i < step.tasks.length; i += maxConcurrency) {
      const batch = step.tasks.slice(i, i + maxConcurrency);
      await Promise.allSettled(
        batch.map(async (task) => {
          task.status = "running";
          callbacks?.onTaskStart?.(step.stepNumber, task.id);

          const agent = task.agent
            ? this.agents.pick(task.agent) ?? this.agents.list()[0]
            : this.agents.list()[0];
          if (!agent) {
            task.status = "failed";
            task.result = { status: "error", output: "No agent available" };
            callbacks?.onTaskEnd?.(step.stepNumber, task.id, task.result);
            return;
          }

          const taskNode = {
            id: task.id,
            task: task.task,
            dependsOn: [],
            status: "running" as const,
          };

          try {
            let result;
            // Use streaming if agent supports it and callback is provided
            if (agent.executeStream && callbacks?.onTaskChunk) {
              result = await agent.executeStream(taskNode, (chunk) => {
                callbacks.onTaskChunk!(step.stepNumber, task.id, chunk.content, chunk.done);
              });
            } else {
              result = await agent.execute(taskNode);
            }
            task.result = result;
            task.status = result.status === "ok" ? "done" : "failed";
          } catch (err) {
            task.result = { status: "error", output: String(err) };
            task.status = "failed";
          }

          callbacks?.onTaskEnd?.(step.stepNumber, task.id, task.result!);
        }),
      );
    }
  }

  /** Clean up all gateway connections. */
  shutdown(): void {
    this.gateways.disconnectAll();
  }
}
