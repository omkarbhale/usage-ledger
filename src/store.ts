import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | undefined;

/**
 * Node's built-in SQLite, loaded on first use. Node 22 flags it experimental and prints a
 * warning on load; that one warning is dropped so a status line or JSON reader sees none.
 */
function loadSqlite(): SqliteModule {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    const text = typeof w === 'string' ? w : w?.message;
    if (/SQLite is an experimental feature/i.test(String(text))) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

/** Run fn in one write transaction (BEGIN IMMEDIATE), rolling back if it throws. */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** The schema version this code writes. Raise it with each migration below. */
export const DB_SCHEMA_VERSION = 5;

const MIGRATIONS: Record<number, string | ((db: DatabaseSync) => void)> = {
  1: `CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        taken_at TEXT NOT NULL,
        weekly_percent REAL NOT NULL,
        resets_at TEXT,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS snapshots_taken_at ON snapshots (taken_at);`,
  2: `CREATE TABLE IF NOT EXISTS labels (
        session_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        project TEXT,
        labelled_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS labels_task ON labels (task);`,
  3: `CREATE TABLE IF NOT EXISTS budgets (
        scope TEXT NOT NULL CHECK (scope IN ('task', 'week')),
        task TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL CHECK (unit IN ('tokens', 'percent')),
        limit_value REAL NOT NULL,
        set_at TEXT NOT NULL,
        PRIMARY KEY (scope, task, unit)
      );`,
  // Where each weekly reading came from. Rows from before this were all status line input.
  4: (db) => {
    const cols = db.prepare('PRAGMA table_info(snapshots)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'source')) return;
    db.exec(`ALTER TABLE snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'statusline'
        CHECK (source IN ('statusline', 'manual'))`);
  },
  // Budgets per project, and in dollars. SQLite cannot widen a CHECK in place, so the table
  // is rebuilt and its rows copied; the task column now holds the task or project name.
  5: `CREATE TABLE budgets_v5 (
        scope TEXT NOT NULL CHECK (scope IN ('task', 'project', 'week')),
        task TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL CHECK (unit IN ('tokens', 'percent', 'dollars')),
        limit_value REAL NOT NULL,
        set_at TEXT NOT NULL,
        PRIMARY KEY (scope, task, unit)
      );
      INSERT INTO budgets_v5 (scope, task, unit, limit_value, set_at)
        SELECT scope, task, unit, limit_value, set_at FROM budgets;
      DROP TABLE budgets;
      ALTER TABLE budgets_v5 RENAME TO budgets;`,
};

/** Where a weekly reading came from: Claude Code's status line, or typed in by hand. */
export type SnapshotSource = 'statusline' | 'manual';

export type BudgetScope = 'task' | 'project' | 'week';
export type BudgetUnit = 'tokens' | 'percent' | 'dollars';

export interface Budget {
  scope: BudgetScope;
  /** The task for a task budget; null otherwise. */
  task: string | null;
  /** The project for a project budget; null otherwise. */
  project: string | null;
  unit: BudgetUnit;
  /** Tokens, percent of the weekly limit, or US dollars. */
  limit: number;
  /** ISO time the budget was set. */
  setAt: string;
}

export interface Label {
  sessionId: string;
  task: string;
  /** The project the orchestrator named, if any. Unset: the project from the logs. */
  project: string | null;
  /** ISO time the label was stored. */
  labelledAt: string;
}

export interface Snapshot {
  /** ISO time the snapshot was taken. */
  takenAt: string;
  /** The account's weekly percentage used, 0 to 100. */
  weeklyPercent: number;
  /** When the weekly limit resets, ISO, if the status line gave it. */
  resetsAt: string | null;
  /** The session whose status line gave the figure, if known. */
  sessionId: string | null;
  /** Where the reading came from. Both count the same. */
  source: SnapshotSource;
}

export function dbPath(env: NodeJS.ProcessEnv): string {
  return env.USAGE_LEDGER_DB || join(homedir(), '.usage-ledger', 'ledger.db');
}

/** Files this process creates are readable by the owner only. */
function ownerOnly<T>(fn: () => T): T {
  const old = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(old);
  }
}

function migrate(db: DatabaseSync, path: string): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current >= DB_SCHEMA_VERSION) return;
  if (current > 0) {
    // Back up stored data before changing its schema.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    ownerOnly(() => copyFileSync(path, `${path}.backup-v${current}-${Date.now()}`));
  }
  inTransaction(db, () => {
    for (let v = current + 1; v <= DB_SCHEMA_VERSION; v++) {
      const m = MIGRATIONS[v];
      if (typeof m === 'string') db.exec(m);
      else m(db);
    }
    db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`);
  });
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open for writing, creating the folder and file (owner only) and migrating as needed. */
  static open(path: string): Store {
    return ownerOnly(() => {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const db = new (loadSqlite().DatabaseSync)(path);
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      migrate(db, path);
      return new Store(db);
    });
  }

  /** Open an existing database for reading. Undefined when there is none yet. */
  static openIfExists(path: string): Store | undefined {
    if (!existsSync(path)) return undefined;
    return Store.open(path);
  }

  addSnapshot(s: Snapshot): void {
    this.db
      .prepare(
        'INSERT INTO snapshots (taken_at, weekly_percent, resets_at, session_id, source) VALUES (?, ?, ?, ?, ?)',
      )
      .run(s.takenAt, s.weeklyPercent, s.resetsAt, s.sessionId, s.source);
  }

  /** The last snapshot taken at or before the time. */
  snapshotAtOrBefore(iso: string): Snapshot | undefined {
    return this.row(
      this.db
        .prepare('SELECT * FROM snapshots WHERE taken_at <= ? ORDER BY taken_at DESC, id DESC LIMIT 1')
        .get(iso),
    );
  }

  /** The first snapshot taken at or after the time. */
  snapshotAtOrAfter(iso: string): Snapshot | undefined {
    return this.row(
      this.db
        .prepare('SELECT * FROM snapshots WHERE taken_at >= ? ORDER BY taken_at ASC, id ASC LIMIT 1')
        .get(iso),
    );
  }

  /** The most recent snapshot. */
  latestSnapshot(): Snapshot | undefined {
    return this.row(
      this.db.prepare('SELECT * FROM snapshots ORDER BY taken_at DESC, id DESC LIMIT 1').get(),
    );
  }

  /** The most recent snapshot that gives the weekly reset time. */
  latestSnapshotWithReset(): Snapshot | undefined {
    return this.row(
      this.db
        .prepare('SELECT * FROM snapshots WHERE resets_at IS NOT NULL ORDER BY taken_at DESC, id DESC LIMIT 1')
        .get(),
    );
  }

  /** Store a budget, replacing one with the same scope, task and unit. True when it replaced one. */
  setBudget(b: Budget): boolean {
    const task = b.task ?? b.project ?? '';
    return inTransaction(this.db, () => {
      const had = this.db
        .prepare('SELECT 1 FROM budgets WHERE scope = ? AND task = ? AND unit = ?')
        .get(b.scope, task, b.unit);
      this.db
        .prepare(
          `INSERT INTO budgets (scope, task, unit, limit_value, set_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (scope, task, unit) DO UPDATE SET
             limit_value = excluded.limit_value, set_at = excluded.set_at`,
        )
        .run(b.scope, task, b.unit, b.limit, b.setAt);
      return had !== undefined;
    });
  }

  /** Remove budgets for a scope (and task or project name), in one unit or all. Returns how many were removed. */
  removeBudgets(scope: BudgetScope, task: string | null, unit?: BudgetUnit): number {
    const r = unit
      ? this.db
          .prepare('DELETE FROM budgets WHERE scope = ? AND task = ? AND unit = ?')
          .run(scope, task ?? '', unit)
      : this.db.prepare('DELETE FROM budgets WHERE scope = ? AND task = ?').run(scope, task ?? '');
    return Number(r.changes);
  }

  /** Every budget: the week first, then projects, then tasks, each by name. */
  budgets(): Budget[] {
    const rows = this.db
      .prepare("SELECT * FROM budgets ORDER BY CASE scope WHEN 'week' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, task, unit")
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      scope: r.scope as BudgetScope,
      task: r.scope === 'task' ? String(r.task) : null,
      project: r.scope === 'project' ? String(r.task) : null,
      unit: r.unit as BudgetUnit,
      limit: Number(r.limit_value),
      setAt: String(r.set_at),
    }));
  }

  /** Store a session's label, replacing any earlier one. True when it replaced one. */
  setLabel(l: Label): boolean {
    return inTransaction(this.db, () => {
      const had = this.db.prepare('SELECT 1 FROM labels WHERE session_id = ?').get(l.sessionId);
      this.db
        .prepare(
          `INSERT INTO labels (session_id, task, project, labelled_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE SET
             task = excluded.task, project = excluded.project, labelled_at = excluded.labelled_at`,
        )
        .run(l.sessionId, l.task, l.project, l.labelledAt);
      return had !== undefined;
    });
  }

  /** Every label, keyed by session ID. */
  labels(): Map<string, Label> {
    const out = new Map<string, Label>();
    for (const r of this.db.prepare('SELECT * FROM labels').all() as Record<string, unknown>[]) {
      out.set(String(r.session_id), {
        sessionId: String(r.session_id),
        task: String(r.task),
        project: (r.project as string | null) ?? null,
        labelledAt: String(r.labelled_at),
      });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }

  private row(r: unknown): Snapshot | undefined {
    if (!r) return undefined;
    const x = r as Record<string, unknown>;
    return {
      takenAt: String(x.taken_at),
      weeklyPercent: Number(x.weekly_percent),
      resetsAt: (x.resets_at as string | null) ?? null,
      sessionId: (x.session_id as string | null) ?? null,
      source: x.source === 'manual' ? 'manual' : 'statusline',
    };
  }
}
