import { randomUUID } from "node:crypto";
import { ValidationError } from "../errors.js";
import type { TaskGraph, TaskNode } from "./types.js";

/** Create a new task graph from a goal and a list of nodes. */
export function createTaskGraph(
  goal: string,
  nodes: Array<Omit<TaskNode, "status" | "result">>,
  synthesizerPrompt?: string,
): TaskGraph {
  const graph: TaskGraph = {
    id: randomUUID(),
    goal,
    nodes: nodes.map((n) => ({ ...n, status: "pending" })),
    synthesizerPrompt,
  };
  validate(graph);
  return graph;
}

/** Validate a task graph: check for missing deps and cycles. */
export function validate(graph: TaskGraph): void {
  const ids = new Set(graph.nodes.map((n) => n.id));

  // Check all dependencies exist
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) {
        throw new ValidationError("GRAPH_INVALID", `Node "${node.id}" depends on unknown node "${dep}"`);
      }
    }
    if (node.dependsOn.includes(node.id)) {
      throw new ValidationError("GRAPH_INVALID", `Node "${node.id}" depends on itself`);
    }
  }

  // Check for cycles via DFS
  if (hasCycle(graph)) {
    throw new ValidationError("GRAPH_INVALID", "Task graph contains a cycle");
  }
}

/** Detect cycles using DFS with coloring. */
function hasCycle(graph: TaskGraph): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of graph.nodes) color.set(node.id, WHITE);

  // Build adjacency: node → its dependents (nodes that depend on it)
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  function dfs(id: string): boolean {
    color.set(id, GRAY);
    for (const next of dependents.get(id) ?? []) {
      const c = color.get(next)!;
      if (c === GRAY) return true; // back edge = cycle
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of graph.nodes) {
    if (color.get(node.id) === WHITE && dfs(node.id)) return true;
  }
  return false;
}

/** Return nodes in topological order (dependencies first). */
export function topologicalSort(graph: TaskGraph): TaskNode[] {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const sorted: TaskNode[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodeMap.get(id)!;
    for (const dep of node.dependsOn) {
      visit(dep);
    }
    sorted.push(node);
  }

  for (const node of graph.nodes) {
    visit(node.id);
  }

  return sorted;
}

/** Get nodes that are ready to execute (all deps satisfied). */
export function readyNodes(graph: TaskGraph): TaskNode[] {
  const done = new Set(
    graph.nodes.filter((n) => n.status === "done").map((n) => n.id),
  );
  return graph.nodes.filter(
    (n) => n.status === "pending" && n.dependsOn.every((d) => done.has(d)),
  );
}

/** Check if all nodes are terminal (done, failed, or skipped). */
export function isComplete(graph: TaskGraph): boolean {
  return graph.nodes.every((n) => n.status === "done" || n.status === "failed" || n.status === "skipped");
}

/** Mark a node and all its transitive dependents as skipped. */
export function skipDownstream(graph: TaskGraph, failedNodeId: string): void {
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = dependents.get(failedNodeId) ?? [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodeMap.get(id)!;
    if (node.status === "pending") {
      node.status = "skipped";
    }
    for (const next of dependents.get(id) ?? []) {
      queue.push(next);
    }
  }
}
