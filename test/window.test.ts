import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { parseSince } from '../src/window.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const BROKEN_CCUSAGE = join(tmpdir(), 'no-such-ccusage', 'cli.js');
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const GAMMA = '33333333-3333-4333-8333-333333333333';
const DELTA = '44444444-4444-4444-8444-444444444444';
const LATE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-24T12:00:00Z');

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-window-')), 'ledger.db');
});

async function cli(args: string[], stdin = '', extra = {}) {
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
  await cli(['label', ALPHA, '--task', 'build-api', '--project', 'shop']);
  await cli(['label', GAMMA, '--task', 'build-api', '--project', 'shop']);
  await cli(['label', DELTA, '--task', 'write-docs', '--project', 'docs']);
  await cli(['label', LATE, '--task', 'write-docs', '--project', 'docs']);
}

const json = (r: { out: string }) => JSON.parse(r.out);

describe('report --week', () => {
  it('covers only usage after the last reset, by project, with input and output apart', async () => {
    await setup();
    // A hand reading moves the reset: the week now runs from 2026-11-22 10:15 UTC.
    // Sessions 1 and 2 fall before it; session 3 (10:00 to 11:00) runs across it.
    expect((await cli(['reading', '--percent', '20', '--resets-at', '2026-11-29T10:15:00Z', '--at', '2026-11-24T09:00:00Z'])).code).toBe(0);
    const r = await cli(['report', '--week', '--by', 'project', '--json']);
    expect(r.code).toBe(0);
    const rep = json(r).report;
    expect(rep.window).toEqual({
      kind: 'week',
      from: '2026-11-22T10:15:00.000Z',
      to: '2026-11-29T10:15:00.000Z',
      basis: 'reset-time',
      source: 'manual',
    });
    expect(rep.groups.map((g: any) => [g.project, g.sessions, g.inputTokens, g.outputTokens, g.totalTokens, g.clippedSessions])).toEqual([
      // Only session 3's 11:00 record (1,000 in, 500 out) is after the reset.
      ['shop', 1, 1000, 500, 1500, 1],
      ['docs', 2, 850, 210, 1060, 0],
    ]);
    const shop = rep.groups[0];
    expect(shop.cost.usd).toBeCloseTo(0.0105, 6); // half of session 3's $0.021
    expect(shop.weekly.weeklyPercent).toBeCloseTo(0.875, 4); // half of its 1.75%
    expect(rep.total).toMatchObject({ sessions: 3, inputTokens: 1850, outputTokens: 710, totalTokens: 2560, clippedSessions: 1 });
    for (const id of [ALPHA, BETA, GAMMA, DELTA, LATE]) expect(r.out).not.toContain(id);
  });

  it('heads the table with the week and shows input and output columns', async () => {
    await setup();
    const t = await cli(['report', '--week', '--by', 'project']);
    expect(t.code).toBe(0);
    expect(t.out).toMatch(
      /^Usage by project, current week 2026-11-20 10:00 UTC to 2026-11-27 10:00 UTC, from the status line reading's reset time\n/,
    );
    expect(t.out).toMatch(/Project\s+Sessions\s+Input\s+Output\s+Cache\s+Total tokens/);
    expect(t.out).toMatch(/shop\s+2\s+3,500\s+1,300\s+9,300\s+14,100\s+\$0\.0338/);
    expect(t.out).toMatch(/docs\s+2\s+850\s+210\s+0\s+1,060\s+\$0\.0273/);
  });

  it('falls back to the last seven days with no reading, and says so', async () => {
    await cli(['label', LATE, '--task', 'write-docs']);
    const r = await cli(['report', '--week', '--json']);
    const rep = json(r).report;
    expect(rep.window).toMatchObject({ kind: 'week', basis: 'last-seven-days', from: '2026-11-17T12:00:00.000Z', to: NOW.toISOString() });
    expect(rep.total.sessions).toBe(5);
    expect((await cli(['report', '--week'])).out).toContain('no reading gives a reset time yet, so the last seven days');
  });
});

describe('report --since', () => {
  it('limits the report to usage at or after the time', async () => {
    await setup();
    const r = json(await cli(['report', '--since', '2026-11-22T10:15:00Z', '--by', 'task', '--json'])).report;
    expect(r.window).toEqual({ kind: 'since', from: '2026-11-22T10:15:00.000Z', to: null, basis: null, source: null });
    expect(r.groups.map((g: any) => [g.task, g.sessions, g.inputTokens, g.outputTokens])).toEqual([
      ['build-api', 1, 1000, 500],
      ['write-docs', 2, 850, 210],
    ]);
    const later = json(await cli(['report', '--since', '2026-11-23', '--json'])).report;
    expect(later.total).toMatchObject({ sessions: 1, inputTokens: 50, outputTokens: 10, totalTokens: 60 });
    const none = await cli(['report', '--since', '2026-12-01T00:00:00Z']);
    expect(none.out).toContain('No usage found in this time.');
  });

  it('clips from the log file when ccusage cannot run, with cost unknown', async () => {
    await setup();
    const r = json(await cli(['report', '--since', '2026-11-22T10:15:00Z', '--json'], '', { ccusageScript: BROKEN_CCUSAGE })).report;
    expect(r.total).toMatchObject({ sessions: 3, inputTokens: 1850, outputTokens: 710, clippedSessions: 1 });
    expect(r.total.cost.status).toBe('unknown');
  });

  it('refuses a bad time, and --week with --since', async () => {
    const bad = await cli(['report', '--since', 'yesterday', '--json']);
    expect(bad.code).toBe(2);
    expect(json(bad).error.code).toBe('invalid-time');
    expect(bad.err).toMatch(/^--since is not a time: "yesterday"/);
    expect((await cli(['report', '--week', '--since', '2026-11-20'])).code).toBe(2);
    expect((await cli(['budgets', '--since', '2026-11-20'])).code).toBe(2);
    expect((await cli(['session', ALPHA, '--week'])).code).toBe(2);
  });

  it('parses ISO times and dates only', () => {
    expect(parseSince('2026-11-20')?.from).toBe('2026-11-20T00:00:00.000Z');
    expect(parseSince('2026-11-20T10:00:00+01:00')?.from).toBe('2026-11-20T09:00:00.000Z');
    expect(parseSince('11/20/2026')).toBeUndefined();
    expect(parseSince('2026-13-45')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('returns every session in time order with start, end, models, cost and weekly share, and no rank', async () => {
    await setup();
    const r = await cli(['sessions', '--json']);
    expect(r.code).toBe(0);
    const l = json(r).listing;
    expect(l.count).toBe(5);
    expect(l.window.kind).toBe('all');
    expect(l.sessions.map((s: any) => s.sessionId)).toEqual([ALPHA, BETA, GAMMA, DELTA, LATE]);
    const starts = l.sessions.map((s: any) => s.start);
    expect([...starts].sort()).toEqual(starts);
    expect(l.sessions[2]).toEqual({
      sessionId: GAMMA,
      start: '2026-11-22T10:00:00.000Z',
      end: '2026-11-22T11:00:00.000Z',
      project: 'shop',
      task: 'build-api',
      models: ['claude-sonnet-4-5-20250929'],
      inputTokens: 2000,
      outputTokens: 1000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 3000,
      cost: { status: 'estimated', estimated: true, usd: 0.021, source: 'ccusage' },
      weekly: { status: 'overlapping', estimated: true, weeklyPercent: 1.75, reason: null, splitBy: 'cost' },
      startedBeforeWindow: false,
    });
    expect(l.sessions[1]).toMatchObject({ project: '-home-dev-proj-beta', task: null, models: ['claude-opus-4-1-20250805'] });
    expect(l.sessions[4].weekly).toMatchObject({ status: 'unknown', weeklyPercent: null, reason: 'no snapshot after the session ended' });
    expect(r.out).not.toMatch(/rank/i);
  });

  it('keeps time order, not usage order, even when a later session used more', async () => {
    await setup();
    const l = json(await cli(['sessions', '--json'])).listing;
    const totals = l.sessions.map((s: any) => s.totalTokens);
    expect(totals).toEqual([11100, 27, 3000, 1000, 60]);
  });

  it('limits to the week or a time, listing sessions whole', async () => {
    await setup();
    await cli(['reading', '--percent', '20', '--resets-at', '2026-11-29T10:15:00Z', '--at', '2026-11-24T09:00:00Z']);
    const w = json(await cli(['sessions', '--week', '--json'])).listing;
    expect(w.sessions.map((s: any) => [s.sessionId, s.startedBeforeWindow, s.totalTokens])).toEqual([
      [GAMMA, true, 3000],
      [DELTA, false, 1000],
      [LATE, false, 60],
    ]);
    const s = json(await cli(['sessions', '--since', '2026-11-23T00:00:00Z', '--json'])).listing;
    expect(s.sessions.map((x: any) => x.sessionId)).toEqual([LATE]);
  });

  it('prints a table for people, oldest first', async () => {
    await setup();
    const t = await cli(['sessions']);
    expect(t.code).toBe(0);
    expect(t.out).toMatch(/^Sessions in time order, all sessions in the logs\n/);
    expect(t.out).toMatch(/Start\s+End\s+Session\s+Project\s+Task\s+Models\s+Input\s+Output\s+Total tokens\s+Est\. cost \(USD\)\s+Weekly share/);
    expect(t.out.indexOf(ALPHA)).toBeLessThan(t.out.indexOf(LATE));
    expect(t.out).toMatch(/2026-11-22 10:00 UTC\s+2026-11-22 11:00 UTC\s+3{8}-\S+\s+shop\s+build-api\s+claude-sonnet-4-5-20250929\s+2,000\s+1,000\s+3,000\s+\$0\.0210\s+1\.75% \(estimated, overlapping\)/);
    expect(t.out).toContain('5 sessions, oldest first.');
  });

  it('refuses arguments and a missing log folder', async () => {
    expect((await cli(['sessions', ALPHA])).code).toBe(2);
    let err = '';
    const code = await run(
      ['sessions'],
      { USAGE_LEDGER_LOGS: join(tmpdir(), 'usage-ledger-missing-logs'), USAGE_LEDGER_DB: db },
      { out: () => {}, err: (s) => (err += s) },
    );
    expect(code).toBe(1);
    expect(err).toMatch(/^Log folder not found: /);
  });
});
