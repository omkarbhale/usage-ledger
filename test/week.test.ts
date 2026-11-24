import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const NOW = new Date('2026-11-23T12:00:00Z');

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-week-')), 'sub', 'ledger.db');
});

async function cli(args: string[], stdin = '', now = NOW) {
  let out = '';
  let err = '';
  const code = await run(
    args,
    { USAGE_LEDGER_LOGS: LOGS, USAGE_LEDGER_DB: db },
    { out: (s) => (out += s), err: (s) => (err += s) },
    { stdin: async () => stdin, now: () => now },
  );
  return { code, out, err };
}

const fixture = (name: string) => readFileSync(join(SL, name), 'utf8');
const record = (file: string, at: string) => cli(['statusline', '--at', at], fixture(file));

describe('usage-ledger week', () => {
  it('says there is no figure yet, and exits 0, before any snapshot', async () => {
    const r = await cli(['week']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Week: no figure yet');
    const j = await cli(['week', '--json']);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({
      schemaVersion: 1,
      week: { status: 'unknown', weeklyPercent: null, warning: false, warnAt: 80 },
    });
  });

  it('shows the latest percent and reset time, below the default threshold', async () => {
    await record('week-10.0.json', '2026-11-22T09:55:00Z');
    await record('week-14.0.json', '2026-11-22T11:35:00Z');
    const r = await cli(['week']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        'Week: 14% used',
        'Resets: 2026-11-27 10:00 UTC',
        'As of: 2026-11-22 11:35 UTC (status line)',
        'Warn at: 80%',
        '',
        'Below the 80% warning threshold.',
        '',
      ].join('\n'),
    );
    const j = JSON.parse((await cli(['week', '--json'])).out);
    expect(j.week).toEqual({
      status: 'ok',
      weeklyPercent: 14,
      resetsAt: '2026-11-27T10:00:00.000Z',
      takenAt: '2026-11-22T11:35:00.000Z',
      source: 'statusline',
      warnAt: 80,
      warning: false,
      message: 'Below the 80% warning threshold.',
    });
  });

  it('warns and exits 3 at or above the default 80%', async () => {
    await record('week-85.0.json', '2026-11-23T11:00:00Z');
    const r = await cli(['week']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('Week: 85% used');
    expect(r.out).toContain('WARNING: weekly usage 85% is at or above 80% of the limit');
    const j = await cli(['week', '--json']);
    expect(j.code).toBe(3);
    expect(JSON.parse(j.out).week).toMatchObject({ status: 'warning', warning: true, weeklyPercent: 85 });
  });

  it('uses --warn-at as the threshold, inclusive', async () => {
    await record('week-14.0.json', '2026-11-22T11:35:00Z');
    expect((await cli(['week', '--warn-at', '14'])).code).toBe(3);
    expect((await cli(['week', '--warn-at', '14.5'])).code).toBe(0);
    await record('week-85.0.json', '2026-11-23T11:00:00Z');
    const r = await cli(['week', '--warn-at', '90', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).week).toMatchObject({ warnAt: 90, warning: false, status: 'ok' });
  });

  it('does not warn on a figure from before the weekly reset', async () => {
    await record('week-85.0.json', '2026-11-23T11:00:00Z');
    const r = await cli(['week', '--json'], '', new Date('2026-11-28T00:00:00Z'));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).week).toMatchObject({ status: 'stale', warning: false, weeklyPercent: 85 });
  });

  it('refuses a bad --warn-at, and --warn-at on other commands, with exit 2', async () => {
    for (const bad of ['0', '101', 'abc', '-5']) {
      expect((await cli(['week', '--warn-at', bad])).code).toBe(2);
    }
    expect((await cli(['report', '--warn-at', '50'])).code).toBe(2);
    expect((await cli(['week', 'extra'])).code).toBe(2);
  });
});

describe('usage-ledger statusline warning', () => {
  it('adds the warning to the status line at or above the threshold, still exiting 0', async () => {
    const r = await record('week-85.0.json', '2026-11-23T11:00:00Z');
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'Week: 85% used, resets 2026-11-27 10:00 UTC | WARNING: weekly usage 85% is at or above 80% of the limit\n',
    );
    const j = await cli(['statusline', '--at', '2026-11-23T11:01:00Z', '--json'], fixture('week-85.0.json'));
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ warnAt: 80, warning: true, snapshot: { weeklyPercent: 85 } });
  });

  it('shows no warning below the threshold, or with a higher --warn-at', async () => {
    expect((await record('week-14.0.json', '2026-11-22T11:35:00Z')).out).toBe(
      'Week: 14% used, resets 2026-11-27 10:00 UTC\n',
    );
    const r = await cli(['statusline', '--warn-at', '90'], fixture('week-85.0.json'));
    expect(r.out).toBe('Week: 85% used, resets 2026-11-27 10:00 UTC\n');
    const j = await cli(['statusline', '--json'], fixture('week-14.0.json'));
    expect(JSON.parse(j.out)).toMatchObject({ warning: false, warnAt: 80 });
  });
});
