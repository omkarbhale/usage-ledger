import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /**
   * Estimated cost in US dollars, as ccusage reports it from model prices. Null when the
   * figures came from the log file, since the ledger does not price tokens itself.
   */
  costUsd: number | null;
  /** Where the figures came from: ccusage, or the session's own log file. */
  source: 'ccusage' | 'log-file';
  /** The model or models the session used, in the order first seen. */
  models: string[];
  /**
   * The effort levels the session's log records, in the order first seen. Absent when the
   * log records none.
   */
  effortLevels?: string[];
}

export interface LookupOptions {
  /** A Claude data folder (holding projects/) or a projects/ folder. Unset: the user's own. */
  logsDir?: string;
  /** Path to ccusage's command-line script. Unset: the pinned dependency. */
  ccusageScript?: string;
}

export class LookupError extends Error {
  constructor(
    readonly code: 'invalid-session-id' | 'logs-not-found' | 'session-not-found',
    message: string,
  ) {
    super(message);
  }
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID.test(id) && !id.includes('..');
}

function ccusageScriptPath(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('ccusage/package.json');
  return join(pkg, '..', 'src', 'cli.js');
}

function toCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

const isCost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** ccusage's estimated cost of one session record: totalCost, else the sum over its models. Null when absent. */
export function costOf(d: Record<string, unknown>): number | null {
  if (isCost(d.totalCost)) return d.totalCost;
  if (!Array.isArray(d.modelBreakdowns)) return null;
  let sum = 0;
  let any = false;
  for (const m of d.modelBreakdowns as Record<string, unknown>[]) {
    if (isCost(m?.cost)) {
      sum += m.cost;
      any = true;
    }
  }
  return any ? sum : null;
}

/** A real model name: Claude Code writes "<synthetic>" for replies no model made. */
function isModelName(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v !== '<synthetic>';
}

/** The models in a ccusage session record: modelsUsed, else the names in modelBreakdowns. */
export function modelsOf(d: Record<string, unknown>): string[] {
  const names: string[] = [];
  const add = (v: unknown) => {
    if (isModelName(v) && !names.includes(v)) names.push(v);
  };
  if (Array.isArray(d.modelsUsed)) d.modelsUsed.forEach(add);
  if (names.length === 0 && Array.isArray(d.modelBreakdowns)) {
    for (const m of d.modelBreakdowns as Record<string, unknown>[]) add(m?.modelName);
  }
  return names;
}

const EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * The effort level one log line records, if any. Not checked against real logs: whether and
 * where Claude Code writes it. Read from a string field named effort or effortLevel, on the
 * line itself or on its message.
 */
export function effortOf(entry: any): string | undefined {
  for (const v of [entry?.effort, entry?.effortLevel, entry?.message?.effort, entry?.message?.effortLevel]) {
    if (typeof v === 'string' && EFFORT.test(v.trim())) return v.trim().toLowerCase();
  }
  return undefined;
}

type CcusageResult = { found: SessionUsage } | { notFound: true } | { failed: string };

function runCcusage(id: string, opts: LookupOptions): Promise<CcusageResult> {
  const script = opts.ccusageScript ?? ccusageScriptPath();
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (opts.logsDir) env.CLAUDE_CONFIG_DIR = opts.logsDir;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'claude', 'session', '--json', '--offline', '--id', id],
      { env, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ failed: (stderr || err.message).trim() });
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(stdout);
        } catch {
          resolve({ failed: 'ccusage gave output that is not JSON' });
          return;
        }
        if (data === null) {
          resolve({ notFound: true });
          return;
        }
        const d = data as Record<string, unknown>;
        if (typeof d !== 'object' || d.sessionId !== id) {
          resolve({ failed: 'ccusage gave a record for a different session' });
          return;
        }
        const usage = {
          sessionId: id,
          inputTokens: toCount(d.inputTokens),
          outputTokens: toCount(d.outputTokens),
          cacheCreationTokens: toCount(d.cacheCreationTokens),
          cacheReadTokens: toCount(d.cacheReadTokens),
        };
        // ccusage's --id record gives totals per model; sum them when top-level counts are absent.
        if (Array.isArray(d.modelBreakdowns) && d.inputTokens === undefined) {
          for (const m of d.modelBreakdowns as Record<string, unknown>[]) {
            usage.inputTokens += toCount(m.inputTokens);
            usage.outputTokens += toCount(m.outputTokens);
            usage.cacheCreationTokens += toCount(m.cacheCreationTokens);
            usage.cacheReadTokens += toCount(m.cacheReadTokens);
          }
        }
        const total =
          usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
        resolve({
          found: {
            ...usage,
            totalTokens: total,
            costUsd: costOf(d),
            source: 'ccusage',
            models: modelsOf(d),
          },
        });
      },
    );
  });
}

/** The folders that may hold projects/<project>/<session-id>.jsonl. */
export function projectDirs(logsDir?: string): string[] {
  const roots = logsDir
    ? [logsDir]
    : [join(homedir(), '.config', 'claude'), join(homedir(), '.claude')];
  const dirs: string[] = [];
  for (const root of roots) {
    const projects = join(root, 'projects');
    if (existsSync(projects) && statSync(projects).isDirectory()) dirs.push(projects);
    else if (logsDir && existsSync(root) && statSync(root).isDirectory()) dirs.push(root);
  }
  return dirs;
}

function findLogFile(dir: string, file: string, depth: number): string | undefined {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && e.name === file) return join(dir, e.name);
  if (depth <= 0) return undefined;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findLogFile(join(dir, e.name), file, depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Fallback (D-5): sum the usage lines of the session's own log file, named after its ID. */
export function readFromLogFile(id: string, logsDir?: string): SessionUsage | undefined {
  const path = logFileOf(id, logsDir);
  if (!path) return undefined;
  const seen = new Set<string>();
  const u = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const models: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const model = entry?.message?.model;
    if (entry?.message?.usage && isModelName(model) && !models.includes(model)) models.push(model);
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    // Claude Code can write the same reply more than once; count each message and request once.
    const msgId = entry?.message?.id;
    const reqId = entry?.requestId;
    if (msgId && reqId) {
      const key = `${msgId}:${reqId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    u.inputTokens += toCount(usage.input_tokens);
    u.outputTokens += toCount(usage.output_tokens);
    u.cacheCreationTokens += toCount(usage.cache_creation_input_tokens);
    u.cacheReadTokens += toCount(usage.cache_read_input_tokens);
  }
  const total = u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  return { sessionId: id, ...u, totalTokens: total, costUsd: null, source: 'log-file', models };
}

/** The session's log file, named after its ID, if it exists. */
function logFileOf(id: string, logsDir?: string): string | undefined {
  for (const dir of projectDirs(logsDir)) {
    const path = findLogFile(dir, `${id}.jsonl`, 2);
    if (path) return path;
  }
  return undefined;
}

/** The effort levels a session's log records, in the order first seen; empty when none. */
export function readEffortLevels(id: string, logsDir?: string): string[] {
  const path = logFileOf(id, logsDir);
  if (!path) return [];
  const levels: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const e = effortOf(entry);
    if (e && !levels.includes(e)) levels.push(e);
  }
  return levels;
}

function withEffort(s: SessionUsage, logsDir?: string): SessionUsage {
  const levels = readEffortLevels(s.sessionId, logsDir);
  return levels.length > 0 ? { ...s, effortLevels: levels } : s;
}

/**
 * One session's tokens by its ID. ccusage first; the session's own log file only when
 * ccusage cannot run or fails.
 */
export async function lookupSession(id: string, opts: LookupOptions = {}): Promise<SessionUsage> {
  if (!isValidSessionId(id)) {
    throw new LookupError(
      'invalid-session-id',
      `Not a valid session ID: "${id}". Use letters, digits, dots, dashes or underscores.`,
    );
  }
  if (opts.logsDir && !existsSync(opts.logsDir)) {
    throw new LookupError('logs-not-found', `Log folder not found: ${opts.logsDir}`);
  }
  const viaCcusage = await runCcusage(id, opts);
  if ('found' in viaCcusage) return withEffort(viaCcusage.found, opts.logsDir);
  if ('failed' in viaCcusage) {
    const fromFile = readFromLogFile(id, opts.logsDir);
    if (fromFile) return withEffort(fromFile, opts.logsDir);
  }
  throw new LookupError('session-not-found', `No session found with ID ${id}.`);
}

/** A session's span in time and its total tokens, used to place it between weekly snapshots. */
export interface SessionSpan {
  sessionId: string;
  project: string | null;
  /** ISO time of the session's first usage record. */
  start: string;
  /** ISO time of its last usage record. */
  end: string;
  totalTokens: number;
  /** ccusage's estimated cost in US dollars. Null or absent when unknown (log-file fallback). */
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** The model or models the session used, in the order first seen. */
  models?: string[];
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function listViaCcusage(opts: LookupOptions): Promise<SessionSpan[] | undefined> {
  const script = opts.ccusageScript ?? ccusageScriptPath();
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  if (opts.logsDir) env.CLAUDE_CONFIG_DIR = opts.logsDir;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'claude', 'session', '--json', '--offline'],
      { env, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        let data: any;
        try {
          data = JSON.parse(stdout);
        } catch {
          return resolve(undefined);
        }
        if (!data || !Array.isArray(data.sessions)) return resolve(undefined);
        const spans: SessionSpan[] = [];
        for (const s of data.sessions) {
          const start = isoOrNull(s?.firstActivity);
          const end = isoOrNull(s?.lastActivity);
          if (typeof s?.sessionId !== 'string' || !start || !end) continue;
          spans.push({
            sessionId: s.sessionId,
            project: typeof s.projectPath === 'string' ? s.projectPath : null,
            start,
            end,
            totalTokens: toCount(s.totalTokens),
            costUsd: costOf(s),
            inputTokens: toCount(s.inputTokens),
            outputTokens: toCount(s.outputTokens),
            cacheCreationTokens: toCount(s.cacheCreationTokens),
            cacheReadTokens: toCount(s.cacheReadTokens),
            models: modelsOf(s),
          });
        }
        resolve(spans);
      },
    );
  });
}

/** Fallback: read every session log file for its first and last usage record and its tokens. */
export function listFromLogFiles(logsDir?: string): SessionSpan[] {
  const spans = new Map<string, SessionSpan>();
  for (const projects of projectDirs(logsDir)) {
    let dirs;
    try {
      dirs = readdirSync(projects, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files;
      try {
        files = readdirSync(join(projects, d.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const id = f.name.slice(0, -'.jsonl'.length);
        if (!isValidSessionId(id) || spans.has(id)) continue;
        const span = spanFromFile(join(projects, d.name, f.name), id, d.name);
        if (span) spans.set(id, span);
      }
    }
  }
  return [...spans.values()];
}

/** One usage record of a session log, counted once per message and request. */
export interface UsageRecord {
  at: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function recordsOfFile(path: string): UsageRecord[] {
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    const at = isoOrNull(entry?.timestamp);
    if (!usage || typeof usage !== 'object' || !at) continue;
    const msgId = entry?.message?.id;
    const reqId = entry?.requestId;
    if (msgId && reqId) {
      const key = `${msgId}:${reqId}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const model = entry?.message?.model;
    records.push({
      at,
      model: isModelName(model) ? model : null,
      inputTokens: toCount(usage.input_tokens),
      outputTokens: toCount(usage.output_tokens),
      cacheCreationTokens: toCount(usage.cache_creation_input_tokens),
      cacheReadTokens: toCount(usage.cache_read_input_tokens),
    });
  }
  return records;
}

/** A session's usage records from its own log file, each with its time. Undefined when there is no file. */
export function readUsageRecords(id: string, logsDir?: string): UsageRecord[] | undefined {
  if (!isValidSessionId(id)) return undefined;
  const path = logFileOf(id, logsDir);
  return path ? recordsOfFile(path) : undefined;
}

/** Sum records into a span's token fields and models. */
export function sumRecords(records: UsageRecord[]) {
  const u = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  const models: string[] = [];
  let start: string | null = null;
  let end: string | null = null;
  for (const r of records) {
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    u.cacheCreationTokens += r.cacheCreationTokens;
    u.cacheReadTokens += r.cacheReadTokens;
    if (r.model && !models.includes(r.model)) models.push(r.model);
    if (!start || r.at < start) start = r.at;
    if (!end || r.at > end) end = r.at;
  }
  u.totalTokens = u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  return { ...u, models, start, end };
}

function spanFromFile(path: string, id: string, project: string): SessionSpan | undefined {
  const { start, end, ...sum } = sumRecords(recordsOfFile(path));
  if (!start || !end) return undefined;
  return { sessionId: id, project, start, end, ...sum, costUsd: null };
}

/** Every session in the logs with its span and tokens: ccusage first, the log files as fallback. */
export async function listSessions(opts: LookupOptions = {}): Promise<SessionSpan[]> {
  const viaCcusage = await listViaCcusage(opts);
  return viaCcusage ?? listFromLogFiles(opts.logsDir);
}
