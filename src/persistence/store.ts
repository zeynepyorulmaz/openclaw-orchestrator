import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { RunStatus } from "../ui/types.js";

const DEFAULT_DB_DIR = join(homedir(), ".openclaw-orchestrator");
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, "runs.db");

export class RunStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    if (!dbPath) {
      mkdirSync(DEFAULT_DB_DIR, { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id      TEXT PRIMARY KEY,
        goal        TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'thinking',
        steps       TEXT NOT NULL DEFAULT '[]',
        final_answer TEXT,
        error       TEXT,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
    `);
  }

  insert(run: RunStatus): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO runs (run_id, goal, state, steps, final_answer, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.goal,
      run.state,
      JSON.stringify(run.steps),
      run.finalAnswer ?? null,
      run.error ?? null,
      run.startedAt,
      run.finishedAt ?? null,
    );
  }

  update(run: RunStatus): void {
    this.insert(run);
  }

  get(runId: string): RunStatus | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? rowToRunStatus(row) : undefined;
  }

  list(limit = 50): RunStatus[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(rowToRunStatus);
  }

  /** Delete a specific run by ID. Returns true if deleted. */
  delete(runId: string): boolean {
    const result = this.db.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
    return result.changes > 0;
  }

  /** Delete all runs. Returns count of deleted runs. */
  deleteAll(): number {
    const result = this.db.prepare("DELETE FROM runs").run();
    return result.changes;
  }

  /** Delete runs older than a given timestamp. */
  deleteOlderThan(timestamp: number): number {
    const result = this.db.prepare("DELETE FROM runs WHERE started_at < ?").run(timestamp);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

type RunRow = {
  run_id: string;
  goal: string;
  state: string;
  steps: string;
  final_answer: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
};

function rowToRunStatus(row: RunRow): RunStatus {
  return {
    runId: row.run_id,
    goal: row.goal,
    state: row.state as RunStatus["state"],
    steps: JSON.parse(row.steps),
    finalAnswer: row.final_answer ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}
