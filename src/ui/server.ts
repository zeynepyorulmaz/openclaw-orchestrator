import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";
import type { RunStore } from "../persistence/store.js";
import { SubmitGoalRequestSchema } from "../schemas.js";
import { log } from "../utils/logger.js";
import type { RunStatus, SSEEvent, SubmitGoalRequest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DashboardServerOptions = {
  orchestrator: Orchestrator;
  port?: number;
  host?: string;
  runStore?: RunStore;
};

export class DashboardServer {
  private orchestrator: Orchestrator;
  private port: number;
  private host: string;
  private server: Server | null = null;
  private runs = new Map<string, RunStatus>();
  private runStore?: RunStore;
  private sseClients = new Set<ServerResponse>();
  private htmlCache: string | null = null;

  constructor(opts: DashboardServerOptions) {
    this.orchestrator = opts.orchestrator;
    this.port = opts.port ?? getConfig().server.port;
    this.host = opts.host ?? getConfig().server.host;
    this.runStore = opts.runStore;
  }

  async start(): Promise<{ port: number; host: string }> {
    this.htmlCache = await readFile(join(__dirname, "dashboard.html"), "utf-8");

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("Request handler error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.host = addr.address;
        }
        log.info(`Dashboard running at http://${this.host}:${this.port}`);
        resolve({ port: this.port, host: this.host });
      });
      this.server!.on("error", reject);
    });
  }

  stop(): void {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/") {
      return this.serveDashboard(res);
    }

    if (method === "GET" && pathname === "/api/health") {
      return this.handleHealth(res);
    }

    if (method === "GET" && pathname === "/api/events") {
      return this.handleSSE(req, res);
    }

    if (method === "GET" && pathname === "/api/runs") {
      return this.handleListRuns(res);
    }

    if (method === "POST" && pathname === "/api/runs") {
      return this.handleSubmitGoal(req, res);
    }

    const runMatch = pathname.match(/^\/api\/runs\/(.+)$/);
    if (method === "GET" && runMatch) {
      return this.handleGetRun(res, runMatch[1]);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private serveDashboard(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(this.htmlCache);
  }

  private handleHealth(res: ServerResponse): void {
    const agents = this.orchestrator.agents.list().map((a) => ({
      name: a.name,
      type: a.type,
      description: a.description,
      capabilities: a.capabilities,
    }));
    const gateways = this.orchestrator.gateways.names();
    json(res, 200, { ok: true, agents, gateways });
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":\n\n");

    this.sseClients.add(res);
    req.on("close", () => {
      this.sseClients.delete(res);
    });
  }

  private handleListRuns(res: ServerResponse): void {
    if (this.runStore) {
      json(res, 200, this.runStore.list());
    } else {
      const runs = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      json(res, 200, runs);
    }
  }

  private handleGetRun(res: ServerResponse, runId: string): void {
    const run = this.runs.get(runId) ?? this.runStore?.get(runId);
    if (!run) {
      json(res, 404, { error: "Run not found" });
      return;
    }
    json(res, 200, run);
  }

  private async handleSubmitGoal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const result = SubmitGoalRequestSchema.safeParse(raw);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join("; ");
      json(res, 400, { error: msg });
      return;
    }
    const request: SubmitGoalRequest = result.data;

    const runId = randomUUID();
    const run: RunStatus = {
      runId,
      goal: request.goal,
      state: "thinking",
      steps: [],
      startedAt: Date.now(),
    };

    if (this.runs.size >= getConfig().limits.maxRuns) {
      const oldest = [...this.runs.keys()][0];
      this.runs.delete(oldest);
    }

    this.runs.set(runId, run);
    json(res, 201, { runId, goal: request.goal });

    this.executeRun(runId, request).catch((err) => {
      log.error("Run execution error", { runId, error: String(err) });
    });
  }

  private persistRun(run: RunStatus): void {
    try {
      this.runStore?.update(run);
    } catch (err) {
      log.error("Failed to persist run", { runId: run.runId, error: String(err) });
    }
  }

  private async executeRun(runId: string, request: SubmitGoalRequest): Promise<void> {
    const run = this.runs.get(runId)!;
    this.persistRun(run);

    try {
      this.broadcastSSE({ type: "run:started", runId, goal: request.goal });

      const result = await this.orchestrator.run(
        request.goal,
        {
          maxConcurrency: request.maxConcurrency,
          maxSteps: request.maxSteps,
        },
        {
          onThinking: (stepNumber) => {
            run.state = "thinking";
            this.broadcastSSE({ type: "step:thinking", runId, stepNumber });
          },
          onStepStart: (stepNumber, taskIds, tasks) => {
            run.state = "executing";
            run.steps.push({
              stepNumber,
              tasks: (tasks ?? taskIds.map((id) => ({ id, task: "" }))).map((t) => ({
                id: t.id,
                task: t.task,
                agent: t.agent,
                status: "running" as const,
              })),
            });
            this.broadcastSSE({ type: "step:started", runId, stepNumber, taskIds, tasks });
          },
          onTaskStart: (stepNumber, taskId) => {
            const step = run.steps.find((s) => s.stepNumber === stepNumber);
            const task = step?.tasks.find((t) => t.id === taskId);
            if (task) task.status = "running";
            this.broadcastSSE({ type: "task:started", runId, stepNumber, taskId });
          },
          onTaskEnd: (stepNumber, taskId, taskResult) => {
            const step = run.steps.find((s) => s.stepNumber === stepNumber);
            const task = step?.tasks.find((t) => t.id === taskId);
            if (task) {
              task.status = taskResult.status === "ok" ? "done" : "failed";
              task.result = taskResult;
            }
            this.broadcastSSE({
              type: "task:ended",
              runId,
              stepNumber,
              taskId,
              result: taskResult,
              status: taskResult.status === "ok" ? "done" : "failed",
            });
          },
          onStepEnd: (stepNumber) => {
            this.broadcastSSE({ type: "step:ended", runId, stepNumber });
            this.persistRun(run);
          },
          onFinish: (answer) => {
            run.finalAnswer = answer;
            run.state = "done";
            run.finishedAt = Date.now();
            this.broadcastSSE({
              type: "run:complete",
              runId,
              answer,
              durationMs: run.finishedAt - run.startedAt,
            });
            this.persistRun(run);
          },
          onError: (error) => {
            run.state = "error";
            run.error = error;
            run.finishedAt = Date.now();
            this.broadcastSSE({ type: "run:error", runId, error });
            this.persistRun(run);
          },
        },
      );

      // Sync final state from result
      run.steps = result.steps;
      if (result.finalAnswer && !run.finalAnswer) run.finalAnswer = result.finalAnswer;
      if (result.status === "done" && run.state !== "done") {
        run.state = "done";
        run.finishedAt = run.finishedAt ?? Date.now();
      }
    } catch (err) {
      run.state = "error";
      run.error = String(err);
      run.finishedAt = Date.now();
      this.broadcastSSE({ type: "run:error", runId, error: String(err) });
      this.persistRun(run);
    }
  }

  private broadcastSSE(event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      client.write(data);
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
