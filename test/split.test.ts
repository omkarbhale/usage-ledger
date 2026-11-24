import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSpan } from '../src/sessions.js';
import { Store } from '../src/store.js';
import { weeklyShare } from '../src/weekly.js';

let store: Store;
afterEach(() => store?.close());

function withSnapshots(points: [string, number][]): Store {
  store = Store.open(join(mkdtempSync(join(tmpdir(), 'usage-ledger-split-')), 'ledger.db'));
  for (const [takenAt, weeklyPercent] of points) {
    store.addSnapshot({ takenAt, weeklyPercent, resetsAt: '2026-11-27T10:00:00.000Z', sessionId: null, source: 'statusline' });
  }
  return store;
}

const span = (id: string, start: string, end: string, totalTokens: number, costUsd: number | null): SessionSpan => ({
  sessionId: id,
  project: null,
  start,
  end,
  totalTokens,
  costUsd,
});

describe('weeklyShare: splitting a shared rise', () => {
  const T0 = '2026-11-24T10:00:00.000Z';
  const T1 = '2026-11-24T12:00:00.000Z';

  it('gives a lone session the whole rise', () => {
    const s = withSnapshots([[T0, 20], [T1, 26]]);
    const a = span('a', '2026-11-24T10:10:00.000Z', '2026-11-24T11:00:00.000Z', 2000, 0.09);
    expect(weeklyShare(a, [a], s)).toMatchObject({ status: 'estimated', weeklyPercent: 6, splitBy: null });
  });

  it('splits equal tokens by cost: a 5x pricier model gets 5x the share', () => {
    const s = withSnapshots([[T0, 20], [T1, 26]]);
    const opus = span('opus', '2026-11-24T10:10:00.000Z', '2026-11-24T11:00:00.000Z', 2000, 0.09);
    const sonnet = span('sonnet', '2026-11-24T10:20:00.000Z', '2026-11-24T11:30:00.000Z', 2000, 0.018);
    const all = [opus, sonnet];
    expect(weeklyShare(opus, all, s)).toMatchObject({ status: 'overlapping', weeklyPercent: 5, splitBy: 'cost' });
    expect(weeklyShare(sonnet, all, s)).toMatchObject({ status: 'overlapping', weeklyPercent: 1, splitBy: 'cost' });
  });

  it('counts only the part of another session that fell in the window', () => {
    const s = withSnapshots([[T0, 20], [T1, 24]]);
    const a = span('a', '2026-11-24T10:30:00.000Z', '2026-11-24T11:00:00.000Z', 1000, 0.03);
    // Runs 11:00 to 13:00: half of it, and half its cost (0.03 of 0.06), falls in the window.
    const b = span('b', '2026-11-24T11:00:00.000Z', '2026-11-24T13:00:00.000Z', 1000, 0.06);
    expect(weeklyShare(a, [a, b], s)).toMatchObject({ weeklyPercent: 2, splitBy: 'cost', overlapsWith: ['b'] });
  });

  it('falls back to tokens when a session in the window has no cost', () => {
    const s = withSnapshots([[T0, 20], [T1, 24]]);
    const a = span('a', '2026-11-24T10:10:00.000Z', '2026-11-24T11:00:00.000Z', 3000, 0.01);
    const b = span('b', '2026-11-24T10:20:00.000Z', '2026-11-24T11:30:00.000Z', 1000, null);
    expect(weeklyShare(a, [a, b], s)).toMatchObject({ weeklyPercent: 3, splitBy: 'tokens' });
    expect(weeklyShare(b, [a, b], s)).toMatchObject({ weeklyPercent: 1, splitBy: 'tokens' });
  });

  it('marks the share unknown when there is no snapshot after the session', () => {
    const s = withSnapshots([[T0, 20]]);
    const a = span('a', '2026-11-24T10:10:00.000Z', '2026-11-24T11:00:00.000Z', 1000, 0.01);
    expect(weeklyShare(a, [a], s)).toMatchObject({ status: 'unknown', weeklyPercent: null, splitBy: null });
  });
});
