// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "PARSE_FAILED"
  | "VALIDATION_FAILED"
  | "DUPLICATE_REGISTRATION"
  | "GRAPH_INVALID"
  | "GATEWAY_TIMEOUT"
  | "GATEWAY_CONNECTION_FAILED"
  | "GATEWAY_PROTOCOL_ERROR"
  | "AGENT_EXECUTION_FAILED"
  | "CONFIG_MISSING";

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export class OrchestratorError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Concrete errors
// ---------------------------------------------------------------------------

export class ParseError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super("PARSE_FAILED", message, options);
    this.name = "ParseError";
  }
}

export class ValidationError extends OrchestratorError {
  constructor(code: Extract<ErrorCode, "VALIDATION_FAILED" | "DUPLICATE_REGISTRATION" | "GRAPH_INVALID">, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "ValidationError";
  }
}

export class GatewayError extends OrchestratorError {
  constructor(code: Extract<ErrorCode, "GATEWAY_TIMEOUT" | "GATEWAY_CONNECTION_FAILED" | "GATEWAY_PROTOCOL_ERROR">, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = "GatewayError";
  }
}

export class AgentError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super("AGENT_EXECUTION_FAILED", message, options);
    this.name = "AgentError";
  }
}

export class ConfigError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG_MISSING", message, options);
    this.name = "ConfigError";
  }
}
