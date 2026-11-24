#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { budgetUses, type BudgetsResult, type BudgetUse } from './budgets.js';
import {
  buildReport,
  cleanName,
  type GroupCost,
  type Report,
  type ReportBy,
  roundUsd,
  UNKNOWN_PROJECT,
  UNLABELLED,
} from './report.js';
import {
  isValidSessionId,
  listSessions,
  LookupError,
  lookupSession,
  type LookupOptions,
  type SessionUsage,
} from './sessions.js';
import { formatPercent, parseStatusline, StatuslineInputError, statusText } from './statusline.js';
import { type BudgetScope, type BudgetUnit, dbPath, type Snapshot, Store } from './store.js';
import { DEFAULT_WARN_AT, parseWarnAt, warningText, weekStatus, type WeekStatus } from './week.js';
import { weeklyShare, type WeeklyShare } from './weekly.js';
import { buildListing, type Listing } from './listing.js';
import { ALL_TIME, clipToWindow, parseSince, type TimeWindow, weekWindow } from './window.js';

export const SCHEMA_VERSION = 1;
export const VERSION = '0.1.0';

export const HELP = `usage-ledger: tokens, estimated cost and weekly-limit share per
coding-agent session, summed per task and per project.

Usage:
  usage-ledger session <session-id> [--json]   One session's tokens, its estimated cost in
                                               USD, its models (and effort, when logged) and
                                               its estimated share of the weekly limit.
  usage-ledger label <session-id> --task <name> [--project <name>] [--json]
                                               Attach a task (and optionally a project) to a
                                               session. Labelling again replaces the label.
  usage-ledger report [--week | --since <time>] [--by task|project] [--json]
                                               Input, output and total tokens, estimated cost
                                               (USD) and weekly share summed per task label
                                               (default) or per project. Sessions are counted,
                                               not listed.
  usage-ledger sessions [--week | --since <time>] [--json]
                                               Many sessions in one answer, oldest first, each
                                               with start, end, models, tokens, cost and weekly
                                               share. Never ranked by usage.
  usage-ledger budget set --task <name> | --project <name> | --week
                          --tokens <n> | --percent <p> | --dollars <usd> [--json]
                                               Set a budget for a task, for a project this
                                               week, or for the week, in tokens, percent of
                                               the weekly limit or dollars. Setting it again
                                               replaces it.
  usage-ledger budget remove --task <name> | --project <name> | --week [--json]
                                               Remove that task's, project's or the week's
                                               budgets.
  usage-ledger budgets [--json]                Each budget with its use. Exits 1 when any
                                               budget is used up, 3 when none is but some
                                               use could not be counted, 0 otherwise.
  usage-ledger week [--warn-at <p>] [--json]  The latest weekly percentage and when it resets.
                                               At or above the threshold it prints a warning
                                               and exits 3.
  usage-ledger reading --percent <p> --resets-at <time> [--at <time>] [--json]
                                               Record the account's weekly percentage by hand,
                                               as shown in Claude Code's /usage or account page.
  usage-ledger statusline [--at <time>] [--warn-at <p>] [--json]
                                               Read Claude Code's status line JSON on stdin,
                                               store the weekly percentage, print a short line,
                                               with a warning at or above the threshold.
  usage-ledger <command> --help                Short help for one command.
  usage-ledger --help                          This help.
  usage-ledger --version                       The version.

Writing an orchestrator? docs/orchestrator.md explains every --json field, every exit
code and the labelling flow, with an example per command.

Options:
  --json        Print one JSON object with a schemaVersion field, for programs.
  --at <time>   statusline and reading only: record the reading at this ISO time instead of now.
  --resets-at <time>
                reading only: when the weekly limit resets, as an ISO time.
  --task <name> label: the task the session did (required, not empty).
                budget: the task the budget is for.
  --week        budget: the budget is for the current week.
  --tokens <n>  budget set only: the limit in tokens (a whole number above 0).
  --percent <p> budget set: the limit in percent of the weekly limit (above 0, at most 100).
                reading: the weekly percentage used (0 to 100).
  --dollars <usd>
                budget set only: the limit in US dollars of estimated cost (above 0).
  --project <name>
                label: the project. Unset: the project folder from the logs.
                budget: the project the budget is for, in the current week.
  --by <group>  report only: task or project. Default: task.
  --week        report and sessions: only usage in the current week.
  --since <time>
                report and sessions: only usage at or after this ISO time or date.
  --warn-at <p> week and statusline only: warn at or above this weekly percentage
                (above 0, at most 100). Default: ${DEFAULT_WARN_AT}.

Estimated cost: in US dollars, as ccusage prices each model's tokens. It is an estimate,
not a bill. It is unknown when ccusage cannot read a session and the ledger falls back to
the session's log file. A group's cost sums the sessions that have one, and says how many
do not.

Readings: each weekly figure is stored with where it came from, statusline or manual
(usage-ledger reading). Both count the same for weekly shares, the week and budgets.

Weekly share: the rise in the account's weekly percentage between the last snapshot
before a session started and the first after it ended. It is always an estimate. It is
marked overlapping when other sessions ran in between: the rise is then split in
proportion to each session's estimated cost, so a session on a model that costs more
per token gets a larger part. When a session in the window has no cost, the split
falls back to tokens. Effort level has no weight of its own; it shows up as tokens.
It is unknown when there is no snapshot on one side or the limit reset in between.

Environment:
  USAGE_LEDGER_LOGS   Claude Code data folder to read (the one holding projects/).
                      Default: ~/.config/claude and ~/.claude.
  USAGE_LEDGER_DB     Database file. Default: ~/.usage-ledger/ledger.db (owner-only).

A group's weekly share sums the shares of its sessions that have one. It is marked
partial when some sessions in the group have no figure.

The current week runs from the reset time in the latest reading (status line or hand)
back seven days, not from a calendar Monday. With no reading that gives a reset time,
it is the seven days up to now, and budgets says so.

Budgets: a task budget counts every session labelled with that task. A project budget
counts that project's sessions whose last record falls in the current week. A week
budget counts every session whose last record falls in the current week; in percent,
it is the account's weekly percentage at the last reading. Dollars sum ccusage's
estimated costs; percent sums each session's estimated weekly share. A budget is used
up as soon as its use reaches its limit. A session with no cost or no weekly share is
never counted as zero: the budget shows its known use, how many sessions are
uncounted, and status incomplete (unless the known use already reaches the limit).

Near-limit warning: week reads the latest reading, status line or hand. It warns when
that figure is at or above --warn-at. When the limit has reset since that reading, the
figure is from the previous week, so week shows it as stale and does not warn. When
there is no reading yet, it says so and exits 0. statusline always exits 0, even when
it warns, so Claude Code keeps showing the line.

Exit codes: 0 done, 1 session not found, logs missing or bad status line input,
2 wrong usage (including a bad session ID, an empty task name, or a bad reading),
3 for week: the weekly percentage is at or above --warn-at.
For budgets: 1 at least one budget used up; 3 none used up, but at least one
incomplete; 2 an error (wrong usage, logs missing); 0 all ok.
`;

const JSON_LINE = `  --json          One JSON object with a schemaVersion field, for programs.
                  Fields: docs/orchestrator.md.`;

/** Short help for each command, shown by usage-ledger <command> --help. */
export const COMMAND_HELP: Record<string, string> = {
  session: `usage-ledger session <session-id> [--json]

One session's tokens (input, output, cache write, cache read, total), its estimated
cost in USD (from ccusage), the model or models it used, its effort level when the
log records one, and its estimated share of the weekly limit.

${JSON_LINE}

Exit codes: 0 found; 1 no session with that ID, or the log folder is missing;
2 not a valid session ID, or wrong usage.
`,
  label: `usage-ledger label <session-id> --task <name> [--project <name>] [--json]

Attach a task, and optionally a project, to a session. Run it after spawning a
session. Labelling again replaces the label. The session need not have logs yet.

  --task <name>      The task the session did. Required, not empty, one line,
                     at most 200 characters.
  --project <name>   The project. Unset: the project folder from the logs.
${JSON_LINE}

Exit codes: 0 labelled; 2 a bad session ID, an empty name, or wrong usage.
`,
  report: `usage-ledger report [--week | --since <time>] [--by task|project] [--json]

Input tokens, output tokens, cache and total tokens, estimated cost (USD) and
weekly share summed per task label (the default) or per project, with a total.
Sessions are counted, not listed. Sessions with no task label are grouped as
(unlabelled).

  --by <group>     task or project. Default: task.
  --week           Only usage in the current week: from the latest reading's reset
                   time back seven days (the last seven days when no reading has one).
  --since <time>   Only usage at or after this ISO time or date (a date means its
                   start, UTC).
A session that ran partly outside the time is counted only for its usage inside
it, read from its log; its cost and weekly share are scaled by the same part.

${JSON_LINE}

Exit codes: 0 done; 1 the log folder is missing; 2 a bad --since time, or wrong usage.
`,
  sessions: `usage-ledger sessions [--week | --since <time>] [--json]

Many sessions in one answer, oldest first: each with its start, end, project, task,
models, input, output and total tokens, estimated cost (USD) and weekly share.
The order is time, never usage: compare tasks and projects with usage-ledger report.

  --week           Only sessions with usage in the current week.
  --since <time>   Only sessions with usage at or after this ISO time or date.
A session that began before that time is listed whole, and marked so.

${JSON_LINE}

Exit codes: 0 done; 1 the log folder is missing; 2 a bad --since time, or wrong usage.
`,
  budget: `usage-ledger budget set --task <name> | --project <name> | --week
                        --tokens <n> | --percent <p> | --dollars <usd> [--json]
usage-ledger budget remove --task <name> | --project <name> | --week [--json]

Set a budget for a task, for a project in the current week, or for the current
week, in tokens, percent of the weekly limit or dollars of estimated cost. Setting
the same scope and unit again replaces it. remove deletes every budget of that
task, project or the week.

  --task <name>     The task the budget is for (all its sessions).
  --project <name>  The project the budget is for (its sessions this week).
  --week            The budget is for the current week (all sessions).
  --tokens <n>      The limit in tokens: a whole number above 0.
  --percent <p>     The limit in percent of the weekly limit: above 0, at most 100.
  --dollars <usd>   The limit in US dollars: above 0, such as 5 or 2.50.
${JSON_LINE}

Exit codes: 0 done; 2 a bad limit, an empty name, or wrong usage.
See the budgets with usage-ledger budgets.
`,
  budgets: `usage-ledger budgets [--json]

Each budget with its limit, its use and its status: ok, USED UP or incomplete.
A budget is used up as soon as its use reaches its limit. It is incomplete when
some sessions have no cost or no weekly share: they are left out of its use,
never counted as zero, and the count of uncounted sessions is shown.
A task budget counts every session labelled with that task. A project or week
budget counts the current week, up to the next weekly reset.

${JSON_LINE}

Exit codes: 0 all ok; 1 at least one budget used up; 3 none used up, but at
least one incomplete; 2 the log folder is missing, or wrong usage.
`,
  week: `usage-ledger week [--warn-at <p>] [--json]

The account's weekly percentage at the latest reading (status line or hand),
when it resets, and a warning at or above the threshold. A figure from before
the last reset shows as stale and does not warn.

  --warn-at <p>   Warn at or above this weekly percentage. Default: ${DEFAULT_WARN_AT}.
${JSON_LINE}

Exit codes: 0 below the threshold, stale or no figure yet; 2 wrong usage;
3 at or above the threshold.
`,
  reading: `usage-ledger reading --percent <p> --resets-at <time> [--at <time>] [--json]

Record the account's weekly usage by hand: the percent used and when the weekly
limit resets, as Claude Code's /usage or the account page shows them. It is stored
with source manual and counts the same as a status line reading. The current week
then runs up to that reset.

  --percent <p>       Weekly percentage used: a number from 0 to 100.
  --resets-at <time>  When the weekly limit resets: an ISO time, after the
                      reading and at most seven days after it.
  --at <time>         Record the reading at this ISO time instead of now.
${JSON_LINE}

Exit codes: 0 recorded; 2 a bad percent or time, or wrong usage.
`,
  statusline: `usage-ledger statusline [--at <time>] [--warn-at <p>] [--json]

Set this as Claude Code's status line command. It reads the status line JSON on
stdin, stores the account's weekly percentage with the time, and prints one short
line, ending with a warning at or above the threshold.

  --at <time>     Record the snapshot at this ISO time instead of now.
  --warn-at <p>   Warn at or above this weekly percentage. Default: ${DEFAULT_WARN_AT}.
${JSON_LINE}

Exit codes: 0 done, even when it warns; 1 the input is not a JSON object, or
its weekly percentage is out of range; 2 wrong usage.
`,
};

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Dollars: four decimals under $1, so small sessions do not show as $0.00; two from $1 up. */
export function formatUsd(n: number): string {
  const digits = n < 1 ? 4 : 2;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const NO_COST =
  'ccusage could not read the session, so its tokens came from the log file, which has no prices';

export interface SessionCost {
  /** estimated: ccusage gave a cost; unknown: it did not. */
  status: 'estimated' | 'unknown';
  /** Always true: the cost is ccusage's estimate from model prices, not a bill. */
  estimated: true;
  /** Estimated cost in US dollars. Null when unknown. */
  usd: number | null;
  source: 'ccusage';
  /** Why the cost is unknown; only when it is. */
  reason?: string;
}

export function sessionCost(s: SessionUsage): SessionCost {
  if (s.costUsd === null) {
    return { status: 'unknown', estimated: true, usd: null, source: 'ccusage', reason: NO_COST };
  }
  return { status: 'estimated', estimated: true, usd: roundUsd(s.costUsd), source: 'ccusage' };
}

function costText(c: SessionCost): string {
  return c.usd === null ? `unknown (${c.reason})` : `${formatUsd(c.usd)} (estimate from ccusage)`;
}

export function weeklyText(w: WeeklyShare): string {
  if (w.weeklyPercent === null) return `unknown (${w.reason})`;
  const marks = w.status === 'overlapping' ? 'estimated, overlapping' : 'estimated';
  return `${formatPercent(w.weeklyPercent)} (${marks})`;
}

function weeklyLines(w: WeeklyShare): string[] {
  const lines = [`Weekly limit used: ${weeklyText(w)}`];
  if (w.before && w.after) {
    lines.push(
      `  Account went from ${formatPercent(w.before.weeklyPercent)} at ${w.before.at}` +
        ` to ${formatPercent(w.after.weeklyPercent)} at ${w.after.at}.`,
    );
  }
  if (w.overlapsWith.length > 0) {
    const by =
      w.splitBy === 'tokens'
        ? 'tokens (a session in the window has no estimated cost)'
        : 'estimated cost';
    lines.push(`  Rise split by ${by} with: ${w.overlapsWith.join(', ')}`);
  }
  return lines;
}

export function sessionTable(s: SessionUsage, w?: WeeklyShare): string {
  const rows: [string, number][] = [
    ['Input', s.inputTokens],
    ['Output', s.outputTokens],
    ['Cache write', s.cacheCreationTokens],
    ['Cache read', s.cacheReadTokens],
    ['Total', s.totalTokens],
  ];
  const labelW = Math.max('Tokens'.length, ...rows.map(([l]) => l.length));
  const numW = Math.max('Count'.length, ...rows.map(([, n]) => fmt(n).length));
  const line = (a: string, b: string) => `${a.padEnd(labelW)}  ${b.padStart(numW)}`;
  const rule = `${'-'.repeat(labelW)}  ${'-'.repeat(numW)}`;
  const body = rows.map(([l, n]) => line(l, fmt(n)));
  return [
    `Session ${s.sessionId}`,
    '',
    line('Tokens', 'Count'),
    rule,
    ...body.slice(0, -1),
    rule,
    body[body.length - 1],
    '',
    `Estimated cost (USD): ${costText(sessionCost(s))}`,
    `${s.models.length === 1 ? 'Model' : 'Models'}: ${s.models.length > 0 ? s.models.join(', ') : 'unknown (none named in the logs)'}`,
    ...(s.effortLevels ? [`Effort: ${s.effortLevels.join(', ')}`] : []),
    ...(w ? ['', ...weeklyLines(w)] : []),
    '',
  ].join('\n');
}

export function sessionJson(s: SessionUsage, w?: WeeklyShare): string {
  return (
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        session: {
          sessionId: s.sessionId,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheCreationTokens: s.cacheCreationTokens,
          cacheReadTokens: s.cacheReadTokens,
          totalTokens: s.totalTokens,
          cost: sessionCost(s),
          source: s.source,
          models: s.models,
          ...(s.effortLevels ? { effortLevels: s.effortLevels } : {}),
          ...(w ? { weekly: w } : {}),
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function weeklyGroupText(w: Report['total']['weekly']): string {
  if (w.weeklyPercent === null) return 'unknown';
  const marks = ['estimated'];
  if (w.overlapping) marks.push('overlapping');
  if (w.status === 'partial') {
    marks.push(`${w.unknownSessions} of ${w.knownSessions + w.unknownSessions} sessions unknown`);
  }
  return `${formatPercent(w.weeklyPercent)} (${marks.join(', ')})`;
}

function groupCostText(c: GroupCost): string {
  if (c.usd === null) return 'unknown';
  if (c.status === 'partial') return `${formatUsd(c.usd)} (${c.unknownSessions} unknown)`;
  return formatUsd(c.usd);
}

/** A plain heading for the time a report or listing covers. */
export function windowText(w: TimeWindow): string {
  if (w.kind === 'all') return 'all sessions in the logs';
  if (w.kind === 'since') return `since ${utc(w.from as string)}`;
  const basis =
    w.basis === 'reset-time'
      ? `from the ${w.source === 'manual' ? 'hand' : 'status line'} reading's reset time`
      : 'no reading gives a reset time yet, so the last seven days';
  return `current week ${utc(w.from as string)} to ${utc(w.to as string)}, ${basis}`;
}

function table(header: string[], rows: string[][], right: number[], footer?: string[]): string[] {
  const all = [header, ...rows, ...(footer ? [footer] : [])];
  const w = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const last = header.length - 1;
  const line = (row: string[]) =>
    row
      .map((c, i) => (i === last ? c : right.includes(i) ? c.padStart(w[i]) : c.padEnd(w[i])))
      .join('  ')
      .trimEnd();
  const rule = w.map((n) => '-'.repeat(n)).join('  ');
  return [line(header), rule, ...rows.map(line), ...(footer ? [rule, line(footer)] : [])];
}

export function reportTable(r: Report): string {
  const head = r.by === 'task' ? 'Task' : 'Project';
  const catchAll = r.by === 'task' ? UNLABELLED : UNKNOWN_PROJECT;
  const cells = (name: string, g: Report['total']) => [
    name,
    fmt(g.sessions),
    fmt(g.inputTokens),
    fmt(g.outputTokens),
    fmt(g.cacheCreationTokens + g.cacheReadTokens),
    fmt(g.totalTokens),
    groupCostText(g.cost),
    weeklyGroupText(g.weekly),
  ];
  const rows = r.groups.map((g) => cells(g.name ?? catchAll, g));
  const title = `Usage by ${r.by}, ${windowText(r.window)}`;
  if (rows.length === 0) {
    const none = r.window.kind === 'all' ? 'No sessions found in the logs.' : 'No usage found in this time.';
    return `${title}\n\n${none}\n`;
  }
  const header = [head, 'Sessions', 'Input', 'Output', 'Cache', 'Total tokens', 'Est. cost (USD)', 'Weekly share'];
  const notes = [
    'Cache is cache write plus cache read. Total tokens counts input, output and cache.',
    'Costs are estimates from ccusage, priced from model list prices; not a bill.',
  ];
  if (r.total.clippedSessions > 0) {
    notes.push(
      `${r.total.clippedSessions} session${r.total.clippedSessions === 1 ? '' : 's'} ran partly outside this time: ` +
        'only usage inside it is counted, and cost and weekly share are scaled to match.',
    );
  }
  return [title, '', ...table(header, rows, [1, 2, 3, 4, 5, 6], cells('Total', r.total)), '', ...notes, ''].join('\n');
}

export function reportJson(r: Report): string {
  const key = r.by;
  return (
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        report: {
          by: r.by,
          window: r.window,
          groups: r.groups.map(({ name, ...rest }) => ({ [key]: name, ...rest })),
          total: r.total,
        },
      },
      null,
      2,
    ) + '\n'
  );
}

export function sessionsTable(l: Listing): string {
  const title = `Sessions in time order, ${windowText(l.window)}`;
  if (l.count === 0) {
    const none = l.window.kind === 'all' ? 'No sessions found in the logs.' : 'No usage found in this time.';
    return `${title}\n\n${none}\n`;
  }
  const header = ['Start', 'End', 'Session', 'Project', 'Task', 'Models', 'Input', 'Output', 'Total tokens', 'Est. cost (USD)', 'Weekly share'];
  const rows = l.sessions.map((s) => [
    utc(s.start),
    utc(s.end),
    s.sessionId,
    s.project ?? UNKNOWN_PROJECT,
    s.task ?? UNLABELLED,
    s.models.length > 0 ? s.models.join(', ') : 'unknown',
    fmt(s.inputTokens),
    fmt(s.outputTokens),
    fmt(s.totalTokens),
    s.cost.usd === null ? 'unknown' : formatUsd(s.cost.usd),
    s.weekly.weeklyPercent === null
      ? `unknown (${s.weekly.reason})`
      : `${formatPercent(s.weekly.weeklyPercent)} (${s.weekly.status === 'overlapping' ? 'estimated, overlapping' : 'estimated'})`,
  ]);
  const notes = [`${l.count} session${l.count === 1 ? '' : 's'}, oldest first. Not ranked: compare tasks and projects with usage-ledger report.`];
  const before = l.sessions.filter((s) => s.startedBeforeWindow).length;
  if (before > 0) notes.push(`${before} began before this time; their figures are for the whole session.`);
  return [title, '', ...table(header, rows, [6, 7, 8, 9]), '', ...notes, ''].join('\n');
}

function limitText(unit: BudgetUnit, n: number): string {
  if (unit === 'dollars') return formatUsd(n);
  return unit === 'tokens' ? `${fmt(n)} tokens` : formatPercent(n);
}

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function usedText(u: BudgetUse, asOf: string | null): string {
  if (u.used === null) return `unknown (${u.reason})`;
  const marks: string[] = [];
  if (u.estimated) marks.push('estimated');
  if (u.unknownSessions > 0) {
    const what = u.unit === 'dollars' ? 'no cost' : 'no weekly share';
    marks.push(`${u.unknownSessions} of ${u.sessions} session${u.sessions === 1 ? '' : 's'} uncounted, ${what}`);
  }
  if (u.scope === 'week' && u.unit === 'percent' && asOf) marks.push(`as of ${utc(asOf)}`);
  return `${limitText(u.unit, u.used)}${marks.length ? ` (${marks.join(', ')})` : ''}`;
}

export function budgetsTable(r: BudgetsResult): string {
  const basis = r.week.fromResetTime
    ? `from the ${r.week.source === 'manual' ? 'hand' : 'status line'} reading's reset time`
    : 'no reading gives a reset time yet, so the last seven days';
  const head = `Budgets (week ${utc(r.week.from)} to ${utc(r.week.to)}, ${basis})`;
  if (r.budgets.length === 0) return `${head}\n\nNo budgets set. Set one with usage-ledger budget set.\n`;
  const header = ['Budget', 'Limit', 'Used', 'Status'];
  const rows = r.budgets.map((u) => [
    u.scope === 'week' ? 'week' : u.scope === 'project' ? `project ${u.project} (week)` : `task ${u.task}`,
    limitText(u.unit, u.limit),
    usedText(u, r.week.asOf),
    u.status === 'used-up' ? 'USED UP' : u.status,
  ]);
  const all = [header, ...rows];
  const w = [0, 1, 2].map((i) => Math.max(...all.map((row) => row[i].length)));
  const line = (row: string[]) =>
    [row[0].padEnd(w[0]), row[1].padStart(w[1]), row[2].padEnd(w[2]), row[3]].join('  ').trimEnd();
  const rule = [...w, 'Status'.length].map((n) => '-'.repeat(n)).join('  ');
  const up = r.budgets.filter((u) => u.usedUp).length;
  const inc = r.budgets.filter((u) => u.status === 'incomplete').length;
  const n = r.budgets.length;
  const parts = [up === 0 ? 'No budget used up.' : `${up} of ${n} budget${n === 1 ? '' : 's'} used up.`];
  if (inc > 0) parts.push(`${inc} incomplete: some use could not be counted.`);
  const summary = parts.join(' ');
  return [head, '', line(header), rule, ...rows.map(line), '', summary, ''].join('\n');
}

export function weekText(w: WeekStatus): string {
  if (w.weeklyPercent === null) return `Week: no figure yet\n\n${w.message}\n`;
  const lines = [
    `Week: ${formatPercent(w.weeklyPercent)} used${w.status === 'stale' ? ' (previous week, stale)' : ''}`,
    `Resets: ${w.resetsAt ? utc(w.resetsAt) : 'unknown'}`,
    `As of: ${utc(w.takenAt as string)} (${w.source === 'manual' ? 'hand reading' : 'status line'})`,
    `Warn at: ${formatPercent(w.warnAt)}`,
    '',
    w.message,
    '',
  ];
  return lines.join('\n');
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Check a hand reading: a percent from 0 to 100, a reset time after the reading and at
 * most seven days after it. Returns the snapshot to store, or a plain message.
 */
export function parseReading(
  percent: string | undefined,
  resetsAt: string | undefined,
  at: string | undefined,
  now: Date,
): { reading: Snapshot } | { error: string } {
  if (percent === undefined) return { error: 'Give the weekly percentage used with --percent <p>.' };
  if (resetsAt === undefined) return { error: 'Give when the weekly limit resets with --resets-at <time>.' };
  const raw = percent.trim();
  const p = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!(p >= 0 && p <= 100)) return { error: `--percent must be a number from 0 to 100, not "${percent}".` };
  const reset = Date.parse(resetsAt);
  if (Number.isNaN(reset)) return { error: `--resets-at is not a time: "${resetsAt}". Use an ISO time, such as 2026-11-27T10:00:00Z.` };
  let taken = now.getTime();
  if (at !== undefined) {
    taken = Date.parse(at);
    if (Number.isNaN(taken)) return { error: `--at is not a time: "${at}". Use an ISO time.` };
  }
  if (reset <= taken) return { error: `--resets-at must be after the reading time (${utc(new Date(taken).toISOString())}).` };
  if (reset - taken > WEEK_MS) return { error: '--resets-at must be at most seven days after the reading time: the weekly limit resets every week.' };
  return {
    reading: {
      takenAt: new Date(taken).toISOString(),
      weeklyPercent: p,
      resetsAt: new Date(reset).toISOString(),
      sessionId: null,
      source: 'manual',
    },
  };
}

function errorJson(code: string, message: string): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: { code, message } }, null, 2) + '\n';
}

export async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  extra: Pick<LookupOptions, 'ccusageScript'> & {
    /** Status line input; default: read standard input. */
    stdin?: () => Promise<string>;
    /** The current time; default: now. */
    now?: () => Date;
  } = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        at: { type: 'string' },
        task: { type: 'string' },
        project: { type: 'string' },
        by: { type: 'string' },
        week: { type: 'boolean', default: false },
        since: { type: 'string' },
        tokens: { type: 'string' },
        percent: { type: 'string' },
        dollars: { type: 'string' },
        'warn-at': { type: 'string' },
        'resets-at': { type: 'string' },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\nRun usage-ledger --help to see the commands.\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const json = values.json === true;
  const usage = (msg: string) => {
    if (json) io.out(errorJson('usage', msg));
    io.err(`${msg}\nRun usage-ledger --help to see the commands.\n`);
    return 2;
  };

  if (values.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    const topic = command === 'help' ? rest[0] : command;
    if (topic === undefined) {
      io.out(HELP);
      return 0;
    }
    const text = COMMAND_HELP[topic];
    if (text === undefined) return usage(`No help for unknown command: ${topic}`);
    io.out(text);
    return 0;
  }
  if (command !== 'week' && command !== 'statusline' && values['warn-at'] !== undefined) {
    return usage('--warn-at works only with week and statusline.');
  }
  const warnAt = parseWarnAt(values['warn-at']);
  if (warnAt === undefined) {
    return usage(`--warn-at must be a number above 0 and at most 100, not "${values['warn-at']}".`);
  }
  if (command === 'statusline') {
    if (rest.length !== 0) return usage('statusline takes no arguments; it reads JSON on stdin.');
    let takenAt = new Date().toISOString();
    if (values.at !== undefined) {
      const t = Date.parse(values.at);
      if (Number.isNaN(t)) return usage(`Not a time: "${values.at}". Use an ISO time.`);
      takenAt = new Date(t).toISOString();
    }
    const text = await (extra.stdin ?? readStdin)();
    let snap;
    try {
      snap = parseStatusline(text, takenAt);
    } catch (e) {
      if (!(e instanceof StatuslineInputError)) throw e;
      if (json) io.out(errorJson('bad-statusline-input', e.message));
      io.err(`${e.message}\n`);
      return 1;
    }
    if (snap) {
      const store = Store.open(dbPath(env));
      try {
        store.addSnapshot(snap);
      } finally {
        store.close();
      }
    }
    const warnMsg = snap !== null && snap.weeklyPercent >= warnAt ? warningText(snap.weeklyPercent, warnAt) : null;
    const warning = warnMsg !== null;
    io.out(
      json
        ? JSON.stringify(
            {
              schemaVersion: SCHEMA_VERSION,
              snapshot: snap,
              warnAt,
              warning,
              ...(warnMsg ? { message: warnMsg } : {}),
            },
            null,
            2,
          ) + '\n'
        : `${statusText(snap)}${warnMsg ? ` | ${warnMsg}` : ''}\n`,
    );
    return 0;
  }
  if (command === 'reading') {
    if (rest.length !== 0) return usage('reading takes no arguments: usage-ledger reading --percent <p> --resets-at <time>');
    if (values['warn-at'] !== undefined) return usage('--warn-at works only with week and statusline.');
    const others = ['task', 'project', 'by', 'tokens', 'dollars'] as const;
    if (others.some((k) => values[k] !== undefined) || values.week) {
      return usage('reading takes only --percent, --resets-at, --at and --json.');
    }
    const bad = (msg: string) => {
      if (json) io.out(errorJson('invalid-reading', msg));
      io.err(`${msg}\n`);
      return 2;
    };
    const r = parseReading(values.percent, values['resets-at'], values.at, extra.now?.() ?? new Date());
    if ('error' in r) return bad(r.error);
    const store = Store.open(dbPath(env));
    try {
      store.addSnapshot(r.reading);
    } finally {
      store.close();
    }
    io.out(
      json
        ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, reading: r.reading }, null, 2) + '\n'
        : `Recorded by hand: ${formatPercent(r.reading.weeklyPercent)} of the weekly limit used, resets ${utc(r.reading.resetsAt as string)}.\n` +
            `The current week now runs ${utc(new Date(Date.parse(r.reading.resetsAt as string) - 7 * 24 * 3600 * 1000).toISOString())} to ${utc(r.reading.resetsAt as string)}.\n`,
    );
    return 0;
  }
  if (values['resets-at'] !== undefined) return usage('--resets-at works only with reading.');
  if (command === 'week') {
    if (rest.length !== 0) return usage('week takes no arguments.');
    const store = Store.openIfExists(dbPath(env));
    let w: WeekStatus;
    try {
      w = weekStatus(store?.latestSnapshot(), warnAt, extra.now?.() ?? new Date());
    } finally {
      store?.close();
    }
    io.out(json ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, week: w }, null, 2) + '\n' : weekText(w));
    return w.warning ? 3 : 0;
  }
  if (values.at !== undefined) return usage('--at works only with statusline and reading.');
  if (command !== 'label' && command !== 'budget' && values.project !== undefined) {
    return usage('--project works only with label and budget.');
  }
  if (command !== 'label' && command !== 'budget' && values.task !== undefined) {
    return usage('--task works only with label and budget.');
  }
  const windowed = command === 'report' || command === 'sessions';
  if (command !== 'budget' && (values.tokens !== undefined || values.percent !== undefined || values.dollars !== undefined)) {
    return usage('--tokens, --percent and --dollars work only with budget.');
  }
  if (command !== 'budget' && !windowed && values.week) return usage('--week works only with report, sessions and budget.');
  if (!windowed && values.since !== undefined) return usage('--since works only with report and sessions.');
  if (values.week && values.since !== undefined) return usage('Give either --week or --since <time>, not both.');
  if (command !== 'report' && values.by !== undefined) return usage('--by works only with report.');
  const refuse = (code: string, msg: string) => {
    if (json) io.out(errorJson(code, msg));
    io.err(`${msg}\n`);
    return 2;
  };

  if (command === 'label') {
    if (rest.length !== 1) {
      return usage('Give exactly one session ID: usage-ledger label <session-id> --task <name>');
    }
    const id = rest[0];
    if (!isValidSessionId(id)) {
      return refuse(
        'invalid-session-id',
        `Not a valid session ID: "${id}". Use letters, digits, dots, dashes or underscores.`,
      );
    }
    if (values.task === undefined) return refuse('invalid-task', 'Give a task name with --task <name>.');
    const task = cleanName(values.task);
    if (task === undefined) {
      return refuse('invalid-task', 'The task name must not be empty, must fit on one line and be at most 200 characters.');
    }
    let project: string | null = null;
    if (values.project !== undefined) {
      const p = cleanName(values.project);
      if (p === undefined) {
        return refuse('invalid-project', 'The project name must not be empty, must fit on one line and be at most 200 characters.');
      }
      project = p;
    }
    const label = { sessionId: id, task, project, labelledAt: new Date().toISOString() };
    const store = Store.open(dbPath(env));
    let replaced: boolean;
    try {
      replaced = store.setLabel(label);
    } finally {
      store.close();
    }
    if (json) {
      io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, label, replaced }, null, 2) + '\n');
    } else {
      const proj = project === null ? '' : `, project "${project}"`;
      io.out(`${replaced ? 'Relabelled' : 'Labelled'} session ${id}: task "${task}"${proj}.\n`);
    }
    return 0;
  }

  const pickWindow = (store: Store | undefined): TimeWindow | undefined => {
    if (values.week) return weekWindow(store, extra.now?.() ?? new Date());
    if (values.since !== undefined) return parseSince(values.since);
    return ALL_TIME;
  };
  const badSince = () =>
    refuse('invalid-time', `--since is not a time: "${values.since}". Use an ISO time or date, such as 2026-11-20T10:00:00Z.`);
  if (values.since !== undefined && parseSince(values.since) === undefined) return badSince();

  if (command === 'sessions') {
    if (rest.length !== 0) return usage('sessions takes no arguments. Use --week or --since <time> to limit it.');
    const logsDir = env.USAGE_LEDGER_LOGS || undefined;
    if (logsDir && !existsSync(logsDir)) {
      const msg = `Log folder not found: ${logsDir}`;
      if (json) io.out(errorJson('logs-not-found', msg));
      io.err(`${msg}\n`);
      return 1;
    }
    const store = Store.openIfExists(dbPath(env));
    let listing: Listing;
    try {
      const window = pickWindow(store) as TimeWindow;
      const spans = await listSessions({ logsDir, ccusageScript: extra.ccusageScript });
      listing = buildListing(spans, store?.labels() ?? new Map(), store, window);
    } finally {
      store?.close();
    }
    io.out(json ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, listing }, null, 2) + '\n' : sessionsTable(listing));
    return 0;
  }

  if (command === 'report') {
    if (rest.length !== 0) return usage('report takes no arguments. Use --by task or --by project.');
    const by = (values.by ?? 'task') as ReportBy;
    if (by !== 'task' && by !== 'project') return usage(`--by must be task or project, not "${values.by}".`);
    const logsDir = env.USAGE_LEDGER_LOGS || undefined;
    if (logsDir && !existsSync(logsDir)) {
      const msg = `Log folder not found: ${logsDir}`;
      if (json) io.out(errorJson('logs-not-found', msg));
      io.err(`${msg}\n`);
      return 1;
    }
    const store = Store.openIfExists(dbPath(env));
    let report: Report;
    try {
      const window = pickWindow(store);
      if (!window) return badSince();
      const spans = await listSessions({ logsDir, ccusageScript: extra.ccusageScript });
      const kept = window.kind === 'all' ? spans : clipToWindow(spans, window, logsDir);
      report = buildReport(kept, store?.labels() ?? new Map(), store, by, window, spans);
    } finally {
      store?.close();
    }
    io.out(json ? reportJson(report) : reportTable(report));
    return 0;
  }

  if (command === 'budget') {
    const [action, ...more] = rest;
    if ((action !== 'set' && action !== 'remove') || more.length !== 0) {
      return usage('Use budget set or budget remove: usage-ledger budget set --task <name> --tokens <n>');
    }
    const scopes = [values.task !== undefined, values.project !== undefined, values.week].filter(Boolean).length;
    if (scopes !== 1) return usage('Give one of --task <name>, --project <name> or --week.');
    let task: string | null = null;
    let project: string | null = null;
    if (values.task !== undefined) {
      const t = cleanName(values.task);
      if (t === undefined) {
        return refuse('invalid-task', 'The task name must not be empty, must fit on one line and be at most 200 characters.');
      }
      task = t;
    }
    if (values.project !== undefined) {
      const p = cleanName(values.project);
      if (p === undefined) {
        return refuse('invalid-project', 'The project name must not be empty, must fit on one line and be at most 200 characters.');
      }
      project = p;
    }
    const scope: BudgetScope = task !== null ? 'task' : project !== null ? 'project' : 'week';
    const what = task !== null ? `task "${task}"` : project !== null ? `project "${project}" (current week)` : 'the week';
    const limits = [values.tokens, values.percent, values.dollars].filter((v) => v !== undefined).length;
    if (action === 'remove') {
      if (limits !== 0) {
        return usage('budget remove takes no --tokens, --percent or --dollars; it removes every budget of that task, project or the week.');
      }
      const store = Store.open(dbPath(env));
      let removed: number;
      try {
        removed = store.removeBudgets(scope, task ?? project);
      } finally {
        store.close();
      }
      if (json) io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, removed: { scope, task, project, count: removed } }, null, 2) + '\n');
      else io.out(removed === 0 ? `No budget set for ${what}.\n` : `Removed ${removed} budget${removed === 1 ? '' : 's'} for ${what}.\n`);
      return 0;
    }
    if (limits !== 1) return usage('Give one of --tokens <n>, --percent <p> or --dollars <usd>.');
    let unit: BudgetUnit;
    let limit: number;
    if (values.tokens !== undefined) {
      unit = 'tokens';
      limit = /^\d+$/.test(values.tokens.trim()) ? Number(values.tokens.trim()) : NaN;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        return refuse('invalid-limit', `--tokens must be a whole number above 0, not "${values.tokens}".`);
      }
    } else if (values.percent !== undefined) {
      unit = 'percent';
      const raw = values.percent.trim();
      limit = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      if (!(limit > 0 && limit <= 100)) {
        return refuse('invalid-limit', `--percent must be a number above 0 and at most 100, not "${values.percent}".`);
      }
    } else {
      unit = 'dollars';
      const raw = (values.dollars as string).trim().replace(/^\$/, '');
      limit = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
      if (!(limit > 0 && limit <= 1e9)) {
        return refuse('invalid-limit', `--dollars must be an amount in US dollars above 0, such as 5 or 2.50, not "${values.dollars}".`);
      }
    }
    const budget = { scope, task, project, unit, limit, setAt: (extra.now?.() ?? new Date()).toISOString() } as const;
    const store = Store.open(dbPath(env));
    let replaced: boolean;
    try {
      replaced = store.setBudget(budget);
    } finally {
      store.close();
    }
    if (json) {
      io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, budget, replaced }, null, 2) + '\n');
    } else {
      io.out(`${replaced ? 'Replaced' : 'Set'} budget for ${what}: ${limitText(unit, limit)}.\n`);
    }
    return 0;
  }

  if (command === 'budgets') {
    if (rest.length !== 0) return usage('budgets takes no arguments.');
    const logsDir = env.USAGE_LEDGER_LOGS || undefined;
    if (logsDir && !existsSync(logsDir)) {
      const msg = `Log folder not found: ${logsDir}`;
      if (json) io.out(errorJson('logs-not-found', msg));
      io.err(`${msg}\n`);
      return 2;
    }
    const store = Store.openIfExists(dbPath(env));
    let result: BudgetsResult;
    try {
      const budgets = store?.budgets() ?? [];
      const spans = budgets.length === 0 ? [] : await listSessions({ logsDir, ccusageScript: extra.ccusageScript });
      result = budgetUses(budgets, spans, store?.labels() ?? new Map(), store, extra.now?.() ?? new Date());
    } finally {
      store?.close();
    }
    io.out(json ? JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...result }, null, 2) + '\n' : budgetsTable(result));
    return result.anyUsedUp ? 1 : result.anyIncomplete ? 3 : 0;
  }

  if (command !== 'session') return usage(`Unknown command: ${command}`);
  if (rest.length !== 1) return usage('Give exactly one session ID: usage-ledger session <session-id>');

  try {
    const opts = { logsDir: env.USAGE_LEDGER_LOGS || undefined, ccusageScript: extra.ccusageScript };
    const s = await lookupSession(rest[0], opts);
    const spans = await listSessions(opts);
    const store = Store.openIfExists(dbPath(env));
    let w: WeeklyShare;
    try {
      w = weeklyShare(
        spans.find((x) => x.sessionId === s.sessionId),
        spans,
        store,
      );
    } finally {
      store?.close();
    }
    io.out(json ? sessionJson(s, w) : sessionTable(s, w));
    return 0;
  } catch (e) {
    if (e instanceof LookupError) {
      if (json) io.out(errorJson(e.code, e.message));
      io.err(`${e.message}\n`);
      return e.code === 'invalid-session-id' ? 2 : 1;
    }
    throw e;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2), process.env, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`usage-ledger failed: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
