import type { Snapshot } from './store.js';

export class StatuslineInputError extends Error {}

/** A time from the status line: an ISO string, or seconds (or milliseconds) since 1970. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

/**
 * Read Claude Code's status line input. Returns the snapshot it carries, or null when it
 * carries no weekly figure (as before the first reply, or for accounts without one).
 */
export function parseStatusline(text: string, takenAt: string): Snapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StatuslineInputError('Status line input is not JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new StatuslineInputError('Status line input is not a JSON object.');
  }
  const d = data as Record<string, any>;
  const week = d.rate_limits?.seven_day;
  const pct = week?.used_percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  if (pct < 0 || pct > 1000) {
    throw new StatuslineInputError(`Weekly percentage out of range: ${pct}.`);
  }
  const sessionId =
    typeof d.session_id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(d.session_id)
      ? d.session_id
      : null;
  return { takenAt, weeklyPercent: pct, resetsAt: toIso(week.resets_at), sessionId, source: 'statusline' };
}

export function formatPercent(p: number): string {
  return `${Number(p.toFixed(2))}%`;
}

/** The short line Claude Code shows under the prompt. */
export function statusText(s: Snapshot | null): string {
  if (!s) return 'Week: no figure yet';
  const resets = s.resetsAt ? `, resets ${s.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  return `Week: ${formatPercent(s.weeklyPercent)} used${resets}`;
}
