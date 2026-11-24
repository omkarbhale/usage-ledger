import type { SessionSpan } from './sessions.js';
import type { Label, Store } from './store.js';
import { weeklyShare } from './weekly.js';
import { ALL_TIME, type ClippedSpan, type TimeWindow } from './window.js';

export type ReportBy = 'task' | 'project';

export const UNLABELLED = '(unlabelled)';
export const UNKNOWN_PROJECT = '(unknown project)';

const MAX_NAME = 200;

/** A task or project name: trimmed, not empty, one line, at most 200 characters. Undefined when bad. */
export function cleanName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(name)) return undefined;
  return name;
}

export interface GroupWeekly {
  /**
   * estimated: every session in the group has a figure; partial: some do, and the figure
   * sums only those; unknown: none do.
   */
  status: 'estimated' | 'partial' | 'unknown';
  /** Always true: weekly figures are estimates from account-wide snapshots. */
  estimated: true;
  /** Sum of the known sessions' shares of the weekly limit, in percent. Null when none is known. */
  weeklyPercent: number | null;
  /** True when at least one session's share was split with sessions running at the same time. */
  overlapping: boolean;
  /** Sessions in the group with a weekly figure. */
  knownSessions: number;
  /** Sessions in the group without one. */
  unknownSessions: number;
}

export interface GroupCost {
  /**
   * estimated: every session in the group has a cost; partial: some do, and the figure sums
   * only those; unknown: none do.
   */
  status: 'estimated' | 'partial' | 'unknown';
  /** Always true: costs are ccusage's estimates from model prices, not a bill. */
  estimated: true;
  /** Sum of the known sessions' estimated costs, in US dollars. Null when none is known. */
  usd: number | null;
  /** Where the cost comes from. */
  source: 'ccusage';
  knownSessions: number;
  unknownSessions: number;
}

export interface Group {
  /** The task or project name. Null for sessions with no task label, or no known project. */
  name: string | null;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Input, output, cache write and cache read together. */
  totalTokens: number;
  /**
   * Sessions that ran partly outside the window: only their usage inside it is counted, and
   * their cost and weekly share are scaled by the share of their tokens inside it.
   */
  clippedSessions: number;
  cost: GroupCost;
  weekly: GroupWeekly;
}

export interface Report {
  by: ReportBy;
  /** The time the report covers. */
  window: TimeWindow;
  groups: Group[];
  total: Omit<Group, 'name'>;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

interface Acc {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  clipped: number;
  sum: number;
  known: number;
  unknown: number;
  overlapping: boolean;
  cost: number;
  costKnown: number;
  costUnknown: number;
}

const emptyAcc = (): Acc => ({
  sessions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  clipped: 0,
  sum: 0,
  known: 0,
  unknown: 0,
  overlapping: false,
  cost: 0,
  costKnown: 0,
  costUnknown: 0,
});

/** Dollars rounded to a millionth, to drop floating-point noise. */
export const roundUsd = (n: number) => Math.round(n * 1e6) / 1e6;

function finish(a: Acc): Omit<Group, 'name'> {
  return {
    sessions: a.sessions,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens,
    totalTokens: a.totalTokens,
    clippedSessions: a.clipped,
    cost: {
      status: a.costKnown === 0 ? 'unknown' : a.costUnknown === 0 ? 'estimated' : 'partial',
      estimated: true,
      usd: a.costKnown === 0 ? null : roundUsd(a.cost),
      source: 'ccusage',
      knownSessions: a.costKnown,
      unknownSessions: a.costUnknown,
    },
    weekly: {
      status: a.known === 0 ? 'unknown' : a.unknown === 0 ? 'estimated' : 'partial',
      estimated: true,
      weeklyPercent: a.known === 0 ? null : round(a.sum),
      overlapping: a.overlapping,
      knownSessions: a.known,
      unknownSessions: a.unknown,
    },
  };
}

/** The group a session falls in. Null: no task label, or no known project. */
export function groupOf(span: SessionSpan, label: Label | undefined, by: ReportBy): string | null {
  if (by === 'task') return label?.task ?? null;
  return label?.project ?? span.project ?? null;
}

/**
 * Tokens, estimated cost and weekly share summed per task label or per project. Single sessions are only
 * counted, never listed or ranked. Spans may be cut to a window (clipToWindow); weekly shares are
 * then worked out on the whole sessions and scaled by the part inside the window.
 */
export function buildReport(
  spans: (SessionSpan | ClippedSpan)[],
  labels: Map<string, Label>,
  store: Store | undefined,
  by: ReportBy,
  window: TimeWindow = ALL_TIME,
  /** Every session in the logs, for splitting shared rises. Default: the whole sessions of spans. */
  every?: SessionSpan[],
): Report {
  const groups = new Map<string | null, Acc>();
  const total = emptyAcc();
  const wholes = every ?? spans.map((s) => ('whole' in s ? s.whole : s));
  for (const span of spans) {
    const key = groupOf(span, labels.get(span.sessionId), by);
    let acc = groups.get(key);
    if (!acc) groups.set(key, (acc = emptyAcc()));
    const clipped = 'whole' in span && span.clipped;
    const fraction = 'whole' in span ? span.fraction : 1;
    const share = weeklyShare('whole' in span ? span.whole : span, wholes, store);
    const w = {
      ...share,
      weeklyPercent: share.weeklyPercent === null ? null : share.weeklyPercent * fraction,
    };
    for (const a of [acc, total]) {
      a.sessions += 1;
      a.inputTokens += span.inputTokens ?? 0;
      a.outputTokens += span.outputTokens ?? 0;
      a.cacheCreationTokens += span.cacheCreationTokens ?? 0;
      a.cacheReadTokens += span.cacheReadTokens ?? 0;
      a.totalTokens += span.totalTokens;
      if (clipped) a.clipped += 1;
      if (typeof span.costUsd === 'number') {
        a.costKnown += 1;
        a.cost += span.costUsd;
      } else a.costUnknown += 1;
      if (w.weeklyPercent === null) a.unknown += 1;
      else {
        a.known += 1;
        a.sum += w.weeklyPercent;
        if (w.status === 'overlapping') a.overlapping = true;
      }
    }
  }
  const list: Group[] = [...groups].map(([name, acc]) => ({ name, ...finish(acc) }));
  // Named groups by tokens, largest first; the catch-all group last.
  list.sort((a, b) => {
    if ((a.name === null) !== (b.name === null)) return a.name === null ? 1 : -1;
    return b.totalTokens - a.totalTokens || String(a.name).localeCompare(String(b.name));
  });
  return { by, window, groups: list, total: finish(total) };
}
