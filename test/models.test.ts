import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { effortOf, modelsOf, readFromLogFile } from '../src/sessions.js';

const LOGS = fileURLToPath(new URL('./fixtures/logs', import.meta.url));
const ALPHA = '11111111-1111-4111-8111-111111111111';
const DELTA = '44444444-4444-4444-8444-444444444444';
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

describe('models and effort in a session answer', () => {
  it('names the model in the table, with no effort line when the log has none', async () => {
    const r = await cli(['session', ALPHA]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Model: claude-sonnet-4-5-20250929\n');
    expect(r.out).not.toContain('Effort');
  });

  it('names the model in JSON, with no effortLevels field when the log has none', async () => {
    const s = JSON.parse((await cli(['session', ALPHA, '--json'])).out).session;
    expect(s.models).toEqual(['claude-sonnet-4-5-20250929']);
    expect('effortLevels' in s).toBe(false);
  });

  it('shows the effort level when the log records it, in the table and JSON', async () => {
    const t = await cli(['session', DELTA]);
    expect(t.out).toContain('Model: claude-opus-4-1-20250805\n');
    expect(t.out).toContain('Effort: high\n');
    const s = JSON.parse((await cli(['session', DELTA, '--json'])).out).session;
    expect(s.models).toEqual(['claude-opus-4-1-20250805']);
    expect(s.effortLevels).toEqual(['high']);
  });

  it('names models and effort on the log-file fallback too', async () => {
    const r = await cli(['session', DELTA, '--json'], LOGS, { ccusageScript: BROKEN_CCUSAGE });
    const s = JSON.parse(r.out).session;
    expect(s.source).toBe('log-file');
    expect(s.models).toEqual(['claude-opus-4-1-20250805']);
    expect(s.effortLevels).toEqual(['high']);
  });

  it('lists several models in order, without repeats or synthetic replies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ul-models-'));
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    const id = 'abcdabcd-0000-4000-8000-000000000001';
    const line = (n: number, model: string, effort?: string) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        timestamp: `2026-11-22T10:0${n}:00.000Z`,
        requestId: `r${n}`,
        ...(effort ? { effort } : {}),
        message: { id: `m${n}`, model, usage: { input_tokens: 10, output_tokens: 1 } },
      });
    writeFileSync(
      join(dir, 'projects', 'p', `${id}.jsonl`),
      [
        line(1, 'claude-sonnet-4-5-20250929', 'medium'),
        line(2, '<synthetic>'),
        line(3, 'claude-opus-4-1-20250805', 'High'),
        line(4, 'claude-sonnet-4-5-20250929', 'medium'),
      ].join('\n'),
    );
    expect(readFromLogFile(id, dir)?.models).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805']);
    const t = await cli(['session', id], dir, { ccusageScript: BROKEN_CCUSAGE });
    expect(t.out).toContain('Models: claude-sonnet-4-5-20250929, claude-opus-4-1-20250805\n');
    expect(t.out).toContain('Effort: medium, high\n');
  });

  it('reads models from ccusage records', () => {
    expect(modelsOf({ modelsUsed: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
    expect(modelsOf({ modelBreakdowns: [{ modelName: 'x' }, { modelName: '<synthetic>' }] })).toEqual(['x']);
    expect(modelsOf({})).toEqual([]);
  });

  it('reads effort only from a plain string field', () => {
    expect(effortOf({ effort: 'high' })).toBe('high');
    expect(effortOf({ message: { effortLevel: 'Low' } })).toBe('low');
    expect(effortOf({ effort: 3 })).toBeUndefined();
    expect(effortOf({ effort: 'x; rm -rf /' })).toBeUndefined();
    expect(effortOf({})).toBeUndefined();
  });

  it('keeps reports to per-task totals: no session IDs, models or ranking', async () => {
    for (const by of ['task', 'project']) {
      const r = await cli(['report', '--by', by, '--json']);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(r.out).not.toContain('models');
      expect(r.out).not.toContain('effort');
    }
  });
});
