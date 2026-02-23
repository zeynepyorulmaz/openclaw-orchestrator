export type OrchestratorConfig = {
  timeouts: {
    gatewayDefault: number;
    chat: number;
    healthCheck: number;
    httpHealth: number;
    adapterDefault: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    connectDelayMs: number;
  };
  limits: {
    maxConcurrency: number;
    maxSteps: number;
    maxRuns: number;
    outputTruncation: number;
  };
  server: {
    port: number;
    host: string;
  };
  protocol: {
    version: number;
  };
  cli: {
    pollIntervalMs: number;
  };
};

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

const DEFAULTS: OrchestratorConfig = {
  timeouts: {
    gatewayDefault: 30_000,
    chat: 120_000,
    healthCheck: 1_500,
    httpHealth: 5_000,
    adapterDefault: 60_000,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    connectDelayMs: 2_000,
  },
  limits: {
    maxConcurrency: 8,
    maxSteps: 10,
    maxRuns: 50,
    outputTruncation: 3_000,
  },
  server: {
    port: 3000,
    host: "127.0.0.1",
  },
  protocol: {
    version: 3,
  },
  cli: {
    pollIntervalMs: 800,
  },
};

let current: OrchestratorConfig = structuredClone(DEFAULTS);

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: DeepPartial<T>): T {
  const result = structuredClone(base);
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key];
    if (val !== undefined && typeof val === "object" && !Array.isArray(val) && val !== null) {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        result[key] as Record<string, unknown>,
        val as DeepPartial<Record<string, unknown>>,
      );
    } else if (val !== undefined) {
      (result as Record<string, unknown>)[key as string] = val;
    }
  }
  return result;
}

/** Override config values. Merges deeply with defaults. */
export function configure(overrides: DeepPartial<OrchestratorConfig>): void {
  current = deepMerge(DEFAULTS, overrides) as OrchestratorConfig;
}

/** Reset config to defaults. */
export function resetConfig(): void {
  current = structuredClone(DEFAULTS);
}

/** Get the current config (read-only). */
export function getConfig(): Readonly<OrchestratorConfig> {
  return current;
}

/** The default config values (frozen). */
export const defaults: Readonly<OrchestratorConfig> = Object.freeze(DEFAULTS);
