import type { Snapshot, SnapshotSource } from './store.js';

/** Default warning threshold, in percent of the weekly limit. */
export const DEFAULT_WARN_AT = 80;

export interface WeekStatus {
  /**
   * ok: below the threshold. warning: at or above it.
   * unknown: no snapshot yet. stale: the weekly limit has reset since the last snapshot,
   * so its figure is from the previous week.
   */
  status: 'ok' | 'warning' | 'unknown' | 'stale';
  /** The account's weekly percentage at the last snapshot. Null when unknown. */
  weeklyPercent: number | null;
  /** When the weekly limit resets, ISO, as the last snapshot gave it. */
  resetsAt: string | null;
  /** When the last snapshot was taken, ISO. */
  takenAt: string | null;
  /** Where the last reading came from: statusline or manual. Null when there is none. */
  source: SnapshotSource | null;
  /** The threshold used, in percent. */
  warnAt: number;
  /** True when weeklyPercent is at or above warnAt (and the figure is current). */
  warning: boolean;
  /** A plain sentence, for people. */
  message: string;
}

/** Parse --warn-at: a number above 0 and at most 100. Undefined when it is not one. */
export function parseWarnAt(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_WARN_AT;
  const t = raw.trim();
  const n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  return n > 0 && n <= 100 ? n : undefined;
}

const pct = (p: number) => `${Number(p.toFixed(2))}%`;
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

export function warningText(percent: number, warnAt: number): string {
  return `WARNING: weekly usage ${pct(percent)} is at or above ${pct(warnAt)} of the limit`;
}

export function weekStatus(s: Snapshot | undefined | null, warnAt: number, now: Date): WeekStatus {
  if (!s) {
    return {
      status: 'unknown',
      weeklyPercent: null,
      resetsAt: null,
      takenAt: null,
      source: null,
      warnAt,
      warning: false,
      message: 'No weekly figure yet: no reading has been recorded (status line or usage-ledger reading).',
    };
  }
  const base = { weeklyPercent: s.weeklyPercent, resetsAt: s.resetsAt, takenAt: s.takenAt, source: s.source, warnAt };
  if (s.resetsAt && Date.parse(s.resetsAt) <= now.getTime()) {
    return {
      ...base,
      status: 'stale',
      warning: false,
      message:
        `The weekly limit reset at ${utc(s.resetsAt)}, after the last reading (${utc(s.takenAt)}). ` +
        'No figure for this week yet.',
    };
  }
  const warning = s.weeklyPercent >= warnAt;
  return {
    ...base,
    status: warning ? 'warning' : 'ok',
    warning,
    message: warning ? warningText(s.weeklyPercent, warnAt) : `Below the ${pct(warnAt)} warning threshold.`,
  };
}
