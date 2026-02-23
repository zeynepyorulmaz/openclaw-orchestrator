#!/usr/bin/env node

import { Command } from "commander";
import { OpenClawAdapter } from "./agents/openclaw-adapter.js";
import { getConfig } from "./config.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});
import { Orchestrator } from "./orchestrator.js";
import { RunStore } from "./persistence/store.js";
import { DashboardServer } from "./ui/server.js";
import { setLogLevel } from "./utils/logger.js";

const program = new Command();

program
  .name("openclaw-orchestrator")
  .description("Meta-orchestration layer for OpenClaw gateways")
  .version("0.1.0")
  .option("--debug", "Enable debug logging");

program.hook("preAction", (_cmd, actionCmd) => {
  const opts = actionCmd.optsWithGlobals();
  if (opts.debug) setLogLevel("debug");
});

const argv = process.argv.slice(2);
const dashIdx = argv.indexOf("--");
if (dashIdx !== -1 && dashIdx < argv.length - 1) {
  argv.splice(dashIdx, 1);
  process.argv = [process.argv[0], process.argv[1], ...argv];
}

function defaultDashboardUrl(): string {
  const { host, port } = getConfig().server;
  return `http://${host}:${port}`;
}

async function isDashboardUp(baseUrl: string, timeoutMs = getConfig().timeouts.healthCheck): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

async function runViaDashboard(
  baseUrl: string,
  goal: string,
  opts: { maxConcurrency?: number },
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal,
      maxConcurrency: opts.maxConcurrency ?? getConfig().limits.maxConcurrency,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Dashboard returned ${res.status}: ${t.slice(0, 200)}`);
  }
  const { runId } = (await res.json()) as { runId: string };
  while (true) {
    await new Promise((r) => setTimeout(r, getConfig().cli.pollIntervalMs));
    const runRes = await fetch(`${base}/api/runs/${runId}`);
    if (!runRes.ok) throw new Error(`Failed to get run: ${runRes.status}`);
    const run = (await runRes.json()) as {
      state: string;
      finalAnswer?: string;
      steps?: Array<{
        stepNumber: number;
        tasks: Array<{ id: string; status: string; task: string; result?: { output?: string } }>;
      }>;
      error?: string;
      startedAt: number;
      finishedAt?: number;
    };
    if (run.state === "done") {
      console.log("\n--- Result ---");
      if (run.finalAnswer) {
        console.log(run.finalAnswer);
      } else if (run.steps) {
        for (const step of run.steps) {
          console.log(`\n  Step ${step.stepNumber}:`);
          for (const task of step.tasks) {
            console.log(`    [${task.status}] ${task.id}: ${task.result?.output?.slice(0, 200) ?? "—"}`);
          }
        }
      }
      const durationMs = (run.finishedAt ?? Date.now()) - run.startedAt;
      console.log(`\nCompleted in ${durationMs}ms (${run.steps?.length ?? 0} steps)`);
      return;
    }
    if (run.state === "error") {
      console.error("Run failed:", run.error ?? "Unknown error");
      process.exitCode = 1;
      return;
    }
  }
}

// --- run ---
program
  .command("run")
  .description("Run the adaptive agent loop to accomplish a goal")
  .argument("<goal>", "The goal to accomplish")
  .option("-g, --gateway <url...>", "Gateway URLs (ws://host:port)")
  .option("-n, --name <name...>", "Gateway names (paired with --gateway)")
  .option("-t, --token <token...>", "Gateway tokens (paired with --gateway)")
  .option("-d, --dashboard <url>", "Use dashboard at URL (default: auto from config)")
  .option("--no-dashboard", "Do not try dashboard; connect to gateway directly")
  .option("-c, --concurrency <n>", "Max parallel tasks", String(getConfig().limits.maxConcurrency))
  .option("-s, --max-steps <n>", "Max orchestrator steps", String(getConfig().limits.maxSteps))
  .action(async (goal: string, opts) => {
    const tryDashboard = opts.dashboard !== false;
    const url = typeof opts.dashboard === "string" && opts.dashboard ? opts.dashboard : defaultDashboardUrl();

    if (tryDashboard) {
      if (await isDashboardUp(url)) {
        try {
          console.error("Using dashboard at", url);
          await runViaDashboard(url, goal, {
            maxConcurrency: Number(opts.concurrency),
          });
          return;
        } catch (err) {
          console.error("Run failed:", err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
          return;
        }
      }
    }

    if (tryDashboard) console.error("Dashboard not reachable, connecting to gateway...");
    const orch = buildOrchestrator(opts);
    await discoverAndRegisterAgents(orch);
    try {
      const result = await orch.run(goal, {
        maxConcurrency: Number(opts.concurrency),
        maxSteps: Number(opts.maxSteps),
      });

      console.log("\n--- Result ---");
      if (result.finalAnswer) {
        console.log(result.finalAnswer);
      } else {
        for (const step of result.steps) {
          console.log(`\n  Step ${step.stepNumber}:`);
          for (const task of step.tasks) {
            console.log(`    [${task.status}] ${task.id}: ${task.result?.output?.slice(0, 200) ?? "—"}`);
          }
        }
      }
      const durationMs = (result.finishedAt ?? Date.now()) - result.startedAt;
      console.log(`\nCompleted in ${durationMs}ms (${result.steps.length} steps, ${result.status})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Run failed:", msg);
      process.exitCode = 1;
    } finally {
      orch.shutdown();
    }
  });

// --- plan ---
program
  .command("plan")
  .description("Preview the first step the orchestrator would take (dry-run)")
  .argument("<goal>", "The goal to decompose")
  .option("-g, --gateway <url...>", "Gateway URLs")
  .option("-n, --name <name...>", "Gateway names")
  .option("-t, --token <token...>", "Gateway tokens (paired with --gateway)")
  .action(async (goal: string, opts) => {
    const orch = buildOrchestrator(opts);
    await discoverAndRegisterAgents(orch);
    try {
      const action = await orch.plan(goal);
      console.log(JSON.stringify(action, null, 2));
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orch.shutdown();
    }
  });

// --- gateways ---
const gw = program.command("gateways").description("Manage gateway connections");

gw.command("health")
  .description("Check health of all registered gateways")
  .option("-g, --gateway <url...>", "Gateway URLs")
  .option("-n, --name <name...>", "Gateway names")
  .option("-t, --token <token...>", "Gateway tokens (paired with --gateway)")
  .action(async function (this: { opts: () => { gateway?: string[]; name?: string[]; token?: string[] } }) {
    const opts = this.opts();
    const urls = opts?.gateway ?? [];
    if (urls.length === 0) {
      console.log("No gateways configured. Use -g <url> and -t <token> to add one.");
      return;
    }
    const orch = buildOrchestrator(opts ?? {});
    try {
      const results = await orch.gateways.healthCheck();
      if (results.length === 0) {
        console.log("No gateways configured (healthCheck returned none).");
        return;
      }
      for (const r of results) {
        const icon = r.status === "healthy" ? "+" : "x";
        console.log(`[${icon}] ${r.name} (${r.url}) — ${r.status}${r.latencyMs != null ? ` ${r.latencyMs}ms` : ""}${r.serverVersion ? ` v${r.serverVersion}` : ""}${r.error ? ` (${r.error})` : ""}`);
      }
    } catch (err) {
      console.error("Health check failed:", err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orch.shutdown();
    }
  });

// --- agents ---
program
  .command("agents")
  .description("List registered agents")
  .option("-g, --gateway <url...>", "Gateway URLs")
  .option("-n, --name <name...>", "Gateway names")
  .option("-t, --token <token...>", "Gateway tokens (paired with --gateway)")
  .action(async (opts) => {
    const orch = buildOrchestrator(opts);
    for (const agent of orch.agents.list()) {
      console.log(`${agent.name} (${agent.type})${agent.capabilities?.length ? ` [${agent.capabilities.join(", ")}]` : ""}`);
    }
    orch.shutdown();
  });

// --- serve ---
program
  .command("serve")
  .description("Start the web dashboard for orchestration monitoring")
  .option("-g, --gateway <url...>", "Gateway URLs (ws://host:port)")
  .option("-n, --name <name...>", "Gateway names (paired with --gateway)")
  .option("-t, --token <token...>", "Gateway tokens (paired with --gateway)")
  .option("-p, --port <port>", "Dashboard port", String(getConfig().server.port))
  .option("--host <host>", "Dashboard host", getConfig().server.host)
  .action(async (opts) => {
    const orch = buildOrchestrator(opts);
    const gwNames = orch.gateways.names();
    if (gwNames.length > 0) {
      try {
        await orch.gateways.pick();
        console.log("Gateway connection ready.");
        await discoverAndRegisterAgents(orch);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Could not connect to gateway:", msg);
        console.error("    Runs will fail until the gateway is reachable and the token is valid.\n");
      }
    }

    const runStore = new RunStore();
    const dashboard = new DashboardServer({
      orchestrator: orch,
      port: Number(opts.port),
      host: opts.host,
      runStore,
    });

    const addr = await dashboard.start();
    console.log(`Dashboard: http://${addr.host}:${addr.port}`);
    console.log(`Gateways:  ${gwNames.join(", ") || "(none)"}`);
    console.log(`Agents:    ${orch.agents.names().join(", ") || "(none)"}`);
    if (gwNames.length === 0) {
      console.log("\n  No gateways configured. Runs will fail until you restart with -g and -t, e.g.:");
      console.log("    serve -g 'ws://host:port/' -t YOUR_TOKEN\n");
    }
    console.log("Press Ctrl+C to stop.\n");

    process.on("SIGINT", () => {
      dashboard.stop();
      runStore.close();
      orch.shutdown();
      process.exit(0);
    });
  });

function buildOrchestrator(opts: { gateway?: string[]; name?: string[]; token?: string[] }): Orchestrator {
  const orch = new Orchestrator();
  const urls = opts.gateway ?? [];
  const names = opts.name ?? [];
  const tokens = opts.token ?? [];

  for (let i = 0; i < urls.length; i++) {
    const name = names[i] ?? `gw-${i}`;
    const config = { name, url: urls[i], token: tokens[i] };
    orch.addGateway(config);
    // Register a fallback agent per gateway (will be replaced by discovery)
    orch.addAgent(
      new OpenClawAdapter({
        name,
        client: orch.gateways.get(name)!,
        capabilities: ["general"],
      }),
    );
  }

  return orch;
}

/** Connect to gateways and discover their registered agents (metadata loaded from SOUL.md). */
async function discoverAndRegisterAgents(orch: Orchestrator): Promise<void> {
  for (const gwName of orch.gateways.names()) {
    const client = orch.gateways.get(gwName)!;
    try {
      await client.connect();
      const agents = await client.discoverAgents();
      if (agents.length > 0) {
        // Remove the fallback agent for this gateway
        orch.agents.remove(gwName);
        for (const agent of agents) {
          const adapterName = orch.gateways.names().length > 1
            ? `${gwName}/${agent.name}`
            : agent.name;
          // Skip if already registered (e.g. duplicate names)
          if (orch.agents.get(adapterName)) continue;

          orch.addAgent(
            new OpenClawAdapter({
              name: adapterName,
              client,
              agentId: agent.id,
              description: agent.description,
              capabilities: agent.capabilities?.length ? agent.capabilities : ["general"],
              rolePrompt: agent.rolePrompt,
            }),
          );
        }
        console.log(`Discovered ${agents.length} agent(s) from ${gwName}: ${agents.map((a) => a.name).join(", ")}`);
      }
    } catch (err) {
      console.error(`Could not discover agents from ${gwName}: ${err instanceof Error ? err.message : String(err)}`);
      // Keep the fallback agent
    }
  }
}

(async () => {
  try {
    await program.parseAsync();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})().catch(() => {});
