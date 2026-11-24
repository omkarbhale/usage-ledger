import { roundUsd } from './report.js';
import type { SessionSpan } from './sessions.js';
import type { Label, Store } from './store.js';
import { weeklyShare } from './weekly.js';
import { ALL_TIME, type TimeWindow } from './window.js';

export interface ListedSession {
  sessionId: string;
  /** ISO time of the session's first usage record. */
  start: string;
  /** ISO time of its last usage record. */
  end: string;
  /** The labelled project, otherwise the project folder from the logs. Null when neither. */
  project: string | null;
  /** The task label. Null when the session has none. */
  task: string | null;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: {
    status: 'estimated' | 'unknown';
    estimated: true;
    usd: number | null;
    source: 'ccusage';
  };
  weekly: {
    status: 'estimated' | 'overlapping' | 'unknown';
    estimated: true;
    weeklyPercent: number | null;
    reason: string | null;
    splitBy: 'cost' | 'tokens' | null;
  };
  /** True when the session began before the window's start; its figures are still the whole session's. */
  startedBeforeWindow: boolean;
}

export interface Listing {
  window: TimeWindow;
  /** Every session with usage in the window, in time order (by start, then session ID). Never ranked. */
  sessions: ListedSession[];
  count: number;
}

/**
 * Many sessions in one answer, each whole, with its start, end, models, tokens, estimated
 * cost and weekly share. In time order, oldest first; never sorted by usage.
 */
export function buildListing(
  spans: SessionSpan[],
  labels: Map<string, Label>,
  store: Store | undefined,
  window: TimeWindow = ALL_TIME,
  every: SessionSpan[] = spans,
): Listing {
  const inWindow = spans.filter(
    (s) => !((window.from && s.end < window.from) || (window.to && s.start >= window.to)),
  );
  inWindow.sort((a, b) => a.start.localeCompare(b.start) || a.sessionId.localeCompare(b.sessionId));
  const sessions = inWindow.map((s): ListedSession => {
    const label = labels.get(s.sessionId);
    const w = weeklyShare(s, every, store);
    const hasCost = typeof s.costUsd === 'number' && Number.isFinite(s.costUsd);
    return {
      sessionId: s.sessionId,
      start: s.start,
      end: s.end,
      project: label?.project ?? s.project ?? null,
      task: label?.task ?? null,
      models: s.models ?? [],
      inputTokens: s.inputTokens ?? 0,
      outputTokens: s.outputTokens ?? 0,
      cacheCreationTokens: s.cacheCreationTokens ?? 0,
      cacheReadTokens: s.cacheReadTokens ?? 0,
      totalTokens: s.totalTokens,
      cost: {
        status: hasCost ? 'estimated' : 'unknown',
        estimated: true,
        usd: hasCost ? roundUsd(s.costUsd as number) : null,
        source: 'ccusage',
      },
      weekly: {
        status: w.status,
        estimated: true,
        weeklyPercent: w.weeklyPercent,
        reason: w.reason,
        splitBy: w.splitBy,
      },
      startedBeforeWindow: window.from !== null && s.start < window.from,
    };
  });
  return { window, sessions, count: sessions.length };
}
