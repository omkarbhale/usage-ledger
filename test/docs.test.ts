import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_HELP, HELP, run } from '../src/cli.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const SL = fileURLToPath(new URL('./fixtures/statusline', import.meta.url));
const GUIDE = readFileSync(fileURLToPath(new URL('../docs/orchestrator.md', import.meta.url)), 'utf8');
const NOW = new Date('2026-11-23T12:00:00Z');
const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function cliFor(db: string) {
  return async (args: string[], stdin = '') => {
    let out = '';
    let err = '';
    const code = await run(
      args,
      { USAGE_LEDGER_LOGS: LOGS, USAGE_LEDGER_DB: db },
      { out: (s) => (out += s), err: (s) => (err += s) },
      { stdin: async () => stdin, now: () => NOW },
    );
    return { code, out, err };
  };
}

const fixture = (f: string) => readFileSync(join(SL, f), 'utf8');

/** The guide's JSON examples, each keyed by the first backticked command just above it. */
function guideExamples(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const re = /`(usage-ledger [^`]+)`[^\n]*\n\n```json\n([\s\S]*?)```/g;
  for (const m of GUIDE.matchAll(re)) out.set(m[1], JSON.parse(m[2]));
  return out;
}

/** Times that are "now" when the example ran; compared by shape only. */
function maskTimes(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (k, x) => (k === 'labelledAt' || k === 'setAt' ? '<time>' : x)),
  );
}

describe('per-command help', () => {
  const commands = ['session', 'label', 'report', 'budget', 'budgets', 'week', 'reading', 'statusline', 'sessions'];

  it('has short help for every command, shown by <command> --help and help <command>', async () => {
    const cli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    for (const c of commands) {
      const text = COMMAND_HELP[c];
      expect(text, c).toBeDefined();
      expect(text.startsWith(`usage-ledger ${c}`)).toBe(true);
      expect(text).toContain('Exit codes:');
      expect(text.split('\n').length).toBeLessThan(25);
      expect(await cli([c, '--help'])).toEqual({ code: 0, out: text, err: '' });
      expect(await cli(['help', c])).toEqual({ code: 0, out: text, err: '' });
    }
    expect(Object.keys(COMMAND_HELP).sort()).toEqual([...commands].sort());
  });

  it('shows help for a subcommand without running it', async () => {
    const cli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    expect(await cli(['budget', 'set', '--help'])).toEqual({ code: 0, out: COMMAND_HELP.budget, err: '' });
  });

  it('refuses help for an unknown command with exit 2', async () => {
    const cli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    const r = await cli(['bogus', '--help']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('No help for unknown command: bogus');
  });

  it('keeps the full help for --help alone, pointing to the guide', async () => {
    const cli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    expect((await cli(['--help'])).out).toBe(HELP);
    expect(HELP).toContain('docs/orchestrator.md');
    expect(HELP).toContain('<command> --help');
  });
});

describe('docs/orchestrator.md examples match real output', () => {
  it('has one example per command, each equal to what the command prints', async () => {
    const ex = guideExamples();
    const db = join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db');
    const cli = cliFor(db);
    const check = async (cmd: string, args: string[], code: number, stdin = '') => {
      expect(ex.has(cmd), `guide has an example for: ${cmd}`).toBe(true);
      const r = await cli(args, stdin);
      expect(r.code, cmd).toBe(code);
      expect(maskTimes(JSON.parse(r.out)), cmd).toEqual(maskTimes(ex.get(cmd)));
    };

    await cli(['statusline', '--at', '2026-11-20T09:59:00Z'], fixture('week-5.0.json'));
    await cli(['statusline', '--at', '2026-11-20T10:02:00Z'], fixture('week-5.5.json'));
    await cli(['statusline', '--at', '2026-11-22T09:55:00Z'], fixture('week-10.0.json'));
    await check(
      'usage-ledger statusline --at 2026-11-22T11:35:00Z --json < test/fixtures/statusline/week-14.0.json',
      ['statusline', '--at', '2026-11-22T11:35:00Z', '--json'],
      0,
      fixture('week-14.0.json'),
    );
    await check(`usage-ledger session ${ID(3)} --json`, ['session', ID(3), '--json'], 0);
    await check(
      `usage-ledger label ${ID(1)} --task build-api --project shop --json`,
      ['label', ID(1), '--task', 'build-api', '--project', 'shop', '--json'],
      0,
    );
    await cli(['label', ID(3), '--task', 'build-api']);
    await cli(['label', ID(4), '--task', 'write-docs']);
    await cli(['label', ID(5), '--task', 'write-docs']);

    // The report example shows only some groups; each shown group and the total must match.
    const rep = await cli(['report', '--week', '--by', 'task', '--json']);
    expect(rep.code).toBe(0);
    const real = JSON.parse(rep.out);
    const doc = ex.get('usage-ledger report --week --by task --json') as typeof real;
    expect(doc).toBeDefined();
    expect(doc.schemaVersion).toBe(real.schemaVersion);
    expect(doc.report.by).toBe(real.report.by);
    expect(doc.report.window).toEqual(real.report.window);
    expect(doc.report.total).toEqual(real.report.total);
    for (const g of doc.report.groups) {
      expect(real.report.groups).toContainEqual(g);
    }

    // The sessions example shows only one session; it and the window must match.
    const ls = await cli(['sessions', '--since', '2026-11-22T00:00:00Z', '--json']);
    expect(ls.code).toBe(0);
    const realLs = JSON.parse(ls.out);
    const docLs = ex.get('usage-ledger sessions --since 2026-11-22T00:00:00Z --json') as typeof realLs;
    expect(docLs).toBeDefined();
    expect(docLs.listing.window).toEqual(realLs.listing.window);
    expect(docLs.listing.count).toBe(realLs.listing.count);
    for (const x of docLs.listing.sessions) expect(realLs.listing.sessions).toContainEqual(x);

    await check(
      'usage-ledger budget set --task build-api --tokens 10000 --json',
      ['budget', 'set', '--task', 'build-api', '--tokens', '10000', '--json'],
      0,
    );
    await check(
      'usage-ledger budget set --project shop --dollars 1 --json',
      ['budget', 'set', '--project', 'shop', '--dollars', '1', '--json'],
      0,
    );
    await cli(['budget', 'set', '--week', '--percent', '50']);
    await check('usage-ledger budgets --json', ['budgets', '--json'], 1);
    await check('usage-ledger budget remove --week --json', ['budget', 'remove', '--week', '--json'], 0);

    const wcli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    await wcli(['statusline', '--at', '2026-11-23T08:30:00Z'], fixture('week-85.0.json'));
    const w = await wcli(['week', '--json']);
    expect(w.code).toBe(3);
    expect(JSON.parse(w.out)).toEqual(ex.get('usage-ledger week --json'));

    const rcli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    const rd = await rcli(['reading', '--percent', '42', '--resets-at', '2026-11-27T10:00:00Z', '--at', '2026-11-23T12:00:00Z', '--json']);
    expect(rd.code).toBe(0);
    expect(JSON.parse(rd.out)).toEqual(
      ex.get('usage-ledger reading --percent 42 --resets-at 2026-11-27T10:00:00Z --at 2026-11-23T12:00:00Z --json'),
    );
  });

  it('shows the error object as a command prints it', async () => {
    const cli = cliFor(join(mkdtempSync(join(tmpdir(), 'ul-docs-')), 'ledger.db'));
    const r = await cli(['session', 'nope', '--json']);
    expect(r.code).toBe(1);
    const m = GUIDE.match(/## Errors[\s\S]*?```json\n([\s\S]*?)```/);
    expect(m).not.toBeNull();
    expect(JSON.parse(r.out)).toEqual(JSON.parse((m as RegExpMatchArray)[1]));
  });

  it('lists every error code the commands can give', () => {
    for (const code of [
      'usage',
      'invalid-session-id',
      'invalid-task',
      'invalid-project',
      'invalid-limit',
      'session-not-found',
      'logs-not-found',
      'bad-statusline-input',
      'invalid-reading',
      'invalid-time',
    ]) {
      expect(GUIDE).toContain(`\`${code}\``);
    }
  });
});

describe('help and guide cover the week filter, hand readings, project budgets and the sessions listing', () => {
  it('names each feature in the full help, the per-command help and the guide', () => {
    for (const text of [HELP, GUIDE]) {
      expect(text).toContain('--week');
      expect(text).toContain('--since <time>');
      expect(text).toContain('reading --percent');
      expect(text).toContain('--resets-at');
      expect(text).toContain('--project <name>');
      expect(text).toContain('--dollars');
      expect(text).toMatch(/usage-ledger sessions/);
    }
    expect(COMMAND_HELP.report).toContain('--since <time>');
    expect(COMMAND_HELP.sessions).toContain('never usage');
    expect(COMMAND_HELP.budget).toContain('--project <name>');
    expect(COMMAND_HELP.budget).toContain('--dollars <usd>');
    expect(COMMAND_HELP.reading).toContain('source manual');
  });

  it('says week reads the latest reading of either source, not only the status line', () => {
    expect(COMMAND_HELP.week).toContain('latest reading (status line or hand)');
    expect(HELP).toContain('week reads the latest reading, status line or hand');
    expect(HELP).not.toContain('last status line snapshot');
    expect(GUIDE).toContain('budget set --project <name> --dollars <usd>');
  });
});
