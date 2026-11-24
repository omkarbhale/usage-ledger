import { DatabaseSync as Database } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

const cost = (usd: number, known: number) => ({
  status: 'estimated',
  estimated: true,
  usd,
  source: 'ccusage',
  knownSessions: known,
  unknownSessions: 0,
});

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-report-')), 'sub', 'ledger.db');
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

async function recordAll() {
  for (const [file, at] of [
    ['week-5.0.json', '2026-11-20T09:59:00Z'],
    ['week-5.5.json', '2026-11-20T10:02:00Z'],
    ['week-10.0.json', '2026-11-22T09:55:00Z'],
    ['week-14.0.json', '2026-11-22T11:35:00Z'],
  ]) {
    expect((await cli(['statusline', '--at', at], readFileSync(join(SL, file), 'utf8'))).code).toBe(0);
  }
}

async function labelAll() {
  expect((await cli(['label', ALPHA, '--task', 'build-api', '--project', 'shop'])).code).toBe(0);
  expect((await cli(['label', GAMMA, '--task', 'build-api'])).code).toBe(0);
  expect((await cli(['label', DELTA, '--task', 'write-docs'])).code).toBe(0);
  expect((await cli(['label', LATE, '--task', 'write-docs'])).code).toBe(0);
}

describe('usage-ledger label', () => {
  it('stores a task and project for a session', async () => {
    const r = await cli(['label', ALPHA, '--task', 'build-api', '--project', 'shop']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Labelled session ${ALPHA}: task "build-api", project "shop".\n`);
    const store = Store.open(db);
    expect(store.labels().get(ALPHA)).toMatchObject({ task: 'build-api', project: 'shop' });
    store.close();
  });

  it('replaces an earlier label and says so', async () => {
    await cli(['label', ALPHA, '--task', 'old', '--project', 'p']);
    const r = await cli(['label', ALPHA, '--task', 'new', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      schemaVersion: 1,
      label: { sessionId: ALPHA, task: 'new', project: null },
      replaced: true,
    });
    const store = Store.open(db);
    expect(store.labels().get(ALPHA)).toMatchObject({ task: 'new', project: null });
    store.close();
  });

  it('trims the task name', async () => {
    const r = await cli(['label', ALPHA, '--task', '  build-api  ']);
    expect(r.out).toContain('task "build-api"');
  });

  it('refuses a bad session ID with a plain message and exit code 2', async () => {
    for (const id of ['bad/id', '../etc', '', 'a b']) {
      const r = await cli(['label', id, '--task', 'x']);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toBe(`Not a valid session ID: "${id}". Use letters, digits, dots, dashes or underscores.\n`);
    }
  });

  it('refuses an empty or missing task name', async () => {
    for (const task of ['', '   ', 'two\nlines', 'x'.repeat(201)]) {
      const r = await cli(['label', ALPHA, '--task', task]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^The task name must not be empty/);
    }
    const missing = await cli(['label', ALPHA]);
    expect(missing.code).toBe(2);
    expect(missing.err).toBe('Give a task name with --task <name>.\n');
  });

  it('refuses an empty project name', async () => {
    const r = await cli(['label', ALPHA, '--task', 'x', '--project', ' ']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^The project name must not be empty/);
  });

  it('gives refusals as JSON under --json and stores nothing', async () => {
    const r = await cli(['label', 'bad/id', '--task', 'x', '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error.code).toBe('invalid-session-id');
    const t = await cli(['label', ALPHA, '--task', '', '--json']);
    expect(JSON.parse(t.out).error.code).toBe('invalid-task');
    const store = Store.open(db);
    expect(store.labels().size).toBe(0);
    store.close();
  });

  it('refuses --task outside label and --by outside report', async () => {
    expect((await cli(['session', ALPHA, '--task', 'x'])).code).toBe(2);
    expect((await cli(['label', ALPHA, '--task', 'x', '--by', 'task'])).code).toBe(2);
  });
});

describe('usage-ledger report', () => {
  it('sums tokens and weekly share per task, with unlabelled sessions last', async () => {
    await recordAll();
    await labelAll();
    const r = await cli(['report', '--by', 'task', '--json']);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out);
    expect(rep.schemaVersion).toBe(1);
    expect(rep.report.by).toBe('task');
    expect(rep.report.window).toEqual({ kind: 'all', from: null, to: null, basis: null, source: null });
    expect(rep.report.groups).toEqual([
      {
        task: 'build-api',
        sessions: 2,
        inputTokens: 1500 + 2000,
        outputTokens: 300 + 1000,
        cacheCreationTokens: 300,
        cacheReadTokens: 9000,
        totalTokens: 11100 + 3000,
        clippedSessions: 0,
        cost: cost(0.033825, 2),
        weekly: {
          status: 'estimated',
          estimated: true,
          weeklyPercent: 2.25,
          overlapping: true,
          knownSessions: 2,
          unknownSessions: 0,
        },
      },
      {
        task: 'write-docs',
        sessions: 2,
        inputTokens: 850,
        outputTokens: 210,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 1060,
        clippedSessions: 0,
        cost: cost(0.0273, 2),
        weekly: {
          status: 'partial',
          estimated: true,
          weeklyPercent: 2.25,
          overlapping: true,
          knownSessions: 1,
          unknownSessions: 1,
        },
      },
      {
        task: null,
        sessions: 1,
        inputTokens: 20,
        outputTokens: 7,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 27,
        clippedSessions: 0,
        cost: cost(0.000825, 1),
        weekly: {
          status: 'estimated',
          estimated: true,
          weeklyPercent: 4.5,
          overlapping: false,
          knownSessions: 1,
          unknownSessions: 0,
        },
      },
    ]);
    expect(rep.report.total).toMatchObject({ sessions: 5, totalTokens: 15187 });
    expect(rep.report.total.weekly).toMatchObject({ weeklyPercent: 9, status: 'partial' });
    expect(rep.report.total.cost).toEqual(cost(0.06195, 5));
  });

  it('defaults to --by task and prints a table', async () => {
    await recordAll();
    await labelAll();
    const r = await cli(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Usage by task, all sessions in the logs\n/);
    expect(r.out).toMatch(/Task\s+Sessions\s+Input\s+Output\s+Cache\s+Total tokens\s+Est\. cost \(USD\)\s+Weekly share/);
    expect(r.out).toMatch(/build-api\s+2\s+3,500\s+1,300\s+9,300\s+14,100\s+\$0\.0338\s+2\.25% \(estimated, overlapping\)/);
    expect(r.out).toMatch(
      /write-docs\s+2\s+850\s+210\s+0\s+1,060\s+\$0\.0273\s+2\.25% \(estimated, overlapping, 1 of 2 sessions unknown\)/,
    );
    expect(r.out).toMatch(/\(unlabelled\)\s+1\s+20\s+7\s+0\s+27\s+\$0\.0008\s+4\.5% \(estimated\)/);
    expect(r.out).toMatch(/Total\s+5\s+4,370\s+1,517\s+9,300\s+15,187\s+\$0\.0620\s+9%/);
    expect(r.out).toContain('Costs are estimates from ccusage');
  });

  it('marks costs unknown when ccusage cannot run, and keeps the tokens', async () => {
    await labelAll();
    const r = await cli(['report', '--json'], '', { ccusageScript: BROKEN_CCUSAGE });
    const g = JSON.parse(r.out).report.groups[0];
    expect(g).toMatchObject({ task: 'build-api', totalTokens: 14100 });
    expect(g.cost).toEqual({
      status: 'unknown',
      estimated: true,
      usd: null,
      source: 'ccusage',
      knownSessions: 0,
      unknownSessions: 2,
    });
    const t = await cli(['report'], '', { ccusageScript: BROKEN_CCUSAGE });
    expect(t.out).toMatch(/build-api\s+2\s+3,500\s+1,300\s+9,300\s+14,100\s+unknown\s+unknown/);
  });

  it('sums per project, using the labelled project over the log folder', async () => {
    await recordAll();
    await labelAll();
    const r = await cli(['report', '--by', 'project', '--json']);
    const groups = JSON.parse(r.out).report.groups;
    expect(groups.map((g: any) => [g.project, g.sessions, g.totalTokens, g.cost.usd])).toEqual([
      ['shop', 1, 11100, 0.012825],
      ['-home-dev-proj-gamma', 3, 4060, 0.0483],
      ['-home-dev-proj-beta', 1, 27, 0.000825],
    ]);
    const t = await cli(['report', '--by', 'project']);
    expect(t.out).toMatch(/^Usage by project, all sessions in the logs\n/);
    expect(t.out).toMatch(/shop\s+1\s+1,500\s+300\s+9,300\s+11,100\s+\$0\.0128\s+0\.5% \(estimated\)/);
  });

  it('never lists or ranks single sessions', async () => {
    await recordAll();
    await labelAll();
    for (const args of [['report'], ['report', '--json'], ['report', '--by', 'project'], ['report', '--by', 'project', '--json']]) {
      const r = await cli(args);
      for (const id of [ALPHA, BETA, GAMMA, DELTA, LATE]) expect(r.out).not.toContain(id);
      expect(r.out).not.toContain('sessionId');
    }
  });

  it('shows the weekly share as unknown when no snapshots exist', async () => {
    await labelAll();
    const r = await cli(['report', '--json']);
    const g = JSON.parse(r.out).report.groups[0];
    expect(g.weekly).toMatchObject({ status: 'unknown', weeklyPercent: null, unknownSessions: 2 });
    const t = await cli(['report']);
    expect(t.out).toMatch(/build-api\s+2\s+3,500\s+1,300\s+9,300\s+14,100\s+\$0\.0338\s+unknown/);
  });

  it('gives the same tokens when ccusage cannot run, and splits overlapping rises by tokens since costs are unknown', async () => {
    await recordAll();
    await labelAll();
    const strip = (rep: any) => ({
      ...rep.report,
      groups: rep.report.groups.map(({ cost: _c, weekly: _w, ...g }: any) => g),
      total: { ...rep.report.total, cost: undefined, weekly: undefined },
    });
    const a = JSON.parse((await cli(['report', '--json'])).out);
    const b = JSON.parse((await cli(['report', '--json'], '', { ccusageScript: BROKEN_CCUSAGE })).out);
    expect(strip(b)).toEqual(strip(a));
    // With no costs, session 3 (3,000 tokens) and session 4 (1,000 tokens) split the 4% rise 3 to 1.
    expect(b.report.groups.map((g: any) => [g.task, g.weekly.weeklyPercent])).toEqual([
      ['build-api', 3.5],
      ['write-docs', 1],
      [null, 4.5],
    ]);
    expect(b.report.total.weekly.weeklyPercent).toBe(a.report.total.weekly.weeklyPercent);
  });

  it('refuses an unknown --by and a missing log folder', async () => {
    const r = await cli(['report', '--by', 'session']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^--by must be task or project, not "session"\./);
    let err = '';
    const code = await run(
      ['report'],
      { USAGE_LEDGER_LOGS: join(tmpdir(), 'usage-ledger-missing-logs'), USAGE_LEDGER_DB: db },
      { out: () => {}, err: (s) => (err += s) },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/^Log folder not found: /);
  });
});

describe('database migration to labels', () => {
  it('backs up a version 1 database before adding the labels table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-migrate-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'ledger.db');
    const old = new Database(path);
    old.exec(
      'CREATE TABLE snapshots (id INTEGER PRIMARY KEY, taken_at TEXT NOT NULL, weekly_percent REAL NOT NULL, resets_at TEXT, session_id TEXT)',
    );
    old.prepare('INSERT INTO snapshots (taken_at, weekly_percent) VALUES (?, ?)').run('2026-11-20T00:00:00.000Z', 3);
    old.exec('PRAGMA user_version = 1');
    old.close();

    const store = Store.open(path);
    store.setLabel({ sessionId: ALPHA, task: 't', project: null, labelledAt: '2026-11-23T00:00:00.000Z' });
    expect(store.snapshotAtOrBefore('2026-11-21T00:00:00.000Z')?.weeklyPercent).toBe(3);
    store.close();
    expect(readdirSync(dir).some((f) => f.startsWith('ledger.db.backup-v1-'))).toBe(true);
  });
});
