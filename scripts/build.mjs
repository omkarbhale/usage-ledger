#!/usr/bin/env node
// Builds dist/ from src/ with TypeScript when it is installed. When it is not
// (the install fell back to the vendored copy because the registry could not
// be reached), it keeps the prebuilt dist/ that is committed with the source.
// A test checks that the committed dist/ matches what src/ builds to.
// Usage: node scripts/build.mjs
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const cli = join(root, 'dist', 'cli.js');

if (existsSync(tsc)) {
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  chmodSync(cli, 0o755);
  process.exit(0);
}
if (existsSync(cli)) {
  chmodSync(cli, 0o755);
  process.stderr.write('TypeScript is not installed, so the prebuilt dist/ is kept as it is.\n');
  process.exit(0);
}
process.stderr.write('TypeScript is not installed and there is no prebuilt dist/. Run node scripts/install.mjs first.\n');
process.exit(1);
