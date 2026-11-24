import { DatabaseSync as Database } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { Store } from '../src/store.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const V3 = fileURLToPath(new URL('./fixtures/db/ledger-v3.db', import.meta.url));
const BETA = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-23T12:00:00Z');

let db: string;
beforeEach(() => {
  db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-reading-')), 'sub', 'ledger.db');
});

async function cli(args: string[], stdin = '') {
  let out = '';
  let err = '';
  const code = await run(
    args,
    { USAGE_LEDGER_LOGS: LOGS, USAGE_LEDGER_DB: db },
    { out: (s) => (out += s), err: (s) => (err += s) },
    { stdin: async () => stdin, now: () => NOW },
  );
  return { code, out, err };
}

function rows(path: string) {
  const raw = new Database(path, { readOnly: true });
  try {
    return raw.prepare('SELECT * FROM snapshots ORDER BY taken_at').all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

describe('migrating a version 3 ledger.db', () => {
  beforeEach(() => {
    mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
    copyFileSync(V3, db);
  });

  it('writes a backup first, then marks old snapshots as status line readings', async () => {
    const r = await cli(['week', '--json']);
    expect(r.code).toBe(0);
    const backups = readdirSync(dirname(db)).filter((f) => f.startsWith('ledger.db.backup-v3-'));
    expect(backups).toHaveLength(1);
    const backup = join(dirname(db), backups[0]);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    // The backup is the old file, untouched: no source column, same rows.
    const old = rows(backup);
    expect(old).toHaveLength(4);
    expect(old[0]).not.toHaveProperty('source');
    // The migrated file keeps every row and every label and budget, with source statusline.
    const now = rows(db);
    expect(now).toHaveLength(4);
    expect(now.every((x) => x.source === 'statusline')).toBe(true);
    expect(JSON.parse(r.out).week).toMatchObject({ weeklyPercent: 14, source: 'statusline' });
    const store = Store.open(db);
    expect(store.labels().get('11111111-1111-4111-8111-111111111111')?.task).toBe('build-api');
    expect(store.budgets()).toHaveLength(1);
    store.close();
  });

  it('migrates once: a second run makes no second backup', async () => {
    await cli(['week']);
    await cli(['week']);
    expect(readdirSync(dirname(db)).filter((f) => f.includes('.backup-'))).toHaveLength(1);
  });

  it('refuses a manual source the old way of writing could not have made', () => {
    const store = Store.open(db);
    store.close();
    const raw = new Database(db);
    expect(() =>
      raw.prepare("INSERT INTO snapshots (taken_at, weekly_percent, source) VALUES ('x', 1, 'other')").run(),
    ).toThrow();
    raw.close();
  });
});

describe('usage-ledger reading', () => {
  it('stores a manual row and moves the current week to that reset', async () => {
    await cli(['statusline', '--at', '2026-11-22T11:35:00Z'], readFileSync(join(SL, 'week-14.0.json'), 'utf8'));
    await cli(['budget', 'set', '--week', '--percent', '50']);
    const before = JSON.parse((await cli(['budgets', '--json'])).out).week;
    expect(before).toMatchObject({ from: '2026-11-20T10:00:00.000Z', to: '2026-11-27T10:00:00.000Z', source: 'statusline' });

    const r = await cli(['reading', '--percent', '42', '--resets-at', '2026-11-28T08:00:00Z']);
    expect(r).toEqual({
      code: 0,
      out:
        'Recorded by hand: 42% of the weekly limit used, resets 2026-11-28 08:00 UTC.\n' +
        'The current week now runs 2026-11-21 08:00 UTC to 2026-11-28 08:00 UTC.\n',
      err: '',
    });
    const last = rows(db).at(-1);
    expect(last).toMatchObject({
      taken_at: '2026-11-23T12:00:00.000Z',
      weekly_percent: 42,
      resets_at: '2026-11-28T08:00:00.000Z',
      session_id: null,
      source: 'manual',
    });

    const b = await cli(['budgets', '--json']);
    expect(JSON.parse(b.out).week).toEqual({
      from: '2026-11-21T08:00:00.000Z',
      to: '2026-11-28T08:00:00.000Z',
      fromResetTime: true,
      source: 'manual',
      weeklyPercent: 42,
      asOf: '2026-11-23T12:00:00.000Z',
      reason: null,
    });
    expect((await cli(['budgets'])).out).toContain(
      "Budgets (week 2026-11-21 08:00 UTC to 2026-11-28 08:00 UTC, from the hand reading's reset time)",
    );
    const w = await cli(['week']);
    expect(w.out).toContain('Week: 42% used');
    expect(w.out).toContain('As of: 2026-11-23 12:00 UTC (hand reading)');
    expect(JSON.parse((await cli(['week', '--json'])).out).week).toMatchObject({ source: 'manual', weeklyPercent: 42 });
  });

  it('prints the stored reading under --json', async () => {
    const r = await cli(['reading', '--percent', '0', '--resets-at', '2026-11-30T00:00:00+02:00', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      reading: {
        takenAt: '2026-11-23T12:00:00.000Z',
        weeklyPercent: 0,
        resetsAt: '2026-11-29T22:00:00.000Z',
        sessionId: null,
        source: 'manual',
      },
    });
  });

  it('counts hand readings the same as status line readings for a session share', async () => {
    expect((await cli(['reading', '--at', '2026-11-20T10:02:00Z', '--percent', '5.5', '--resets-at', '2026-11-27T10:00:00Z'])).code).toBe(0);
    expect((await cli(['reading', '--at', '2026-11-22T09:55:00Z', '--percent', '10', '--resets-at', '2026-11-27T10:00:00Z'])).code).toBe(0);
    const w = JSON.parse((await cli(['session', BETA, '--json'])).out).session.weekly;
    expect(w).toMatchObject({ status: 'estimated', weeklyPercent: 4.5 });
  });

  it('refuses a bad percent with exit 2 and a plain message, storing nothing', async () => {
    for (const p of ['101', '-1', 'abc', '', '42%', '1e2']) {
      const r = await cli(['reading', `--percent=${p}`, '--resets-at', '2026-11-27T10:00:00Z']);
      expect(r.code, p).toBe(2);
      expect(r.out, p).toBe('');
      expect(r.err, p).toBe(`--percent must be a number from 0 to 100, not "${p}".\n`);
    }
    const j = await cli(['reading', '--percent', '150', '--resets-at', '2026-11-27T10:00:00Z', '--json']);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out).error.code).toBe('invalid-reading');
    expect(existsSync(db)).toBe(false);
  });

  it('refuses a bad reset time with exit 2', async () => {
    const cases: [string[], string][] = [
      [['--percent', '42', '--resets-at', 'tomorrow'], '--resets-at is not a time'],
      [['--percent', '42', '--resets-at', '2026-11-23T11:00:00Z'], 'must be after the reading time'],
      [['--percent', '42', '--resets-at', '2026-12-01T10:00:00Z'], 'at most seven days after'],
      [['--percent', '42', '--resets-at', '2026-11-27T10:00:00Z', '--at', 'soon'], '--at is not a time'],
      [['--percent', '42'], 'Give when the weekly limit resets'],
      [['--resets-at', '2026-11-27T10:00:00Z'], 'Give the weekly percentage used'],
    ];
    for (const [args, msg] of cases) {
      const r = await cli(['reading', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toContain(msg);
    }
    expect((await cli(['reading', 'extra', '--percent', '1', '--resets-at', '2026-11-27T10:00:00Z'])).code).toBe(2);
    expect((await cli(['reading', '--percent', '1', '--resets-at', '2026-11-27T10:00:00Z', '--task', 'x'])).code).toBe(2);
    expect((await cli(['week', '--resets-at', '2026-11-27T10:00:00Z'])).code).toBe(2);
    expect(existsSync(db)).toBe(false);
  });
});

describe('the current week', () => {
  it('falls back to the last seven days with no reading, and says so', async () => {
    await cli(['budget', 'set', '--week', '--tokens', '5']);
    const j = JSON.parse((await cli(['budgets', '--json'])).out).week;
    expect(j).toMatchObject({
      from: '2026-11-16T12:00:00.000Z',
      to: '2026-11-23T12:00:00.000Z',
      fromResetTime: false,
      source: null,
    });
    expect((await cli(['budgets'])).out).toContain('no reading gives a reset time yet, so the last seven days');
  });

  it('takes the bounds from the newest reading, whichever its source', async () => {
    await cli(['reading', '--at', '2026-11-22T00:00:00Z', '--percent', '20', '--resets-at', '2026-11-28T08:00:00Z']);
    await cli(['statusline', '--at', '2026-11-22T11:35:00Z'], readFileSync(join(SL, 'week-14.0.json'), 'utf8'));
    await cli(['budget', 'set', '--week', '--percent', '50']);
    const j = JSON.parse((await cli(['budgets', '--json'])).out).week;
    expect(j).toMatchObject({ to: '2026-11-27T10:00:00.000Z', source: 'statusline', weeklyPercent: 14 });
  });
});
