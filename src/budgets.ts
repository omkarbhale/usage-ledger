import type { SessionSpan } from './sessions.js';
import type { Budget, BudgetScope, BudgetUnit, Label, SnapshotSource, Store } from './store.js';
import { weeklyShare } from './weekly.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const round = (n: number) => Math.round(n * 10000) / 10000;

export interface Week {
  /** Start of the current week, ISO. */
  from: string;
  /** End of the current week (the next weekly reset when known), ISO. */
  to: string;
  /**
   * True when the week's bounds come from the reset time in the latest reading that gives
   * one. False: no reading gives a reset time yet, so the week is the seven days up to now.
   */
  fromResetTime: boolean;
  /** Where the latest reading came from: statusline or manual. Null when there is none. */
  source: SnapshotSource | null;
  /** The account's weekly percentage used, from the last snapshot. Null when not known. */
  weeklyPercent: number | null;
  /** When that snapshot was taken. Null when there is none. */
  asOf: string | null;
  /** Why the weekly percentage is not known. Null otherwise. */
  reason: string | null;
}

/**
 * The current week. It runs from the reset time in the latest reading that gives one (a
 * status line snapshot or a hand reading, whichever is newer) back seven days, rolled on by
 * whole weeks when that reset has passed. With no such reading it is the seven days up to now.
 */
export function currentWeek(store: Store | undefined, now: Date): Week {
  const t = now.getTime();
  const latest = store?.latestSnapshot();
  const withReset = store?.latestSnapshotWithReset();
  const source = latest?.source ?? null;
  const iso = (ms: number) => new Date(ms).toISOString();
  if (latest && withReset?.resetsAt) {
    const reset = Date.parse(withReset.resetsAt);
    let to = reset;
    while (to <= t) to += WEEK_MS;
    const from = to - WEEK_MS;
    const sameWeek = to === reset && Date.parse(latest.takenAt) >= from;
    return {
      from: iso(from),
      to: iso(to),
      fromResetTime: true,
      source,
      weeklyPercent: sameWeek ? latest.weeklyPercent : null,
      asOf: latest.takenAt,
      reason: sameWeek ? null : 'the weekly limit reset after the last reading',
    };
  }
  const from = t - WEEK_MS;
  if (!latest) {
    return { from: iso(from), to: iso(t), fromResetTime: false, source, weeklyPercent: null, asOf: null, reason: 'no weekly reading recorded yet' };
  }
  const recent = Date.parse(latest.takenAt) >= from;
  return {
    from: iso(from),
    to: iso(t),
    fromResetTime: false,
    source,
    weeklyPercent: recent ? latest.weeklyPercent : null,
    asOf: latest.takenAt,
    reason: recent ? null : 'no weekly reading in the last seven days',
  };
}

export type BudgetStatus = 'ok' | 'used-up' | 'incomplete';

export interface BudgetUse {
  scope: BudgetScope;
  /** The task for a task budget; null otherwise. */
  task: string | null;
  /** The project for a project budget; null otherwise. */
  project: string | null;
  unit: BudgetUnit;
  limit: number;
  /**
   * What is known to have been used against the limit, in the same unit. Sessions with no
   * figure (no cost, no weekly share) are left out and counted in unknownSessions, never as
   * zero. Null only when there is nothing to count from: a week percent budget with no
   * reading in the current week.
   */
  used: number | null;
  /** limit minus used; zero or negative when used up. Null when used is not known. */
  remaining: number | null;
  /**
   * used-up: used has reached the limit (used >= limit), even when some sessions are not
   * counted. incomplete: not used up, but some use could not be counted. ok: otherwise.
   */
  status: BudgetStatus;
  /** True when status is used-up. */
  usedUp: boolean;
  /** True when used is an estimate (weekly shares, or ccusage's dollar estimates). */
  estimated: boolean;
  /** Sessions counted against the budget, including those with no figure. */
  sessions: number;
  /** Sessions with no figure in the budget's unit, left out of used. Above zero: incomplete. */
  unknownSessions: number;
  /** Why some or all use is not known. Null otherwise. */
  reason: string | null;
  setAt: string;
}

export interface BudgetsResult {
  week: Week;
  budgets: BudgetUse[];
  /** True when any budget is used up; the exit code is then 1. */
  anyUsedUp: boolean;
  /** True when any budget is incomplete; with none used up, the exit code is then 3. */
  anyIncomplete: boolean;
}

const roundUsd = (n: number) => Math.round(n * 1e6) / 1e6;

/** The project a session counts under: the labelled one, otherwise the folder from the logs. */
const projectOf = (s: SessionSpan, labels: Map<string, Label>) => labels.get(s.sessionId)?.project ?? s.project ?? null;

/**
 * Each budget with its use. A task budget counts every session labelled with that task. A
 * project budget and a week budget count the current week: sessions whose last record falls
 * in it (for a project, only that project's). A week percent budget reads the account's
 * weekly percentage from the latest reading instead.
 */
export function budgetUses(
  budgets: Budget[],
  spans: SessionSpan[],
  labels: Map<string, Label>,
  store: Store | undefined,
  now: Date,
): BudgetsResult {
  const week = currentWeek(store, now);
  const from = Date.parse(week.from);
  const to = Date.parse(week.to);
  const inWeek = spans.filter((s) => {
    const end = Date.parse(s.end);
    return end >= from && end < to;
  });
  const uses = budgets.map((b): BudgetUse => {
    let used: number | null = null;
    let sessions = 0;
    let unknownSessions = 0;
    let estimated = false;
    let reason: string | null = null;
    if (b.scope === 'week' && b.unit === 'percent') {
      used = week.weeklyPercent;
      reason = week.reason;
    } else {
      const mine =
        b.scope === 'task'
          ? spans.filter((s) => labels.get(s.sessionId)?.task === b.task)
          : b.scope === 'project'
            ? inWeek.filter((s) => projectOf(s, labels) === b.project)
            : inWeek;
      sessions = mine.length;
      if (b.unit === 'tokens') {
        used = mine.reduce((n, s) => n + s.totalTokens, 0);
      } else if (b.unit === 'dollars') {
        estimated = true;
        let sum = 0;
        for (const s of mine) {
          if (typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) sum += s.costUsd;
          else unknownSessions += 1;
        }
        used = roundUsd(sum);
        if (unknownSessions > 0) reason = 'no estimated cost for some sessions: their tokens came from the log files, which have no prices';
      } else {
        estimated = true;
        let sum = 0;
        for (const s of mine) {
          const w = weeklyShare(s, spans, store);
          if (w.weeklyPercent === null) unknownSessions += 1;
          else sum += w.weeklyPercent;
        }
        used = round(sum);
        if (unknownSessions > 0) reason = 'no weekly share for some sessions';
      }
    }
    const usedUp = used !== null && used >= b.limit;
    const incomplete = used === null || unknownSessions > 0;
    return {
      scope: b.scope,
      task: b.task,
      project: b.project,
      unit: b.unit,
      limit: b.limit,
      used,
      remaining: used === null ? null : b.unit === 'dollars' ? roundUsd(b.limit - used) : round(b.limit - used),
      status: usedUp ? 'used-up' : incomplete ? 'incomplete' : 'ok',
      usedUp,
      estimated,
      sessions,
      unknownSessions,
      reason,
      setAt: b.setAt,
    };
  });
  return {
    week,
    budgets: uses,
    anyUsedUp: uses.some((u) => u.usedUp),
    anyIncomplete: uses.some((u) => u.status === 'incomplete'),
  };
}
