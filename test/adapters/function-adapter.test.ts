import { describe, expect, it } from "vitest";
import { FunctionAdapter } from "../../src/agents/function-adapter.js";
import type { TaskNode } from "../../src/planner/types.js";

const makeNode = (task: string): TaskNode => ({
  id: "test-node",
  task,
  dependsOn: [],
  status: "pending",
});

describe("FunctionAdapter", () => {
  it("executes a function and returns result", async () => {
    const adapter = new FunctionAdapter({
      name: "echo",
      fn: async (task) => `echoed: ${task}`,
    });

    const result = await adapter.execute(makeNode("hello"));
    expect(result.status).toBe("ok");
    expect(result.output).toBe("echoed: hello");
  });

  it("returns error on function throw", async () => {
    const adapter = new FunctionAdapter({
      name: "failing",
      fn: async () => {
        throw new Error("boom");
      },
    });

    const result = await adapter.execute(makeNode("hello"));
    expect(result.status).toBe("error");
    expect(result.output).toContain("boom");
  });

  it("returns timeout on slow function", async () => {
    const adapter = new FunctionAdapter({
      name: "slow",
      fn: async () => {
        await new Promise((r) => setTimeout(r, 5_000));
        return "done";
      },
      timeout: 50,
    });

    const result = await adapter.execute(makeNode("hello"));
    expect(result.status).toBe("timeout");
  });

  it("passes task config to function", async () => {
    let receivedConfig: unknown;
    const adapter = new FunctionAdapter({
      name: "config-check",
      fn: async (_task, ctx) => {
        receivedConfig = ctx.config;
        return "ok";
      },
    });

    const node = makeNode("hello");
    node.config = { model: "gpt-4", timeout: 30 };
    await adapter.execute(node);

    expect(receivedConfig).toEqual({ model: "gpt-4", timeout: 30 });
  });

  it("supports streaming output via executeStream", async () => {
    const chunks: string[] = [];
    const adapter = new FunctionAdapter({
      name: "streamer",
      fn: async () => "final result",
      streamFn: async (_task, _ctx, emit) => {
        emit("chunk1");
        emit("chunk2");
        emit("chunk3");
        return "final result";
      },
    });

    expect(adapter.supportsStreaming).toBe(true);

    const result = await adapter.executeStream(makeNode("stream me"), (chunk) => {
      if (chunk.content) chunks.push(chunk.content);
    });

    expect(result.status).toBe("ok");
    expect(result.output).toBe("final result");
    expect(chunks).toEqual(["chunk1", "chunk2", "chunk3"]);
  });

  it("falls back to execute when streamFn not provided", async () => {
    const chunks: string[] = [];
    const adapter = new FunctionAdapter({
      name: "non-streamer",
      fn: async () => "result",
    });

    expect(adapter.supportsStreaming).toBe(false);

    const result = await adapter.executeStream(makeNode("hello"), (chunk) => {
      if (chunk.content) chunks.push(chunk.content);
    });

    expect(result.status).toBe("ok");
    expect(result.output).toBe("result");
    expect(chunks).toEqual(["result"]); // Full output as single chunk
  });
});
