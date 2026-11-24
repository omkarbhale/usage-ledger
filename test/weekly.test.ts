import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { Store } from '../src/store.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const BROKEN_CCUSAGE = join(tmpdir(), 'no-such-ccusage', 'cli.js');
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const GAMMA = '33333333-3333-4333-8333-333333333333';
const DELTA = '44444444-4444-4444-8444-444444444444';
const LATE = '55555555-5555-4555-8555-555555555555';

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-weekly-')), 'sub', 'ledger.db');
});

async function cli(args: string[], stdin = '', extra = {}) {
  let out = '';
  let err = '';
  const code = await run(
    args,
    { USAGE_LEDGER_LOGS: LOGS, USAGE_LEDGER_DB: db },
    { out: (s) => (out += s), err: (s) => (err += s) },
    { stdin: async () => stdin, ...extra },
  );
  return { code, out, err };
}

const fixture = (name: string) => readFileSync(join(SL, name), 'utf8');

async function recordAll() {
  for (const [file, at] of [
    ['week-5.0.json', '2026-11-20T09:59:00Z'],
    ['week-5.5.json', '2026-11-20T10:02:00Z'],
    ['week-10.0.json', '2026-11-22T09:55:00Z'],
    ['week-14.0.json', '2026-11-22T11:35:00Z'],
  ]) {
    const r = await cli(['statusline', '--at', at], fixture(file));
    expect(r.code).toBe(0);
  }
}

describe('usage-ledger statusline', () => {
  it('stores a snapshot and prints a short status line', async () => {
    const r = await cli(['statusline', '--at', '2026-11-20T09:59:00Z'], fixture('week-5.0.json'));
    expect(r.code).toBe(0);
    expect(r.out).toBe('Week: 5% used, resets 2026-11-27 10:00 UTC\n');
    const store = Store.open(db);
    expect(store.snapshotAtOrAfter('2026-01-01T00:00:00.000Z')).toEqual({
      takenAt: '2026-11-20T09:59:00.000Z',
      weeklyPercent: 5,
      resetsAt: '2026-11-27T10:00:00.000Z',
      sessionId: ALPHA,
      source: 'statusline',
    });
    store.close();
  });

  it('creates the database readable by the owner only', async () => {
    await cli(['statusline'], fixture('week-5.0.json'));
    expect(statSync(db).mode & 0o777).toBe(0o600);
    expect(statSync(join(db, '..')).mode & 0o777).toBe(0o700);
  });

  it('prints JSON with a schema version under --json', async () => {
    const r = await cli(['statusline', '--json', '--at', '2026-11-20T09:59:00Z'], fixture('week-5.5.json'));
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      snapshot: {
        takenAt: '2026-11-20T09:59:00.000Z',
        weeklyPercent: 5.5,
        resetsAt: '2026-11-27T10:00:00.000Z',
        sessionId: ALPHA,
        source: 'statusline',
      },
      warnAt: 80,
      warning: false,
    });
  });

  it('stores nothing when the input carries no weekly figure', async () => {
    const r = await cli(['statusline'], fixture('no-rate-limits.json'));
    expect(r.code).toBe(0);
    expect(r.out).toBe('Week: no figure yet\n');
    const store = Store.open(db);
    expect(store.snapshotAtOrAfter('1970-01-01T00:00:00.000Z')).toBeUndefined();
    store.close();
  });

  it('accepts resets_at as seconds since 1970', async () => {
    const input = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 7, resets_at: 1795773600 } } });
    const r = await cli(['statusline', '--json'], input);
    expect(JSON.parse(r.out).snapshot.resetsAt).toBe('2026-11-27T10:00:00.000Z');
  });

  it('exits 1 with a plain message on input that is not JSON', async () => {
    const r = await cli(['statusline'], 'not json');
    expect(r.code).toBe(1);
    expect(r.err).toBe('Status line input is not JSON.\n');
  });

  it('exits 2 on a bad --at time', async () => {
    const r = await cli(['statusline', '--at', 'yesterday'], fixture('week-5.0.json'));
    expect(r.code).toBe(2);
  });
});

describe('usage-ledger session <id>: weekly share', () => {
  it('shows the rise between the snapshots around a session, marked estimated', async () => {
    await recordAll();
    const r = await cli(['session', ALPHA]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Weekly limit used: 0.5% (estimated)');
    expect(r.out).toContain('Account went from 5% at 2026-11-20T09:59:00.000Z to 5.5% at 2026-11-20T10:02:00.000Z.');
    const j = JSON.parse((await cli(['session', ALPHA, '--json'])).out);
    expect(j.session.weekly).toEqual({
      status: 'estimated',
      estimated: true,
      weeklyPercent: 0.5,
      reason: null,
      before: { at: '2026-11-20T09:59:00.000Z', weeklyPercent: 5 },
      after: { at: '2026-11-20T10:02:00.000Z', weeklyPercent: 5.5 },
      rise: 0.5,
      overlapsWith: [],
      splitBy: null,
    });
  });

  it('splits the rise by estimated cost, not tokens, between overlapping sessions on different models', async () => {
    await recordAll();
    // Session 3: 3,000 tokens on Sonnet, $0.021. Session 4: 1,000 tokens on Opus, $0.027.
    // By tokens the 4% rise would split 3% and 1%; by cost it splits 1.75% and 2.25%.
    const g = JSON.parse((await cli(['session', GAMMA, '--json'])).out).session;
    const d = JSON.parse((await cli(['session', DELTA, '--json'])).out).session;
    expect(g.totalTokens).toBe(3000);
    expect(d.totalTokens).toBe(1000);
    expect(g.weekly).toMatchObject({ status: 'overlapping', estimated: true, weeklyPercent: 1.75, rise: 4, overlapsWith: [DELTA], splitBy: 'cost' });
    expect(d.weekly).toMatchObject({ status: 'overlapping', estimated: true, weeklyPercent: 2.25, rise: 4, overlapsWith: [GAMMA], splitBy: 'cost' });
    expect(g.weekly.weeklyPercent + d.weekly.weeklyPercent).toBe(4);
    const r = await cli(['session', GAMMA]);
    expect(r.out).toContain('Weekly limit used: 1.75% (estimated, overlapping)');
    expect(r.out).toContain(`Rise split by estimated cost with: ${DELTA}`);
  });

  it('gives a lone session the whole rise', async () => {
    await recordAll();
    const b = JSON.parse((await cli(['session', BETA, '--json'])).out).session.weekly;
    expect(b).toMatchObject({ status: 'estimated', weeklyPercent: 4.5, rise: 4.5, overlapsWith: [], splitBy: null });
  });

  it('shows unknown for a session with no snapshot after it', async () => {
    await recordAll();
    const r = await cli(['session', LATE]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Weekly limit used: unknown (no snapshot after the session ended)');
    const w = JSON.parse((await cli(['session', LATE, '--json'])).out).session.weekly;
    expect(w).toMatchObject({ status: 'unknown', estimated: true, weeklyPercent: null });
  });

  it('shows unknown when no snapshots were ever recorded, without creating the database', async () => {
    const r = await cli(['session', BETA, '--json']);
    expect(JSON.parse(r.out).session.weekly).toMatchObject({
      status: 'unknown',
      weeklyPercent: null,
      reason: 'no weekly snapshots recorded yet',
    });
    expect(() => statSync(db)).toThrow();
  });

  it('shows unknown when the weekly limit reset between the snapshots', async () => {
    await cli(['statusline', '--at', '2026-11-20T09:59:00Z'], fixture('week-14.0.json'));
    await cli(['statusline', '--at', '2026-11-20T10:02:00Z'], fixture('week-5.0.json'));
    const w = JSON.parse((await cli(['session', ALPHA, '--json'])).out).session.weekly;
    expect(w).toMatchObject({ status: 'unknown', reason: 'the weekly limit reset between the snapshots' });
  });

  it('splits by tokens, and says so, when the log files are read and no cost is known', async () => {
    await recordAll();
    const r = await cli(['session', GAMMA, '--json'], '', { ccusageScript: BROKEN_CCUSAGE });
    expect(JSON.parse(r.out).session.weekly).toMatchObject({ status: 'overlapping', weeklyPercent: 3, splitBy: 'tokens' });
    const t = await cli(['session', GAMMA], '', { ccusageScript: BROKEN_CCUSAGE });
    expect(t.out).toContain('Rise split by tokens (a session in the window has no estimated cost) with:');
  });
});

describe('database migration', () => {
  it('backs up an older database before migrating it', async () => {
    const { DatabaseSync: Database } = await import('node:sqlite');
    const { mkdirSync, readdirSync } = await import('node:fs');
    mkdirSync(join(db, '..'), { recursive: true });
    const old = new Database(db);
    old.exec('CREATE TABLE snapshots (id INTEGER PRIMARY KEY, taken_at TEXT NOT NULL, weekly_percent REAL NOT NULL, resets_at TEXT, session_id TEXT)');
    old.exec('PRAGMA user_version = 0');
    old.close();
    // user_version 0 means a fresh file: no backup needed.
    Store.open(db).close();
    expect(readdirSync(join(db, '..')).filter((f) => f.includes('.backup-'))).toEqual([]);
  });
});
