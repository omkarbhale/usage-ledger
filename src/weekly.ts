import type { SessionSpan } from './sessions.js';
import type { Snapshot, Store } from './store.js';

export interface SnapshotPoint {
  at: string;
  weeklyPercent: number;
}

export interface WeeklyShare {
  /** estimated: one session between two snapshots; overlapping: the rise was split; unknown: no figure. */
  status: 'estimated' | 'overlapping' | 'unknown';
  /** Always true: the figure is an estimate from account-wide snapshots. */
  estimated: true;
  /** This session's share of the weekly limit, in percent. Null when unknown. */
  weeklyPercent: number | null;
  /** Why the share is unknown. Null otherwise. */
  reason: string | null;
  /** The last snapshot at or before the session started. */
  before: SnapshotPoint | null;
  /** The first snapshot at or after the session ended. */
  after: SnapshotPoint | null;
  /** The account's rise between the two snapshots, in percent. */
  rise: number | null;
  /** Other sessions active between the two snapshots, which share the rise. */
  overlapsWith: string[];
  /**
   * How an overlapping rise was split: by each session's estimated cost (which weighs the
   * model as well as the tokens), or by tokens when a session in the window has no cost.
   * Null when the session was alone or its share is unknown.
   */
  splitBy: 'cost' | 'tokens' | null;
}

const RESET_TOLERANCE_MS = 60 * 60 * 1000;

const point = (s: Snapshot | undefined): SnapshotPoint | null =>
  s ? { at: s.takenAt, weeklyPercent: s.weeklyPercent } : null;

const round = (n: number) => Math.round(n * 10000) / 10000;

/** The part of a session (0 to 1) that fell between two times, assuming an even rate. */
function fractionWithin(s: SessionSpan, from: number, to: number): number {
  const a = Date.parse(s.start);
  const b = Date.parse(s.end);
  if (b <= a) return a >= from && a <= to ? 1 : 0;
  const overlap = Math.min(b, to) - Math.max(a, from);
  if (overlap < 0) return 0;
  return overlap / (b - a);
}

const hasCost = (s: SessionSpan) => typeof s.costUsd === 'number' && Number.isFinite(s.costUsd);

/**
 * A session's share of the weekly limit: the account's rise between the last snapshot before
 * it started and the first after it ended. When other sessions were active in between, the
 * rise is split in proportion to each one's estimated cost in that window, so a session on a
 * model that costs more per token gets a larger part. Effort level has no weight of its own:
 * it shows up as tokens, which the cost already counts. When any session in the window has no
 * cost (log-file fallback), the split falls back to tokens and says so.
 */
export function weeklyShare(
  target: SessionSpan | undefined,
  all: SessionSpan[],
  store: Store | undefined,
): WeeklyShare {
  const unknown = (
    reason: string,
    before: Snapshot | undefined = undefined,
    after: Snapshot | undefined = undefined,
  ): WeeklyShare => ({
    status: 'unknown',
    estimated: true,
    weeklyPercent: null,
    reason,
    before: point(before),
    after: point(after),
    rise: before && after ? round(after.weeklyPercent - before.weeklyPercent) : null,
    overlapsWith: [],
    splitBy: null,
  });

  if (!target) return unknown('the session has no timed usage records');
  if (!store) return unknown('no weekly snapshots recorded yet');
  const before = store.snapshotAtOrBefore(target.start);
  const after = store.snapshotAtOrAfter(target.end);
  if (!before && !after) return unknown('no snapshot before the session started or after it ended');
  if (!before) return unknown('no snapshot before the session started', before, after);
  if (!after) return unknown('no snapshot after the session ended', before, after);

  const rise = after.weeklyPercent - before.weeklyPercent;
  const resetBetween =
    rise < 0 ||
    (before.resetsAt !== null &&
      after.resetsAt !== null &&
      Math.abs(Date.parse(before.resetsAt) - Date.parse(after.resetsAt)) > RESET_TOLERANCE_MS);
  if (resetBetween) return unknown('the weekly limit reset between the snapshots', before, after);

  const from = Date.parse(before.takenAt);
  const to = Date.parse(after.takenAt);
  const others = all.filter(
    (s) => s.sessionId !== target.sessionId && fractionWithin(s, from, to) > 0,
  );
  let share = rise;
  let splitBy: WeeklyShare['splitBy'] = null;
  if (others.length > 0) {
    splitBy = hasCost(target) && others.every(hasCost) ? 'cost' : 'tokens';
    const weight = (s: SessionSpan) =>
      splitBy === 'cost' ? (s.costUsd as number) : s.totalTokens;
    const own = weight(target);
    const sum = own + others.reduce((n, s) => n + weight(s) * fractionWithin(s, from, to), 0);
    share = sum > 0 ? (rise * own) / sum : rise / (others.length + 1);
  }
  return {
    status: others.length > 0 ? 'overlapping' : 'estimated',
    estimated: true,
    weeklyPercent: round(share),
    reason: null,
    before: point(before),
    after: point(after),
    rise: round(rise),
    overlapsWith: others.map((s) => s.sessionId).sort(),
    splitBy,
  };
}
