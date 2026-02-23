import { z } from "zod/v4";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse data with a Zod schema. Throws `ValidationError` on failure. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => i.message).join("; ");
  throw new ValidationError("VALIDATION_FAILED", `${context}: ${issues}`);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** POST /api/runs request body. */
export const SubmitGoalRequestSchema = z.object({
  goal: z.string({ error: "Missing 'goal' field" }).transform((s) => s.trim()).check(z.minLength(1, "Missing 'goal' field")),
  maxConcurrency: z.number().check(z.int(), z.gte(1)).optional(),
  maxSteps: z.number().check(z.int(), z.gte(1)).optional(),
});

/** A single task inside an "execute" action. */
const TaskItemSchema = z.object({
  id: z.string().check(z.minLength(1, "task id must not be empty")),
  task: z.string().check(z.minLength(1, "task description must not be empty")),
  agent: z.string().optional(),
});

/** Orchestrator LLM response — either execute or finish. */
export const OrchestratorActionSchema = z.union([
  z.object({
    action: z.literal("execute"),
    tasks: z.array(TaskItemSchema).check(z.minLength(1, "Orchestrator returned execute with no tasks")),
  }),
  z.object({
    action: z.literal("finish"),
    answer: z.string().check(z.minLength(1, "Orchestrator returned finish with no answer")),
  }),
]);

/** A single node from the planner response. */
const PlannerNodeSchema = z.object({
  id: z.string().check(z.minLength(1)),
  task: z.string().check(z.minLength(1)),
  dependsOn: z.array(z.string()).default([]),
  assignTo: z.string().optional(),
});

/** Planner LLM response. */
export const PlannerResponseSchema = z.object({
  nodes: z.array(PlannerNodeSchema).check(z.minLength(1, "Planner returned empty or invalid nodes array")),
  synthesizerPrompt: z.string().optional(),
});

/** Gateway config for registration. */
export const GatewayConfigSchema = z.object({
  name: z.string().check(z.minLength(1, "Gateway name is required")),
  url: z.string().check(z.minLength(1, "Gateway URL is required")),
  token: z.string().optional(),
});
