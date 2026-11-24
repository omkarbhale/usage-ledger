import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// dist/ is committed so the ledger installs and runs with no registry.
// It must be exactly what src/ builds to.
describe('prebuilt dist/', () => {
  it('matches what src/ builds to', () => {
    const out = mkdtempSync(join(tmpdir(), 'ul-dist-'));
    const tsc = resolve('node_modules/typescript/bin/tsc');
    const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--outDir', out], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const built = readdirSync(out).sort();
    expect(readdirSync('dist').sort()).toEqual(built);
    for (const f of built) {
      expect(readFileSync(join('dist', f), 'utf8'), `dist/${f} is out of date: run npm run build`).toBe(readFileSync(join(out, f), 'utf8'));
    }
  }, 60000);
});
