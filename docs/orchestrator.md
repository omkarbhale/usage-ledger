# usage-ledger for orchestrator authors

How a program that spawns coding-agent sessions reads usage-ledger's answers.
Run `usage-ledger <command> --help` for short help on one command.

## The rules every command follows

- Add `--json` to any command. It prints one JSON object on stdout, with `"schemaVersion": 1`.
- Without `--json` it prints a plain table or line for people. Do not parse that.
- A problem prints a plain message on stderr. With `--json` it also prints an error object on stdout (see "Errors").
- All times are ISO 8601 in UTC, such as `2026-11-22T11:35:00.000Z`.
- Percentages are percent of the account's weekly limit, 0 to 100 (`14` means 14%).
- Costs are US dollars, estimated by ccusage from model list prices. They are not a bill.
- Every weekly figure is an estimate (`"estimated": true`). It can be `null` when it cannot be known; `reason` or `status` then says why.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. For `budgets`: every budget is ok. For `week`: below the threshold, stale, or no figure yet. |
| 1 | Not found: no session with that ID, the log folder (`USAGE_LEDGER_LOGS`) is missing, or the status line input is not a JSON object. Also any unexpected failure (message `usage-ledger failed: ...` on stderr, no JSON). For `budgets`: at least one budget is used up. |
| 2 | Refused: wrong usage, a bad `--since` time, a bad session ID, an empty task or project name, a bad limit, or a bad hand reading. For `budgets`, also a missing log folder. |
| 3 | `week`: the weekly percentage is at or above `--warn-at` (default 80). `budgets`: no budget is used up, but at least one is incomplete. |

`budgets` has its own meanings for 1, 2 and 3, so an orchestrator can act on the code alone:

- 1: stop. At least one budget is used up: its known use has reached its limit. Used up wins over incomplete.
- 3: unsure. Nothing is known to be used up, but some sessions could not be counted (no cost, or no weekly share). Decide whether to go on.
- 2: an error; `--json` prints an `error` object.
- 0: every budget is ok.

An unexpected failure of `budgets` also exits 1, with no JSON on stdout. Check that stdout holds the budgets object before reading 1 as "used up".

`statusline` always exits 0 when its input is JSON, even when it warns, so Claude Code keeps showing the line.

## Errors

With `--json`, a refused or failed command prints:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "session-not-found",
    "message": "No session found with ID nope."
  }
}
```

- `code` is one of:
  - `usage` (exit 2): wrong command, argument or option value.
  - `invalid-session-id` (exit 2): the ID has characters other than letters, digits, dots, dashes or underscores.
  - `invalid-task`, `invalid-project` (exit 2): the name is empty, more than one line, or over 200 characters.
  - `invalid-limit` (exit 2): `--tokens` is not a whole number above 0, `--percent` is not above 0 and at most 100, or `--dollars` is not an amount above 0.
  - `session-not-found` (exit 1): no log has that session ID.
  - `logs-not-found` (exit 1; exit 2 for `budgets`): the `USAGE_LEDGER_LOGS` folder does not exist.
  - `invalid-time` (exit 2): `--since` is not an ISO time or date.
  - `invalid-reading` (exit 2): `reading` got a percent outside 0 to 100, or a reset time that is not a time, not after the reading, or more than seven days after it.
  - `bad-statusline-input` (exit 1): stdin is not a JSON object, or its weekly percentage is out of range.
- `message` is the same plain sentence printed on stderr.
- An unknown option (such as `--foo`) is refused with exit 2 and a stderr message only, with no JSON.

## The labelling flow

1. Spawn a session and keep its session ID. With `claude -p --output-format json`, the ID is in the result's `session_id`.
2. Label it right away: `usage-ledger label <session-id> --task <name> [--project <name>]`. The session need not have logs yet. Labelling again replaces the label.
3. When it ends, read it back: `usage-ledger session <session-id> --json`.
4. Compare tasks or projects: `usage-ledger report --by task --json` or `--by project`, with `--week` for the current week or `--since <time>`. Single sessions are counted, never listed.
5. To read back many sessions at once, use `usage-ledger sessions --json` (with `--week` or `--since <time>`): each with start, end, models, cost and weekly share, in time order.
6. To cap a project's spending this week, set a project budget once: `usage-ledger budget set --project <name> --dollars <usd>` or `--percent <p>` (percent of the weekly limit). It rolls with the week, so it needs no re-setting after each reset.
7. When no status line runs, record the account's weekly usage by hand now and then: `usage-ledger reading --percent <p> --resets-at <time>`, read from Claude Code's `/usage`. It counts the same as a status line reading.
8. Before spawning more work, check `usage-ledger budgets --json` (exit 1 means a budget is used up, 3 that some use could not be counted) and `usage-ledger week --json` (exit 3 means the week is near its limit).

The weekly share needs readings taken before and after the session: status line snapshots (see `premise/run.md`) or hand readings (`usage-ledger reading`). Sessions run with `claude -p` may not run the status line, so a session's share stays `unknown` until a snapshot exists after it ends. Ask again later.

The examples below come from the test fixtures, run in this order with `USAGE_LEDGER_LOGS=test/fixtures/logs` and a fresh `USAGE_LEDGER_DB`, as in "How to check" in `premise/run.md`.

## statusline

`usage-ledger statusline --at 2026-11-22T11:35:00Z --json < test/fixtures/statusline/week-14.0.json`, exit 0:

```json
{
  "schemaVersion": 1,
  "snapshot": {
    "takenAt": "2026-11-22T11:35:00.000Z",
    "weeklyPercent": 14,
    "resetsAt": "2026-11-27T10:00:00.000Z",
    "sessionId": "44444444-4444-4444-8444-444444444444",
    "source": "statusline"
  },
  "warnAt": 80,
  "warning": false
}
```

- `snapshot`: what was stored. `null` when the input had no weekly figure (nothing is stored then).
  - `takenAt`: when it was recorded (now, or `--at`).
  - `weeklyPercent`: the account's weekly percentage used.
  - `resetsAt`: when the weekly limit resets; `null` if the input did not say.
  - `sessionId`: the session whose status line gave the figure; `null` if not given.
  - `source`: where the reading came from: `statusline` here, `manual` for `usage-ledger reading`.
- `warnAt`: the threshold used. `warning`: true when `weeklyPercent` is at or above it.
- `message`: only when `warning` is true, such as `"WARNING: weekly usage 85% is at or above 80% of the limit"`.

## reading

Records the account's weekly usage by hand, when no status line runs (for example a fleet of `claude -p` sessions). Read the percent used and the reset time from Claude Code's `/usage` or the account page.

`usage-ledger reading --percent 42 --resets-at 2026-11-27T10:00:00Z --at 2026-11-23T12:00:00Z --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "reading": {
    "takenAt": "2026-11-23T12:00:00.000Z",
    "weeklyPercent": 42,
    "resetsAt": "2026-11-27T10:00:00.000Z",
    "sessionId": null,
    "source": "manual"
  }
}
```

- `reading`: what was stored, with the same fields as the status line's `snapshot`. `source` is `manual`.
- A hand reading counts the same as a status line reading: for weekly shares, the week and budgets.
- `--percent` must be 0 to 100. `--resets-at` must be after the reading time and at most seven days after it. Otherwise: exit 2, code `invalid-reading`.
- The current week then runs from seven days before `resetsAt` to `resetsAt`.

## session

`usage-ledger session 33333333-3333-4333-8333-333333333333 --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "session": {
    "sessionId": "33333333-3333-4333-8333-333333333333",
    "inputTokens": 2000,
    "outputTokens": 1000,
    "cacheCreationTokens": 0,
    "cacheReadTokens": 0,
    "totalTokens": 3000,
    "cost": {
      "status": "estimated",
      "estimated": true,
      "usd": 0.021,
      "source": "ccusage"
    },
    "source": "ccusage",
    "models": [
      "claude-sonnet-4-5-20250929"
    ],
    "weekly": {
      "status": "overlapping",
      "estimated": true,
      "weeklyPercent": 1.75,
      "reason": null,
      "before": {
        "at": "2026-11-22T09:55:00.000Z",
        "weeklyPercent": 10
      },
      "after": {
        "at": "2026-11-22T11:35:00.000Z",
        "weeklyPercent": 14
      },
      "rise": 4,
      "overlapsWith": [
        "44444444-4444-4444-8444-444444444444"
      ],
      "splitBy": "cost"
    }
  }
}
```

- `inputTokens`, `outputTokens`, `cacheCreationTokens` (cache write), `cacheReadTokens`: tokens by kind. `totalTokens`: their sum.
- `source`: where the tokens came from: `ccusage`, or `log-file` when ccusage could not read the session and the ledger read the session's log file itself.
- `models`: the model or models the session used, as the logs name them, in the order first seen. Empty when the logs name none. It explains why one session's cost or weekly share is larger than another's.
- `effortLevels`: the effort levels the session's log records, such as `["high"]`, in the order first seen. The field is absent when the log records none. Session 4 in the fixtures has `"effortLevels": ["high"]`.
  - Assumed, not checked: where Claude Code writes the effort level. The ledger reads a string field named `effort` or `effortLevel` on a log line or its message. Effort is shown only; it has no weight in the weekly split.
- `cost`:
  - `status`: `estimated`, or `unknown` when the tokens came from the log file (it has no prices).
  - `estimated`: always true. `source`: always `ccusage`.
  - `usd`: the estimated cost; `null` when unknown.
  - `reason`: only when unknown, why.
- `weekly`: the session's estimated share of the weekly limit.
  - `status`: `estimated` (only this session ran between the two snapshots), `overlapping` (other sessions ran too, and the rise was split between them), or `unknown`.
  - `weeklyPercent`: the share; `null` when unknown.
  - `reason`: why it is unknown, such as `"no snapshot after the session ended"`; otherwise `null`.
  - `before`, `after`: the snapshots on each side (`at`, `weeklyPercent`); `null` when missing.
  - `rise`: the account's rise between them; `null` when unknown.
  - `overlapsWith`: the other sessions that shared the rise.
  - `splitBy`: how an overlapping rise was split; `null` when the session was alone or its share is unknown.
    - `cost`: in proportion to each session's estimated cost in the window. A session on a model that costs more per token gets a larger part, since some models use up the weekly limit faster. Here session 3 (3,000 tokens on Sonnet, $0.021) gets 1.75% and session 4 (1,000 tokens on Opus, $0.027) gets 2.25% of the 4% rise.
    - `tokens`: in proportion to tokens, used only when a session in the window has no estimated cost (its tokens came from the log file).
    - Effort level has no weight of its own: higher effort shows up as more tokens, which the cost already counts.
    - Assumed, not checked: that the weekly limit follows model price. No published rate says how fast each model uses it.

## label

`usage-ledger label 11111111-1111-4111-8111-111111111111 --task build-api --project shop --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "label": {
    "sessionId": "11111111-1111-4111-8111-111111111111",
    "task": "build-api",
    "project": "shop",
    "labelledAt": "2026-11-23T10:01:27.121Z"
  },
  "replaced": false
}
```

- `label.task`, `label.project`: as stored, trimmed. `project` is `null` when not given; the report then uses the project folder from the logs.
- `label.labelledAt`: when it was stored (the time you run it).
- `replaced`: true when the session already had a label, now replaced.

## report

`usage-ledger report --week --by task --json` after labelling sessions 1, 3, 4 and 5, exit 0 (two groups cut for length):

```json
{
  "schemaVersion": 1,
  "report": {
    "by": "task",
    "window": {
      "kind": "week",
      "from": "2026-11-20T10:00:00.000Z",
      "to": "2026-11-27T10:00:00.000Z",
      "basis": "reset-time",
      "source": "statusline"
    },
    "groups": [
      {
        "task": "write-docs",
        "sessions": 2,
        "inputTokens": 850,
        "outputTokens": 210,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "totalTokens": 1060,
        "clippedSessions": 0,
        "cost": {
          "status": "estimated",
          "estimated": true,
          "usd": 0.0273,
          "source": "ccusage",
          "knownSessions": 2,
          "unknownSessions": 0
        },
        "weekly": {
          "status": "partial",
          "estimated": true,
          "weeklyPercent": 2.25,
          "overlapping": true,
          "knownSessions": 1,
          "unknownSessions": 1
        }
      }
    ],
    "total": {
      "sessions": 5,
      "inputTokens": 4370,
      "outputTokens": 1517,
      "cacheCreationTokens": 300,
      "cacheReadTokens": 9000,
      "totalTokens": 15187,
      "clippedSessions": 0,
      "cost": {
        "status": "estimated",
        "estimated": true,
        "usd": 0.06195,
        "source": "ccusage",
        "knownSessions": 5,
        "unknownSessions": 0
      },
      "weekly": {
        "status": "partial",
        "estimated": true,
        "weeklyPercent": 9,
        "overlapping": true,
        "knownSessions": 4,
        "unknownSessions": 1
      }
    }
  }
}
```

- `by`: `task` or `project`. Each group's name is under that key: `"task": "write-docs"` or `"project": "shop"`.
  - The name is `null` for sessions with no task label (`(unlabelled)` in the table), or with no known project.
- `window`: the time the report covers.
  - `kind`: `all` (no `--week` or `--since`: every session in the logs), `week` (`--week`) or `since` (`--since <time>`).
  - `from`: start, inclusive. `to`: end, exclusive; for `week`, the next weekly reset. Both `null` for `all`; `to` is `null` for `since`.
  - `basis` (`week` only): `reset-time` when the week runs from the latest reading's reset time back seven days; `last-seven-days` when no reading gives a reset time yet.
  - `source` (`week` only): where that reading came from, `statusline` or `manual`.
- `sessions`: how many sessions have usage in the window.
- `inputTokens`, `outputTokens`: input and output tokens, apart. `cacheCreationTokens`, `cacheReadTokens`: cache write and cache read. `totalTokens`: all four together.
- `clippedSessions`: sessions that ran partly outside the window. Only their log records inside the window are counted; their cost and weekly share are scaled by the share of their tokens inside it.
- `cost`: the sum of the known estimated costs.
  - `status`: `estimated` (all known), `partial` (some known; `usd` sums only those) or `unknown` (none; `usd` is `null`).
  - `knownSessions`, `unknownSessions`: how many sessions had a cost, and how many did not.
- `weekly`: the sum of the known weekly shares.
  - `status`: `estimated`, `partial` or `unknown`, as for cost.
  - `overlapping`: true when any session's share was split with others.
  - `knownSessions`, `unknownSessions`: as for cost.
- `total`: the same fields for all sessions together, without a name.
- Single sessions are counted, never listed or ranked. Use `sessions` for the sessions themselves.

## sessions

`usage-ledger sessions --since 2026-11-22T00:00:00Z --json` after the same steps, exit 0 (sessions 3 and 5 cut for length):

```json
{
  "schemaVersion": 1,
  "listing": {
    "window": {
      "kind": "since",
      "from": "2026-11-22T00:00:00.000Z",
      "to": null,
      "basis": null,
      "source": null
    },
    "sessions": [
      {
        "sessionId": "44444444-4444-4444-8444-444444444444",
        "start": "2026-11-22T10:30:00.000Z",
        "end": "2026-11-22T11:30:00.000Z",
        "project": "-home-dev-proj-gamma",
        "task": "write-docs",
        "models": [
          "claude-opus-4-1-20250805"
        ],
        "inputTokens": 800,
        "outputTokens": 200,
        "cacheCreationTokens": 0,
        "cacheReadTokens": 0,
        "totalTokens": 1000,
        "cost": {
          "status": "estimated",
          "estimated": true,
          "usd": 0.027,
          "source": "ccusage"
        },
        "weekly": {
          "status": "overlapping",
          "estimated": true,
          "weeklyPercent": 2.25,
          "reason": null,
          "splitBy": "cost"
        },
        "startedBeforeWindow": false
      }
    ],
    "count": 3
  }
}
```

- `window`: as for `report`. `--week` and `--since <time>` work the same way; with neither, every session in the logs.
- `sessions`: every session with usage in the window, oldest first (by `start`, then `sessionId`). The order is time, never usage; there is no rank field.
- Each session is whole, even when it began before the window:
  - `start`, `end`: its first and last usage record.
  - `project`: the labelled project, otherwise the project folder from the logs. `task`: its task label, or `null`.
  - `models`: the models it used, in the order first seen.
  - `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`: as for `session`.
  - `cost`: as for `session`, without `reason`.
  - `weekly`: its estimated share of the weekly limit: `status` (`estimated`, `overlapping` or `unknown`), `weeklyPercent`, `reason` when unknown, and `splitBy` as for `session`.
  - `startedBeforeWindow`: true when it began before `window.from`.
- `count`: how many sessions are listed.

## budget set and budget remove

`usage-ledger budget set --task build-api --tokens 10000 --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "budget": {
    "scope": "task",
    "task": "build-api",
    "project": null,
    "unit": "tokens",
    "limit": 10000,
    "setAt": "2026-11-23T10:01:35.017Z"
  },
  "replaced": false
}
```

`usage-ledger budget set --project shop --dollars 1 --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "budget": {
    "scope": "project",
    "task": null,
    "project": "shop",
    "unit": "dollars",
    "limit": 1,
    "setAt": "2026-11-23T10:01:35.030Z"
  },
  "replaced": false
}
```

- `scope`: `task` (every session labelled with the task), `project` (the project's sessions in the current week) or `week` (every session in the current week).
- `task`: the task name for a task budget, otherwise `null`. `project`: the project name for a project budget, otherwise `null`. A session's project is its labelled project, otherwise its project folder from the logs, as in `report --by project`.
- `unit`: `tokens`, `percent` (of the weekly limit) or `dollars` (US dollars of ccusage's estimated cost). `limit`: in that unit.
- `setAt`: when it was stored. `replaced`: true when a budget with the same scope, name and unit existed.

`usage-ledger budget remove --week --json`, exit 0:

```json
{
  "schemaVersion": 1,
  "removed": {
    "scope": "week",
    "task": null,
    "project": null,
    "count": 1
  }
}
```

- `count`: how many budgets were removed; 0 when none was set.

## budgets

`usage-ledger budgets --json` with the two budgets above and `budget set --week --percent 50`, exit 1:

```json
{
  "schemaVersion": 1,
  "week": {
    "from": "2026-11-20T10:00:00.000Z",
    "to": "2026-11-27T10:00:00.000Z",
    "fromResetTime": true,
    "source": "statusline",
    "weeklyPercent": 14,
    "asOf": "2026-11-22T11:35:00.000Z",
    "reason": null
  },
  "budgets": [
    {
      "scope": "week",
      "task": null,
      "project": null,
      "unit": "percent",
      "limit": 50,
      "used": 14,
      "remaining": 36,
      "status": "ok",
      "usedUp": false,
      "estimated": false,
      "sessions": 0,
      "unknownSessions": 0,
      "reason": null,
      "setAt": "2026-11-23T10:01:35.056Z"
    },
    {
      "scope": "project",
      "task": null,
      "project": "shop",
      "unit": "dollars",
      "limit": 1,
      "used": 0.012825,
      "remaining": 0.987175,
      "status": "ok",
      "usedUp": false,
      "estimated": true,
      "sessions": 1,
      "unknownSessions": 0,
      "reason": null,
      "setAt": "2026-11-23T10:01:35.030Z"
    },
    {
      "scope": "task",
      "task": "build-api",
      "project": null,
      "unit": "tokens",
      "limit": 10000,
      "used": 14100,
      "remaining": -4100,
      "status": "used-up",
      "usedUp": true,
      "estimated": false,
      "sessions": 2,
      "unknownSessions": 0,
      "reason": null,
      "setAt": "2026-11-23T10:01:35.017Z"
    }
  ],
  "anyUsedUp": true,
  "anyIncomplete": false
}
```

A dollar budget for project `-home-dev-proj-gamma` (`--project=-home-dev-proj-gamma`, since the name starts with a dash) when ccusage cannot price its three sessions, so their tokens come from the log files:

```
{
  "scope": "project",
  "project": "-home-dev-proj-gamma",
  "unit": "dollars",
  "limit": 5,
  "used": 0,
  "remaining": 5,
  "status": "incomplete",
  "usedUp": false,
  "estimated": true,
  "sessions": 3,
  "unknownSessions": 3,
  "reason": "no estimated cost for some sessions: their tokens came from the log files, which have no prices",
  ...
}
```

With no budget used up, that budget alone makes `budgets` exit 3.

- `week`: the current week.
  - `from`, `to`: its bounds. The week runs from the reset time in the latest reading (status line or hand) back seven days, rolled on by whole weeks once that reset has passed (`fromResetTime: true`). With no reading that gives a reset time, it is the seven days up to now (`fromResetTime: false`).
  - `source`: where the latest reading came from: `statusline` or `manual`; `null` when there is none.
  - `weeklyPercent`: the account's weekly percentage at the latest reading (status line or hand); `null` when unknown, with `reason`.
  - `asOf`: when that snapshot was taken; `null` when there is none.
- `budgets`: each budget (the week first, then projects, then tasks), with the fields of `budget set` plus:
  - `used`: the use known so far, in the same unit. Tokens are summed from the logs; dollars from ccusage's estimated costs; percent from each session's estimated weekly share, or, for a week percent budget, the latest reading itself. `null` only for a week percent budget with no reading in the current week, with `reason`.
  - `remaining`: `limit - used`; zero or negative when used up; `null` when `used` is.
  - `status`:
    - `used-up`: `used` has reached the limit (`used >= limit`). A budget is used up at its limit, not only past it. Used up wins over incomplete: if the known use already reaches the limit, uncounted sessions cannot change that.
    - `incomplete`: not used up, but some use could not be counted (`unknownSessions` above 0, or `used` is `null`). `used` is then a lower bound.
    - `ok`: under the limit, with every session counted.
  - `usedUp`: true when `status` is `used-up`.
  - `estimated`: true when `used` is an estimate (dollars, or a task's or project's share of the weekly limit).
  - `sessions`: sessions counted against the budget, including uncounted ones. A task budget counts every session with that task; a project budget, the project's sessions whose last record falls in the current week; a week budget in tokens or dollars, every session whose last record falls in the current week; a week percent budget counts none (it reads the latest reading).
  - `unknownSessions`: sessions with no figure in the budget's unit (no cost for dollars, no weekly share for percent), left out of `used` and never counted as zero. Always 0 for tokens.
  - `reason`: why some or all use is not known; `null` otherwise.
- `anyUsedUp`: true when any budget is used up; the exit code is then 1.
- `anyIncomplete`: true when any budget is incomplete; with none used up, the exit code is then 3.

## week

`usage-ledger week --json` after the 85% status line fixture (`week-85.0.json`), exit 3:

```json
{
  "schemaVersion": 1,
  "week": {
    "weeklyPercent": 85,
    "resetsAt": "2026-11-27T10:00:00.000Z",
    "takenAt": "2026-11-23T08:30:00.000Z",
    "source": "statusline",
    "warnAt": 80,
    "status": "warning",
    "warning": true,
    "message": "WARNING: weekly usage 85% is at or above 80% of the limit"
  }
}
```

- `status`:
  - `ok`: below `warnAt`; exit 0.
  - `warning`: at or above `warnAt`; exit 3.
  - `stale`: the limit reset after the latest reading, so the figure is from the previous week; no warning, exit 0.
  - `unknown`: no reading yet (status line or hand); `weeklyPercent`, `resetsAt` and `takenAt` are `null`; exit 0.
- `weeklyPercent`, `resetsAt`, `takenAt`, `source`: from the latest reading, status line or hand; all `null` when there is none.
- `warnAt`: the threshold (`--warn-at`, default 80). `warning`: true only when `status` is `warning`.
- `message`: a plain sentence for people.
