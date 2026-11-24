import { DatabaseSync as Database } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const BROKEN_CCUSAGE = join(tmpdir(), 'no-such-ccusage', 'cli.js');
const ALPHA = '11111111-1111-4111-8111-111111111111';
const GAMMA = '33333333-3333-4333-8333-333333333333';
const DELTA = '44444444-4444-4444-8444-444444444444';
const LATE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-23T12:00:00Z');

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-budgets-')), 'sub', 'ledger.db');
});

async function cli(args: string[], stdin = '', extra: Record<string, unknown> = {}) {
  let out = '';
  let err = '';
  const code = await run(
    args,
    { USAGE_LEDGER_LOGS: LOGS, USAGE_LEDGER_DB: db },
    { out: (s) => (out += s), err: (s) => (err += s) },
    { stdin: async () => stdin, now: () => NOW, ...extra },
  );
  return { code, out, err };
}

async function setup() {
  for (const [file, at] of [
    ['week-5.0.json', '2026-11-20T09:59:00Z'],
    ['week-5.5.json', '2026-11-20T10:02:00Z'],
    ['week-10.0.json', '2026-11-22T09:55:00Z'],
    ['week-14.0.json', '2026-11-22T11:35:00Z'],
  ]) {
    expect((await cli(['statusline', '--at', at], readFileSync(join(SL, file), 'utf8'))).code).toBe(0);
  }
  expect((await cli(['label', ALPHA, '--task', 'build-api'])).code).toBe(0);
  expect((await cli(['label', GAMMA, '--task', 'build-api'])).code).toBe(0);
  expect((await cli(['label', DELTA, '--task', 'write-docs'])).code).toBe(0);
  expect((await cli(['label', LATE, '--task', 'write-docs'])).code).toBe(0);
}

async function budgetsJson(extra: Record<string, unknown> = {}) {
  const r = await cli(['budgets', '--json'], '', extra);
  return { code: r.code, data: JSON.parse(r.out) };
}

describe('usage-ledger budget set', () => {
  it('stores a task budget in tokens and a week budget in percent', async () => {
    const a = await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    expect(a.code).toBe(0);
    expect(a.out).toBe('Set budget for task "build-api": 20,000 tokens.\n');
    const b = await cli(['budget', 'set', '--week', '--percent', '50', '--json']);
    expect(b.code).toBe(0);
    expect(JSON.parse(b.out)).toMatchObject({
      schemaVersion: 1,
      budget: { scope: 'week', task: null, unit: 'percent', limit: 50 },
      replaced: false,
    });
  });

  it('replaces a budget with the same task and unit, and says so', async () => {
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    const r = await cli(['budget', 'set', '--task', 'build-api', '--tokens', '5000']);
    expect(r.out).toBe('Replaced budget for task "build-api": 5,000 tokens.\n');
    const { data } = await budgetsJson();
    expect(data.budgets).toHaveLength(1);
    expect(data.budgets[0].limit).toBe(5000);
  });

  it('holds a tokens and a percent budget for the same task side by side', async () => {
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    await cli(['budget', 'set', '--task', 'build-api', '--percent', '10']);
    const { data } = await budgetsJson();
    expect(data.budgets.map((b: any) => b.unit).sort()).toEqual(['percent', 'tokens']);
  });

  it('refuses bad input with exit code 2 and stores nothing', async () => {
    for (const args of [
      ['budget', 'set', '--tokens', '100'],
      ['budget', 'set', '--task', 'x', '--week', '--tokens', '100'],
      ['budget', 'set', '--task', 'x'],
      ['budget', 'set', '--task', 'x', '--tokens', '1', '--percent', '1'],
      ['budget', 'set', '--task', 'x', '--tokens', '0'],
      ['budget', 'set', '--task', 'x', '--tokens', '1.5'],
      ['budget', 'set', '--task', 'x', '--tokens', '-3'],
      ['budget', 'set', '--week', '--percent', '0'],
      ['budget', 'set', '--week', '--percent', '101'],
      ['budget', 'set', '--week', '--percent', 'lots'],
      ['budget', 'set', '--task', '  ', '--tokens', '100'],
      ['budget', 'frob', '--week'],
      ['budget'],
    ]) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).not.toBe('');
    }
    const r = await cli(['budget', 'set', '--week', '--percent', '101', '--json']);
    expect(JSON.parse(r.out).error.code).toBe('invalid-limit');
    expect((await budgetsJson()).data.budgets).toEqual([]);
  });

  it('refuses budget options on other commands', async () => {
    expect((await cli(['label', ALPHA, '--task', 'x', '--week'])).code).toBe(2);
    expect((await cli(['budgets', '--tokens', '5'])).code).toBe(2);
    expect((await cli(['budget', 'set', '--week', '--percent', '5', '--project', 'p'])).code).toBe(2);
  });

  it('removes a task or week budget', async () => {
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    await cli(['budget', 'set', '--task', 'build-api', '--percent', '10']);
    await cli(['budget', 'set', '--week', '--percent', '50']);
    const r = await cli(['budget', 'remove', '--task', 'build-api']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('Removed 2 budgets for task "build-api".\n');
    expect((await cli(['budget', 'remove', '--task', 'build-api'])).out).toBe('No budget set for task "build-api".\n');
    const { data } = await budgetsJson();
    expect(data.budgets).toHaveLength(1);
    expect(data.budgets[0].scope).toBe('week');
  });
});

describe('usage-ledger budgets', () => {
  it('lists each budget with its use, and exits 3 when one is incomplete', async () => {
    await setup();
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    await cli(['budget', 'set', '--task', 'write-docs', '--percent', '3']);
    await cli(['budget', 'set', '--week', '--percent', '50']);
    await cli(['budget', 'set', '--week', '--tokens', '100000']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(3);
    expect(data.schemaVersion).toBe(1);
    expect(data.anyUsedUp).toBe(false);
    expect(data.anyIncomplete).toBe(true);
    expect(data.week).toMatchObject({
      from: '2026-11-20T10:00:00.000Z',
      to: '2026-11-27T10:00:00.000Z',
      fromResetTime: true,
      weeklyPercent: 14,
      asOf: '2026-11-22T11:35:00.000Z',
    });
    const byKey = Object.fromEntries(data.budgets.map((b: any) => [`${b.scope}:${b.task}:${b.unit}`, b]));
    expect(byKey['task:build-api:tokens']).toMatchObject({
      limit: 20000,
      used: 14100,
      remaining: 5900,
      status: 'ok',
      usedUp: false,
      estimated: false,
      sessions: 2,
    });
    expect(byKey['task:write-docs:percent']).toMatchObject({
      limit: 3,
      used: 2.25,
      status: 'incomplete',
      estimated: true,
      sessions: 2,
      unknownSessions: 1,
    });
    expect(byKey['week:null:percent']).toMatchObject({ limit: 50, used: 14, status: 'ok' });
    expect(byKey['week:null:tokens']).toMatchObject({ used: 15187, sessions: 5, status: 'ok' });
  });

  it('marks a budget past its limit used up and exits 1, as a table and as JSON', async () => {
    await setup();
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '10000']);
    await cli(['budget', 'set', '--week', '--percent', '50']);
    const t = await cli(['budgets']);
    expect(t.code).toBe(1);
    expect(t.out).toContain("Budgets (week 2026-11-20 10:00 UTC to 2026-11-27 10:00 UTC, from the status line reading's reset time)");
    expect(t.out).toMatch(/task build-api\s+10,000 tokens\s+14,100 tokens\s+USED UP/);
    expect(t.out).toMatch(/week\s+50%\s+14% \(as of 2026-11-22 11:35 UTC\)\s+ok/);
    expect(t.out).toContain('1 of 2 budgets used up.');
    const { code, data } = await budgetsJson();
    expect(code).toBe(1);
    expect(data.anyUsedUp).toBe(true);
    const up = data.budgets.filter((b: any) => b.usedUp);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ scope: 'task', task: 'build-api', status: 'used-up', remaining: -4100 });
  });

  it('marks a week percent budget used up from the last snapshot', async () => {
    await setup();
    await cli(['budget', 'set', '--week', '--percent', '12.5']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(1);
    expect(data.budgets[0]).toMatchObject({ used: 14, status: 'used-up', remaining: -1.5 });
  });

  it('is used up at exactly the limit, not only above it', async () => {
    await setup();
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '14100']);
    const t = await cli(['budgets']);
    expect(t.code).toBe(1);
    expect(t.out).toMatch(/task build-api\s+14,100 tokens\s+14,100 tokens\s+USED UP/);
    const { data } = await budgetsJson();
    expect(data.budgets[0]).toMatchObject({ used: 14100, remaining: 0, status: 'used-up', usedUp: true });
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '14101']);
    expect((await cli(['budgets'])).code).toBe(0);
  });

  it('is used up at exactly the limit for a week percent budget too', async () => {
    await setup();
    await cli(['budget', 'set', '--week', '--percent', '14']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(1);
    expect(data.budgets[0]).toMatchObject({ used: 14, remaining: 0, status: 'used-up' });
  });

  it('shows use as incomplete, not used up, when there is no weekly figure, and exits 3', async () => {
    await cli(['budget', 'set', '--week', '--percent', '1']);
    await cli(['budget', 'set', '--task', 'build-api', '--percent', '1']);
    await cli(['label', ALPHA, '--task', 'build-api']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(3);
    expect(data.budgets.map((b: any) => b.status)).toEqual(['incomplete', 'incomplete']);
    expect(data.budgets[0]).toMatchObject({ used: null, reason: 'no weekly reading recorded yet' });
    expect(data.budgets[1]).toMatchObject({ used: 0, sessions: 1, unknownSessions: 1 });
    const t = await cli(['budgets']);
    expect(t.code).toBe(3);
    expect(t.out).toContain('unknown (no weekly reading recorded yet)');
    expect(t.out).toContain('0% (estimated, 1 of 1 session uncounted, no weekly share)');
    expect(t.out).toContain('No budget used up. 2 incomplete: some use could not be counted.');
  });

  it('shows the week percentage as incomplete once the limit has reset since the last snapshot', async () => {
    await setup();
    await cli(['budget', 'set', '--week', '--percent', '10']);
    const { code, data } = await budgetsJson({ now: () => new Date('2026-11-28T00:00:00Z') });
    expect(code).toBe(3);
    expect(data.week).toMatchObject({ from: '2026-11-27T10:00:00.000Z', to: '2026-12-04T10:00:00.000Z', weeklyPercent: null });
    expect(data.budgets[0].status).toBe('incomplete');
  });

  it('says when no budgets are set, and exits 0', async () => {
    const r = await cli(['budgets']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No budgets set.');
    expect(JSON.parse((await cli(['budgets', '--json'])).out)).toMatchObject({
      budgets: [],
      anyUsedUp: false,
      anyIncomplete: false,
    });
  });

  it('gives the same figures when ccusage cannot run and the log files are read', async () => {
    await setup();
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '10000']);
    await cli(['budget', 'set', '--week', '--tokens', '100000']);
    const a = await budgetsJson();
    const b = await budgetsJson({ ccusageScript: BROKEN_CCUSAGE });
    expect(b).toEqual(a);
  });

  it('refuses a missing log folder', async () => {
    await cli(['budget', 'set', '--week', '--tokens', '5']);
    let err = '';
    const code = await run(
      ['budgets'],
      { USAGE_LEDGER_LOGS: join(tmpdir(), 'no-such-logs-dir'), USAGE_LEDGER_DB: db },
      { out: () => {}, err: (s) => (err += s) },
    );
    expect(code).toBe(2);
    expect(err).toContain('Log folder not found');
  });

  it('backs up a version 4 database before widening budgets, and keeps its budgets', async () => {
    await cli(['budget', 'set', '--week', '--tokens', '5']);
    const raw = new Database(db);
    raw.exec('DROP TABLE budgets');
    raw.exec(`CREATE TABLE budgets (
        scope TEXT NOT NULL CHECK (scope IN ('task', 'week')),
        task TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL CHECK (unit IN ('tokens', 'percent')),
        limit_value REAL NOT NULL,
        set_at TEXT NOT NULL,
        PRIMARY KEY (scope, task, unit))`);
    raw.exec("INSERT INTO budgets VALUES ('task', 'build-api', 'tokens', 777, '2026-11-20T00:00:00.000Z')");
    raw.exec('PRAGMA user_version = 4');
    raw.close();
    expect((await cli(['budget', 'set', '--project', 'shop', '--dollars', '2'])).code).toBe(0);
    expect(readdirSync(dirname(db)).some((f) => f.startsWith('ledger.db.backup-v4-'))).toBe(true);
    const { data } = await budgetsJson();
    expect(data.budgets.map((b: any) => [b.scope, b.task, b.project, b.unit, b.limit])).toEqual([
      ['project', null, 'shop', 'dollars', 2],
      ['task', 'build-api', null, 'tokens', 777],
    ]);
  });
});

describe('project budgets and dollar budgets', () => {
  it('stores a project budget for the current week in dollars or percent', async () => {
    const a = await cli(['budget', 'set', '--project', 'shop', '--dollars', '2.50']);
    expect(a.code).toBe(0);
    expect(a.out).toBe('Set budget for project "shop" (current week): $2.50.\n');
    const b = await cli(['budget', 'set', '--project', 'shop', '--percent', '10', '--json']);
    expect(JSON.parse(b.out)).toMatchObject({
      budget: { scope: 'project', task: null, project: 'shop', unit: 'percent', limit: 10 },
      replaced: false,
    });
    expect((await cli(['budget', 'set', '--project', 'shop', '--dollars', '$3'])).out).toBe(
      'Replaced budget for project "shop" (current week): $3.00.\n',
    );
    expect((await cli(['budget', 'set', '--week', '--dollars', '0.5'])).out).toBe('Set budget for the week: $0.5000.\n');
    expect((await cli(['budget', 'set', '--task', 'build-api', '--dollars', '1'])).code).toBe(0);
    const r = await cli(['budget', 'remove', '--project', 'shop']);
    expect(r.out).toBe('Removed 2 budgets for project "shop" (current week).\n');
    expect((await budgetsJson()).data.budgets.map((x: any) => `${x.scope}:${x.unit}`)).toEqual(['week:dollars', 'task:dollars']);
  });

  it('refuses bad project or dollar input with exit code 2', async () => {
    for (const args of [
      ['budget', 'set', '--project', 'shop', '--week', '--dollars', '1'],
      ['budget', 'set', '--project', 'shop', '--task', 'x', '--dollars', '1'],
      ['budget', 'set', '--project', '  ', '--dollars', '1'],
      ['budget', 'set', '--project', 'shop', '--dollars', '0'],
      ['budget', 'set', '--project', 'shop', '--dollars', '-1'],
      ['budget', 'set', '--project', 'shop', '--dollars', 'ten'],
      ['budget', 'set', '--project', 'shop', '--dollars', '1', '--percent', '1'],
      ['budget', 'remove', '--project', 'shop', '--dollars', '1'],
      ['report', '--dollars', '1'],
    ]) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).not.toBe('');
    }
    expect((await budgetsJson()).data.budgets).toEqual([]);
  });

  it('shows a project dollar budget used up when its use equals its limit, and exits 1', async () => {
    await setup();
    // Sessions 3, 4 and 5 are in project folder -home-dev-proj-gamma: $0.021 + $0.027 + $0.0003.
    await cli(['budget', 'set', '--project=-home-dev-proj-gamma', '--dollars', '0.0483']);
    const t = await cli(['budgets']);
    expect(t.code).toBe(1);
    expect(t.out).toMatch(/project -home-dev-proj-gamma \(week\)\s+\$0\.0483\s+\$0\.0483 \(estimated\)\s+USED UP/);
    const { code, data } = await budgetsJson();
    expect(code).toBe(1);
    expect(data.budgets[0]).toMatchObject({
      scope: 'project',
      project: '-home-dev-proj-gamma',
      unit: 'dollars',
      used: 0.0483,
      remaining: 0,
      status: 'used-up',
      sessions: 3,
      unknownSessions: 0,
      estimated: true,
    });
  });

  it('counts a project by its label when one is given', async () => {
    await setup();
    await cli(['label', ALPHA, '--task', 'build-api', '--project', 'shop']);
    await cli(['budget', 'set', '--project', 'shop', '--percent', '0.5']);
    await cli(['budget', 'set', '--project', 'shop', '--dollars', '1']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(1);
    const [dollars, percent] = data.budgets;
    expect(percent).toMatchObject({ unit: 'percent', used: 0.5, status: 'used-up', sessions: 1 });
    expect(dollars).toMatchObject({ unit: 'dollars', used: 0.012825, status: 'ok', sessions: 1 });
  });

  it('shows a dollar budget with uncosted sessions under its limit as incomplete, with the count, and exits 3', async () => {
    await setup();
    await cli(['budget', 'set', '--project=-home-dev-proj-gamma', '--dollars', '5']);
    // With ccusage unable to run, tokens come from the log files, which have no prices.
    const t = await cli(['budgets'], '', { ccusageScript: BROKEN_CCUSAGE });
    expect(t.code).toBe(3);
    expect(t.out).toMatch(/project -home-dev-proj-gamma \(week\)\s+\$5\.00\s+\$0\.0000 \(estimated, 3 of 3 sessions uncounted, no cost\)\s+incomplete/);
    expect(t.out).toContain('No budget used up. 1 incomplete: some use could not be counted.');
    const { code, data } = await budgetsJson({ ccusageScript: BROKEN_CCUSAGE });
    expect(code).toBe(3);
    expect(data.anyUsedUp).toBe(false);
    expect(data.anyIncomplete).toBe(true);
    expect(data.budgets[0]).toMatchObject({ used: 0, status: 'incomplete', usedUp: false, sessions: 3, unknownSessions: 3 });
    expect(data.budgets[0].reason).toContain('no estimated cost');
  });

  it('shows a project percent budget with a session of unknown share as incomplete', async () => {
    await setup();
    // Session 5 has no snapshot after it ended, so its share is unknown.
    await cli(['budget', 'set', '--project=-home-dev-proj-gamma', '--percent', '10']);
    const { code, data } = await budgetsJson();
    expect(code).toBe(3);
    expect(data.budgets[0]).toMatchObject({ used: 4, status: 'incomplete', sessions: 3, unknownSessions: 1 });
  });

  it('exits 0 when every budget is ok', async () => {
    await setup();
    await cli(['budget', 'set', '--project', 'shop', '--dollars', '1']);
    await cli(['budget', 'set', '--week', '--dollars', '1']);
    await cli(['budget', 'set', '--week', '--percent', '50']);
    await cli(['budget', 'set', '--task', 'build-api', '--tokens', '20000']);
    const t = await cli(['budgets']);
    expect(t.code).toBe(0);
    expect(t.out).toContain('No budget used up.');
    expect(t.out).not.toContain('incomplete');
    const { code, data } = await budgetsJson();
    expect(code).toBe(0);
    expect(data.budgets.every((b: any) => b.status === 'ok')).toBe(true);
    expect(data.budgets.find((b: any) => b.scope === 'week' && b.unit === 'dollars')).toMatchObject({ used: 0.06195, sessions: 5 });
  });

  it('a project budget counts only the current week', async () => {
    await setup();
    await cli(['budget', 'set', '--project=-home-dev-proj-gamma', '--tokens', '1']);
    const { code, data } = await budgetsJson({ now: () => new Date('2026-11-28T00:00:00Z') });
    expect(code).toBe(0);
    expect(data.budgets[0]).toMatchObject({ used: 0, sessions: 0, status: 'ok' });
  });
});

describe('budgetUses with some sessions costed and some not', () => {
  const span = (id: string, cost: number | null) => ({
    sessionId: id,
    project: 'p',
    start: '2026-11-21T10:00:00.000Z',
    end: '2026-11-21T11:00:00.000Z',
    totalTokens: 100,
    costUsd: cost,
  });
  const budget = (limit: number) => ({
    scope: 'project' as const,
    task: null,
    project: 'p',
    unit: 'dollars' as const,
    limit,
    setAt: '2026-11-21T00:00:00.000Z',
  });

  it('is incomplete under the limit, and used up once the known cost reaches it', async () => {
    const { budgetUses } = await import('../src/budgets.js');
    const spans = [span('a', 1.5), span('b', null), span('c', 0.5)];
    const under = budgetUses([budget(5)], spans, new Map(), undefined, NOW);
    expect(under.budgets[0]).toMatchObject({ used: 2, status: 'incomplete', sessions: 3, unknownSessions: 1, remaining: 3 });
    expect(under.anyIncomplete).toBe(true);
    const at = budgetUses([budget(2)], spans, new Map(), undefined, NOW);
    expect(at.budgets[0]).toMatchObject({ used: 2, status: 'used-up', unknownSessions: 1 });
    expect(at.anyUsedUp).toBe(true);
    expect(at.anyIncomplete).toBe(false);
  });
});

describe('older databases', () => {
  it('backs up a version 2 database before adding the budgets table', async () => {
    await cli(['label', ALPHA, '--task', 'build-api']);
    const raw = new Database(db);
    raw.exec('DROP TABLE IF EXISTS budgets');
    raw.exec('PRAGMA user_version = 2');
    raw.close();
    expect((await cli(['budget', 'set', '--week', '--tokens', '5'])).code).toBe(0);
    expect(readdirSync(dirname(db)).some((f) => f.startsWith('ledger.db.backup-v2-'))).toBe(true);
    expect((await budgetsJson()).data.budgets).toHaveLength(1);
  });
});
