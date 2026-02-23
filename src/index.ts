// Config
export { getConfig, configure, resetConfig, defaults } from "./config.js";
export type { OrchestratorConfig } from "./config.js";

// Errors
export {
  OrchestratorError,
  ParseError,
  ValidationError,
  GatewayError,
  AgentError,
  ConfigError,
} from "./errors.js";
export type { ErrorCode } from "./errors.js";

// Schemas
export {
  parseOrThrow,
  SubmitGoalRequestSchema,
  OrchestratorActionSchema,
  PlannerResponseSchema,
  GatewayConfigSchema,
} from "./schemas.js";

// Persistence
export { RunStore } from "./persistence/store.js";

// Core
export { Orchestrator } from "./orchestrator.js";
export type {
  OrchestratorOptions,
  OrchestratorAction,
  RunOptions,
  RunState,
  RunCallbacks,
  Step,
  StepTask,
} from "./orchestrator.js";

// Gateway
export { GatewayClient } from "./gateway/client.js";
export { GatewayRegistry } from "./gateway/registry.js";
export type { GatewayConfig, GatewayHealth } from "./gateway/types.js";

// Agents
export type { AgentAdapter } from "./agents/adapter.js";
export { AgentRegistry } from "./agents/registry.js";
export { OpenClawAdapter } from "./agents/openclaw-adapter.js";
export type { OpenClawAdapterOptions } from "./agents/openclaw-adapter.js";
export { HttpAdapter } from "./agents/http-adapter.js";
export type { HttpAdapterOptions } from "./agents/http-adapter.js";
export { FunctionAdapter } from "./agents/function-adapter.js";
export type { AgentFunction, FunctionAdapterOptions } from "./agents/function-adapter.js";

// Types (kept for adapter compatibility)
export type { TaskNode, TaskGraph, TaskResult, TaskStatus } from "./planner/types.js";

// UI
export { DashboardServer } from "./ui/server.js";
export type { DashboardServerOptions } from "./ui/server.js";

// Utils
export { log, setLogLevel } from "./utils/logger.js";
export { withRetry } from "./utils/retry.js";
