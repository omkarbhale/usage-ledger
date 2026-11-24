import { currentWeek } from './budgets.js';
import { readUsageRecords, type SessionSpan, sumRecords } from './sessions.js';
import type { SnapshotSource, Store } from './store.js';

/** The time a report or listing covers. */
export interface TimeWindow {
  /** all: every session in the logs; week: the current week; since: usage after a given time. */
  kind: 'all' | 'week' | 'since';
  /** Start of the window, ISO, inclusive. Null for all. */
  from: string | null;
  /** End of the window, ISO, exclusive: the next weekly reset (or now) for week. Null otherwise. */
  to: string | null;
  /**
   * week only. reset-time: the week runs from the latest reading's reset time back seven days.
   * last-seven-days: no reading gives a reset time yet, so the week is the seven days up to now.
   */
  basis: 'reset-time' | 'last-seven-days' | null;
  /** week only: where the latest reading came from. */
  source: SnapshotSource | null;
}

export const ALL_TIME: TimeWindow = { kind: 'all', from: null, to: null, basis: null, source: null };

export function weekWindow(store: Store | undefined, now: Date): TimeWindow {
  const w = currentWeek(store, now);
  return {
    kind: 'week',
    from: w.from,
    to: w.to,
    basis: w.fromResetTime ? 'reset-time' : 'last-seven-days',
    source: w.fromResetTime ? w.source : null,
  };
}

/** Parse --since: an ISO time or date (a date alone means its start, UTC). Undefined when not a time. */
export function parseSince(raw: string): TimeWindow | undefined {
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return undefined;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return undefined;
  return { kind: 'since', from: new Date(ms).toISOString(), to: null, basis: null, source: null };
}

/** A session cut to its usage inside a window. */
export interface ClippedSpan extends SessionSpan {
  /** The part of the session's tokens inside the window, 0 to 1. 1 when it lies wholly inside. */
  fraction: number;
  /** True when part of the session's usage fell outside the window and was left out. */
  clipped: boolean;
  /** The whole session, as the logs give it. */
  whole: SessionSpan;
}

const inside = (at: string, w: TimeWindow) => (!w.from || at >= w.from) && (!w.to || at < w.to);

/**
 * The sessions with usage inside the window, each cut to that usage. A session wholly inside
 * is kept as it is. A session that runs across the window's start (or end) is cut to its log
 * records inside the window; its estimated cost is scaled by the share of its tokens kept.
 * When its log file cannot be read, it is kept whole and not marked clipped.
 */
export function clipToWindow(spans: SessionSpan[], w: TimeWindow, logsDir?: string): ClippedSpan[] {
  const out: ClippedSpan[] = [];
  for (const s of spans) {
    if ((w.from && s.end < w.from) || (w.to && s.start >= w.to)) continue;
    if (inside(s.start, w) && inside(s.end, w)) {
      out.push({ ...s, fraction: 1, clipped: false, whole: s });
      continue;
    }
    const records = readUsageRecords(s.sessionId, logsDir);
    if (!records) {
      out.push({ ...s, fraction: 1, clipped: false, whole: s });
      continue;
    }
    const kept = sumRecords(records.filter((r) => inside(r.at, w)));
    if (!kept.start || !kept.end) continue;
    const { start, end, ...tokens } = kept;
    const fraction = s.totalTokens > 0 ? Math.min(1, tokens.totalTokens / s.totalTokens) : 1;
    out.push({
      ...s,
      ...tokens,
      start,
      end,
      models: tokens.models.length > 0 ? tokens.models : s.models,
      costUsd: typeof s.costUsd === 'number' ? s.costUsd * fraction : s.costUsd,
      fraction,
      clipped: true,
      whole: s,
    });
  }
  return out;
}
