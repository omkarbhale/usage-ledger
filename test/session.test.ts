import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatUsd, run } from '../src/cli.js';
import { costOf, readFromLogFile } from '../src/sessions.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const BROKEN_CCUSAGE = join(tmpdir(), 'no-such-ccusage', 'cli.js');

async function cli(args: string[], logs = LOGS, extra = {}) {
  let out = '';
  let err = '';
  const db = join(mkdtempSync(join(tmpdir(), 'usage-ledger-db-')), 'ledger.db');
  const code = await run(args, { USAGE_LEDGER_LOGS: logs, USAGE_LEDGER_DB: db }, {
    out: (s) => (out += s),
    err: (s) => (err += s),
  }, extra);
  return { code, out, err };
}

describe('usage-ledger session <id> through ccusage', () => {
  it('prints input, output, cache and total tokens as a table', async () => {
    const r = await cli(['session', ALPHA]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Session ${ALPHA}`);
    expect(r.out).toMatch(/Input\s+1,500/);
    expect(r.out).toMatch(/Output\s+300/);
    expect(r.out).toMatch(/Cache write\s+300/);
    expect(r.out).toMatch(/Cache read\s+9,000/);
    expect(r.out).toMatch(/Total\s+11,100/);
  });

  it('prints the same as JSON with a schema version', async () => {
    const r = await cli(['session', ALPHA, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      schemaVersion: 1,
      session: {
        sessionId: ALPHA,
        inputTokens: 1500,
        outputTokens: 300,
        cacheCreationTokens: 300,
        cacheReadTokens: 9000,
        totalTokens: 11100,
        source: 'ccusage',
      },
    });
  });

  it('shows the estimated cost in USD from ccusage, labelled as an estimate', async () => {
    const t = await cli(['session', ALPHA]);
    expect(t.out).toContain('Estimated cost (USD): $0.0128 (estimate from ccusage)');
    const j = JSON.parse((await cli(['session', ALPHA, '--json'])).out);
    expect(j.session.cost).toEqual({ status: 'estimated', estimated: true, usd: 0.012825, source: 'ccusage' });
    const b = JSON.parse((await cli(['session', BETA, '--json'])).out);
    expect(b.session.cost.usd).toBe(0.000825);
  });

  it('matches the one session asked for, not another', async () => {
    const r = await cli(['session', BETA, '--json']);
    expect(JSON.parse(r.out).session).toMatchObject({ sessionId: BETA, totalTokens: 27 });
  });

  it('gives a plain message and exit code 1 for an unknown ID', async () => {
    const r = await cli(['session', 'ffffffff-0000-4000-8000-000000000000']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toBe('No session found with ID ffffffff-0000-4000-8000-000000000000.\n');
  });

  it('gives a JSON error and exit code 1 for an unknown ID under --json', async () => {
    const r = await cli(['session', 'nope', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      error: { code: 'session-not-found', message: 'No session found with ID nope.' },
    });
  });

  it('exits 1 with a plain message when the log folder is missing', async () => {
    const r = await cli(['session', ALPHA], join(tmpdir(), 'usage-ledger-missing-logs'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^Log folder not found: /);
  });

  it('accepts the projects folder itself as the log folder', async () => {
    const r = await cli(['session', ALPHA, '--json'], join(LOGS, 'projects'));
    expect(JSON.parse(r.out).session.totalTokens).toBe(11100);
  });
});

describe('estimated cost helpers', () => {
  it('formats dollars with four decimals under $1 and two from $1', () => {
    expect(formatUsd(0.012825)).toBe('$0.0128');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it("takes ccusage's totalCost, else sums its per-model costs, else none", () => {
    expect(costOf({ totalCost: 0.5, modelBreakdowns: [{ cost: 9 }] })).toBe(0.5);
    expect(costOf({ modelBreakdowns: [{ cost: 0.25 }, { cost: 0.5 }] })).toBe(0.75);
    expect(costOf({ modelBreakdowns: [{}] })).toBeNull();
    expect(costOf({})).toBeNull();
  });
});

describe('fallback to the session log file', () => {
  it('reads the same figures when ccusage cannot run', async () => {
    const r = await cli(['session', ALPHA, '--json'], LOGS, { ccusageScript: BROKEN_CCUSAGE });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).session).toMatchObject({
      sessionId: ALPHA,
      inputTokens: 1500,
      outputTokens: 300,
      cacheCreationTokens: 300,
      cacheReadTokens: 9000,
      totalTokens: 11100,
      source: 'log-file',
    });
  });

  it('marks the cost unknown, with a reason, since the log file has no prices', async () => {
    const r = await cli(['session', ALPHA, '--json'], LOGS, { ccusageScript: BROKEN_CCUSAGE });
    const c = JSON.parse(r.out).session.cost;
    expect(c).toMatchObject({ status: 'unknown', estimated: true, usd: null, source: 'ccusage' });
    expect(c.reason).toMatch(/log file/);
    const t = await cli(['session', ALPHA], LOGS, { ccusageScript: BROKEN_CCUSAGE });
    expect(t.out).toMatch(/Estimated cost \(USD\): unknown \(/);
  });

  it('still gives exit code 1 for an unknown ID', async () => {
    const r = await cli(['session', 'nope'], LOGS, { ccusageScript: BROKEN_CCUSAGE });
    expect(r.code).toBe(1);
  });

  it('counts a reply written twice only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      requestId: 'r1',
      message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    writeFileSync(join(dir, 'projects', 'p', 'sess-1.jsonl'), `${line}\n${line}\nnot json\n`);
    expect(readFromLogFile('sess-1', dir)?.totalTokens).toBe(15);
  });
});

describe('usage', () => {
  it('rejects a session ID that could reach outside the log folder', async () => {
    const r = await cli(['session', '../etc/passwd']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Not a valid session ID/);
  });

  it('asks for exactly one ID', async () => {
    const r = await cli(['session']);
    expect(r.code).toBe(2);
  });

  it('prints help', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('usage-ledger session <session-id>');
  });
});
