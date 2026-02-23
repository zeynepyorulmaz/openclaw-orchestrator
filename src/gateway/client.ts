import { randomUUID, createHash, generateKeyPairSync, sign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";
import { log } from "../utils/logger.js";
import type {
  EventFrame,
  GatewayConfig,
  GatewayFrame,
  ResponseFrame,
} from "./types.js";

const PROTOCOL_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEVICE_IDENTITY_DIR = join(homedir(), ".openclaw-orchestrator");
const DEVICE_IDENTITY_FILE = join(DEVICE_IDENTITY_DIR, "device-identity.json");

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type HelloPayload = {
  server?: { version: string; connId?: string };
  features?: { methods: string[]; events?: string[] };
  policy?: { maxPayload?: number; maxBufferedBytes?: number; tickIntervalMs?: number };
  snapshot?: Record<string, unknown>;
  auth?: { deviceToken?: string; role?: string; scopes?: string[] };
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyBase64: string;
  privateKeyPem: string;
};

function getOrCreateDeviceIdentity(): DeviceIdentity {
  try {
    const data = readFileSync(DEVICE_IDENTITY_FILE, "utf-8");
    const saved = JSON.parse(data) as DeviceIdentity;
    if (saved.deviceId && saved.publicKeyBase64 && saved.privateKeyPem) {
      return saved;
    }
  } catch {
    // File doesn't exist or invalid — create new
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const deviceId = createHash("sha256").update(rawPub).digest("hex");
  const publicKeyBase64 = Buffer.from(rawPub).toString("base64url");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  const identity: DeviceIdentity = { deviceId, publicKeyBase64, privateKeyPem };

  try {
    mkdirSync(DEVICE_IDENTITY_DIR, { recursive: true });
    writeFileSync(DEVICE_IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  } catch (err) {
    log.warn("Could not persist device identity", { error: String(err) });
  }

  return identity;
}

function signConnectData(identity: DeviceIdentity, data: string): string {
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const signature = sign(null, Buffer.from(data, "utf-8"), privateKey);
  return Buffer.from(signature).toString("base64url");
}

/** Derive the HTTP origin from a ws:// or wss:// URL */
function wsUrlToOrigin(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, (_, s) => `http${s}://`).replace(/\/+$/, "");
}

/** Login via HTTP and return the session cookie string */
async function fetchSessionCookie(wsUrl: string, token: string): Promise<string | undefined> {
  const origin = wsUrlToOrigin(wsUrl);
  try {
    const res = await fetch(`${origin}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
      redirect: "manual",
    });
    const setCookie = res.headers.get("set-cookie");
    const match = setCookie?.match(/connect\.sid=([^;]+)/);
    if (match) {
      return "connect.sid=" + match[1];
    }
    log.debug("No session cookie in login response", { status: res.status });
  } catch (err) {
    log.debug("HTTP login failed (non-fatal)", { error: String(err) });
  }
  return undefined;
}

type ChatPending = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// SOUL.md parser — extracts description, capabilities, and role prompt
// ---------------------------------------------------------------------------

export function parseSoulMd(content: string): {
  description: string;
  capabilities: string[];
  rolePrompt: string;
} {
  const lines = content.split("\n");

  // Description: first non-empty, non-heading paragraph after the title
  let description = "";
  let pastTitle = false;
  for (const line of lines) {
    if (!pastTitle) {
      if (line.startsWith("# ")) pastTitle = true;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) break;
    description = trimmed;
    break;
  }

  // Capabilities: bullet items under "## What You're Good At"
  const capabilities: string[] = [];
  let inCapabilities = false;
  for (const line of lines) {
    if (/^##\s+What You're Good At/i.test(line)) {
      inCapabilities = true;
      continue;
    }
    if (inCapabilities) {
      if (line.startsWith("## ")) break;
      const bullet = line.match(/^[-*]\s+(.+)/);
      if (bullet) {
        capabilities.push(
          bullet[1]
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .trim()
            .replace(/\s+/g, "-"),
        );
      }
    }
  }

  return {
    description,
    capabilities,
    rolePrompt: content,
  };
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private pendingChats = new Map<string, ChatPending>();
  private helloPayload: HelloPayload | null = null;
  private connectPromise: Promise<HelloPayload> | null = null;
  private deviceIdentity: DeviceIdentity;

  readonly config: GatewayConfig;

  onEvent?: (evt: EventFrame) => void;

  constructor(config: GatewayConfig) {
    this.config = config;
    this.deviceIdentity = getOrCreateDeviceIdentity();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.helloPayload !== null;
  }

  get serverVersion(): string | undefined {
    return this.helloPayload?.server?.version;
  }

  get availableMethods(): string[] {
    return this.helloPayload?.features?.methods ?? [];
  }

  async connect(): Promise<HelloPayload> {
    if (this.connected && this.helloPayload) return this.helloPayload;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<HelloPayload> {
    // Step 1: HTTP login to get session cookie (needed for scopes)
    let sessionCookie: string | undefined;
    if (this.config.token) {
      sessionCookie = await fetchSessionCookie(this.config.url, this.config.token);
      if (sessionCookie) {
        log.debug("Got session cookie from HTTP login");
      }
    }

    return new Promise((resolve, reject) => {
      let connectSettled = false;
      const settle = (fn: () => void) => {
        if (connectSettled) return;
        connectSettled = true;
        fn();
      };

      // Step 2: Open WebSocket with cookie + origin headers
      const origin = wsUrlToOrigin(this.config.url);
      const headers: Record<string, string> = { Origin: origin };
      if (sessionCookie) headers.Cookie = sessionCookie;

      const ws = new WebSocket(this.config.url, { headers });
      this.ws = ws;
      let connectSent = false;

      const timeout = setTimeout(() => {
        settle(() => {
          ws.close();
          reject(new Error(`Connection to ${this.config.name} timed out`));
        });
      }, DEFAULT_TIMEOUT_MS);

      const sendConnect = (nonce?: string) => {
        if (connectSent) return;
        connectSent = true;

        const identity = this.deviceIdentity;
        const role = "operator";
        const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
        const clientId = "openclaw-control-ui";
        const clientMode = "webchat";
        const signedAt = Date.now();
        const token = this.config.token ?? "";

        // v2 signature includes nonce; v1 does not
        const version = nonce ? "v2" : "v1";
        const parts = [version, identity.deviceId, clientId, clientMode, role, scopes.join(","), String(signedAt), token];
        if (version === "v2" && nonce) parts.push(nonce);
        const dataToSign = parts.join("|");
        const signature = signConnectData(identity, dataToSign);

        const connectId = randomUUID();
        const connectParams = {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: clientId, version: "0.1.0", platform: process.platform, mode: clientMode },
          role,
          scopes,
          caps: [],
          auth: { token: this.config.token },
          device: {
            id: identity.deviceId,
            publicKey: identity.publicKeyBase64,
            signature,
            signedAt,
            nonce,
          },
        };

        this.pending.set(connectId, {
          resolve: (payload) => {
            clearTimeout(timeout);
            const hello = (payload ?? {}) as HelloPayload;
            this.helloPayload = hello;
            log.info(`Connected to gateway ${this.config.name}`, {
              version: hello.server?.version ?? "unknown",
              methods: hello.features?.methods?.length ?? 0,
            });
            settle(() => resolve(hello));
          },
          reject: (err) => {
            clearTimeout(timeout);
            settle(() => reject(err));
          },
          timer: timeout,
        });

        const frame = { type: "req" as const, id: connectId, method: "connect", params: connectParams };
        ws.send(JSON.stringify(frame));
      };

      ws.on("open", () => {
        // Wait briefly for a connect.challenge event, then send connect without nonce
        setTimeout(() => sendConnect(), 800);
      });

      ws.on("message", (raw) => {
        const data = typeof raw === "string" ? raw : raw.toString("utf-8");
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          log.warn("Failed to parse gateway frame", { data: data.slice(0, 200) });
          return;
        }

        const frame = parsed as GatewayFrame;

        // Handle connect.challenge — save nonce and trigger connect
        if (frame.type === "event" && (frame as EventFrame).event === "connect.challenge") {
          const payload = (frame as EventFrame).payload as { nonce?: string } | undefined;
          if (payload?.nonce) {
            log.debug("Received connect.challenge", { nonce: payload.nonce });
            sendConnect(payload.nonce);
          }
          return;
        }

        if (frame.type === "res") {
          this.handleResponse(frame as ResponseFrame);
        } else if (frame.type === "event") {
          const evt = frame as EventFrame;
          if (evt.event === "chat") {
            this.handleChatEvent(evt);
          }
          this.onEvent?.(evt);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        log.error(`Gateway ${this.config.name} error`, { error: String(err) });
        settle(() => reject(err));
      });

      ws.on("close", (code, reason) => {
        clearTimeout(timeout);
        this.helloPayload = null;
        settle(() => reject(new Error(`Connection closed (code=${code})`)));
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`Connection closed (code=${code})`));
          this.pending.delete(id);
        }
        for (const [id, p] of this.pendingChats) {
          clearTimeout(p.timer);
          p.reject(new Error(`Connection closed (code=${code})`));
          this.pendingChats.delete(id);
        }
        log.debug(`Gateway ${this.config.name} closed`, { code, reason: reason.toString() });
      });
    });
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.connected) {
      await this.connect();
    }

    const id = randomUUID();
    const frame = { type: "req" as const, id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  private handleResponse(frame: ResponseFrame): void {
    const p = this.pending.get(frame.id);
    if (!p) return;

    clearTimeout(p.timer);
    this.pending.delete(frame.id);

    if (frame.ok) {
      p.resolve(frame.payload);
    } else {
      const err = frame.error;
      p.reject(new Error(err ? `${err.code}: ${err.message}` : "Unknown gateway error"));
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.call("health");
      return true;
    } catch {
      return false;
    }
  }

  private handleChatEvent(evt: EventFrame): void {
    const payload = evt.payload as { runId?: string; state?: string; message?: { content?: Array<{ text?: string }> }; error?: string } | undefined;
    if (!payload?.runId) return;

    const p = this.pendingChats.get(payload.runId);
    if (!p) return;

    if (payload.state === "final") {
      clearTimeout(p.timer);
      this.pendingChats.delete(payload.runId);
      const text = payload.message?.content
        ?.map((c) => c.text ?? "")
        .join("") ?? JSON.stringify(payload.message);
      p.resolve(text);
    } else if (payload.state === "error") {
      clearTimeout(p.timer);
      this.pendingChats.delete(payload.runId);
      p.reject(new Error(payload.error ?? "Chat stream error"));
    }
  }

  /**
   * Send a chat message and wait for the full streamed response.
   * Returns the final assistant message text.
   * Safe for concurrent calls — each is correlated by runId.
   */
  async chat(message: string, opts?: { sessionKey?: string; timeoutMs?: number; agentId?: string }): Promise<string> {
    if (!this.connected) await this.connect();

    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const baseKey = opts?.sessionKey ?? "orchestrator";
    // Prefix session key with agent:<id>: so the gateway routes to the correct agent
    const sessionKey = opts?.agentId ? `agent:${opts.agentId}:${baseKey}` : baseKey;

    const params: Record<string, unknown> = {
      message,
      sessionKey,
      idempotencyKey: randomUUID(),
      deliver: false,
    };

    const ack = await this.call<{ runId: string }>("chat.send", params);

    const runId = ack?.runId;
    if (!runId) {
      throw new Error("chat.send did not return a runId");
    }

    // Register in pendingChats keyed by runId — handleChatEvent will resolve/reject
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingChats.delete(runId);
        reject(new Error(`Chat response timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingChats.set(runId, { resolve, reject, timer });
    });
  }

  /** Send a chat message (fire-and-forget, returns the runId acknowledgment). */
  async invokeAgent(message: string, opts?: { agentId?: string; model?: string; sessionKey?: string }): Promise<unknown> {
    return this.call("chat.send", {
      message,
      sessionKey: opts?.sessionKey ?? "orchestrator",
      idempotencyKey: randomUUID(),
      deliver: false,
      ...opts,
    });
  }

  async listModels(): Promise<unknown> {
    return this.call("models.list");
  }

  async listAgents(): Promise<unknown> {
    return this.call("agents.list");
  }

  /** Fetch a single agent file (e.g. SOUL.md). Returns content or null. */
  async getAgentFile(agentId: string, fileName: string): Promise<string | null> {
    try {
      const result = await this.call<{ file?: { content?: string } }>(
        "agents.files.get",
        { agentId, name: fileName },
      );
      return result?.file?.content ?? null;
    } catch {
      return null;
    }
  }

  /** Discover agents registered on the gateway, enriched with SOUL.md metadata. */
  async discoverAgents(): Promise<
    Array<{ id: string; name: string; description?: string; capabilities?: string[]; rolePrompt?: string }>
  > {
    const result = await this.call<
      | Array<{ id?: string; name?: string }>
      | { agents?: Array<{ id?: string; name?: string }> }
    >("agents.list");

    const list = Array.isArray(result) ? result : (result as { agents?: unknown[] })?.agents ?? [];
    const agents = (list as Array<{ id?: string; name?: string }>)
      .filter((a) => a.id || a.name)
      .map((a) => ({
        id: a.id ?? a.name!,
        name: a.name ?? a.id!,
      }));

    // Fetch SOUL.md for each agent in parallel
    const enriched = await Promise.allSettled(
      agents.map(async (a) => {
        const soul = await this.getAgentFile(a.id, "SOUL.md");
        const meta = soul ? parseSoulMd(soul) : undefined;
        return {
          ...a,
          description: meta?.description,
          capabilities: meta?.capabilities,
          rolePrompt: meta?.rolePrompt,
        };
      }),
    );

    return enriched.map((r, i) =>
      r.status === "fulfilled" ? r.value : { ...agents[i] },
    );
  }

  async listSessions(): Promise<unknown> {
    return this.call("sessions.list");
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close(1000, "orchestrator disconnect");
      this.ws = null;
      this.helloPayload = null;
    }
  }
}
