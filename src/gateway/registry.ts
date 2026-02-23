import { getConfig } from "../config.js";
import { ConfigError, GatewayError, ValidationError } from "../errors.js";
import { GatewayConfigSchema, parseOrThrow } from "../schemas.js";
import { log } from "../utils/logger.js";
import { GatewayClient } from "./client.js";
import type { GatewayConfig, GatewayHealth } from "./types.js";

export class GatewayRegistry {
  private clients = new Map<string, GatewayClient>();

  add(config: GatewayConfig): GatewayClient {
    parseOrThrow(GatewayConfigSchema, config, "Gateway config");
    if (this.clients.has(config.name)) {
      throw new ValidationError("DUPLICATE_REGISTRATION", `Gateway "${config.name}" already registered`);
    }
    const client = new GatewayClient(config);
    this.clients.set(config.name, client);
    log.info(`Registered gateway "${config.name}"`, { url: config.url });
    return client;
  }

  remove(name: string): boolean {
    const client = this.clients.get(name);
    if (!client) return false;
    client.disconnect();
    this.clients.delete(name);
    log.info(`Removed gateway "${name}"`);
    return true;
  }

  get(name: string): GatewayClient | undefined {
    return this.clients.get(name);
  }

  list(): GatewayClient[] {
    return [...this.clients.values()];
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  async healthCheck(): Promise<GatewayHealth[]> {
    const results = await Promise.all(
      this.list().map(async (client) => {
        const start = Date.now();
        try {
          const ok = await client.health();
          return {
            name: client.config.name,
            url: client.config.url,
            status: ok ? "healthy" : "unhealthy",
            latencyMs: Date.now() - start,
            serverVersion: client.serverVersion,
            availableMethods: client.availableMethods,
          } satisfies GatewayHealth;
        } catch (err) {
          return {
            name: client.config.name,
            url: client.config.url,
            status: "unhealthy",
            latencyMs: Date.now() - start,
            error: String(err),
          } satisfies GatewayHealth;
        }
      }),
    );
    return results;
  }

  private static get CONNECT_ATTEMPTS() { return getConfig().retry.maxAttempts; }
  private static get CONNECT_RETRY_DELAY_MS() { return getConfig().retry.connectDelayMs; }

  /** Pick a connected gateway, optionally preferring one by name. Uses connect() not health() so gateways that don't implement "health" still work. Retries on failure. */
  async pick(preferred?: string): Promise<GatewayClient> {
    if (this.clients.size === 0) {
      throw new ConfigError(
        "No gateways configured. Start the server with -g <url> and -t <token>, e.g. serve -g 'ws://host:port/' -t YOUR_TOKEN",
      );
    }

    const tryConnect = async (client: GatewayClient): Promise<boolean> => {
      let lastErr: Error | undefined;
      for (let attempt = 1; attempt <= GatewayRegistry.CONNECT_ATTEMPTS; attempt++) {
        try {
          await client.connect();
          return true;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < GatewayRegistry.CONNECT_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, GatewayRegistry.CONNECT_RETRY_DELAY_MS));
          }
        }
      }
      throw lastErr;
    };

    if (preferred) {
      const client = this.clients.get(preferred);
      if (client) {
        await tryConnect(client);
        return client;
      }
    }

    let lastError: Error | undefined;
    for (const client of this.clients.values()) {
      try {
        await tryConnect(client);
        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    const detail = lastError?.message ?? "unknown";
    throw new GatewayError(
      "GATEWAY_CONNECTION_FAILED",
      `Could not connect to any gateway after ${GatewayRegistry.CONNECT_ATTEMPTS} attempt(s). Last error: ${detail}. Check that the gateway is reachable and the token is valid.`,
    );
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }
}
