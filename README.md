<div align="center">

# usage-ledger

**Know where your coding agents spend your weekly limit.**

Tokens, estimated cost and weekly-limit share for every Claude Code session — labelled by task and project, summed per week, with budgets an orchestrator can act on.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)
![Status](https://img.shields.io/badge/status-0.1-orange)

</div>

---

## Why

Running many agent sessions makes one question hard to answer: *which work used up this week's limit?* The account reports a weekly percentage; the agents' logs hold per-session tokens; your orchestrator knows which task each session was doing. usage-ledger joins the three.

- **Per session** — tokens (input, output, cache), estimated USD cost, models, and the session's share of the weekly limit.
- **Per task and project** — label sessions as they start, then read totals for the current week or since any time.
- **Budgets** — in tokens, dollars or percent of the weekly limit, per task, per project or for the whole week. Exit codes say *ok*, *used up* or *incomplete*, so scripts can stop before the limit does.
- **Honest numbers** — every weekly figure is marked as an estimate, and anything that can't be known is reported as unknown, never as zero.
- **Out of the way** — it only reads what Claude Code already writes. Nothing sits between an agent and its model.

## Install

Requires Node.js 22.13 or later.

```sh
git clone https://github.com/omkarbhale/usage-ledger.git
cd usage-ledger
npm ci
npm run build
npm link            # puts `usage-ledger` on your PATH
```

## Quick start

```sh
# One session
usage-ledger session 3f2c9a1e-...

# Label sessions as your orchestrator starts them
usage-ledger label 3f2c9a1e-... --task "fix login bug" --project web-app

# This week's totals per project
usage-ledger report --week --by project

# Many sessions in one call (for programs)
usage-ledger sessions --week --json

# A weekly budget for a project, then check all budgets
usage-ledger budget set --project web-app --dollars 50
usage-ledger budgets          # exit 0 ok · 1 used up · 3 incomplete
```

### Tracking the weekly limit

The weekly share needs readings of the account's weekly percentage. Either let Claude Code's status line feed them in automatically:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": { "type": "command", "command": "usage-ledger statusline" }
}
```

or record one by hand from `/usage`:

```sh
usage-ledger reading --percent 26 --resets-at 2026-11-30T02:00:00Z
usage-ledger week             # latest figure; warns at 80% (exit 3)
```

## Commands

| Command | What it does |
|---|---|
| `session <id>` | One session's tokens, cost, models and weekly share |
| `label <id> --task <name> [--project <name>]` | Attach a task and project to a session |
| `report [--week \| --since <time>] [--by task\|project]` | Totals per task or project |
| `sessions [--week \| --since <time>]` | Many sessions with start, end, models, tokens and cost |
| `budget set \| remove` | Manage budgets per task, per project or for the week |
| `budgets` | Every budget with its use; the exit code carries the verdict |
| `week [--warn-at <p>]` | Latest weekly percentage and reset time |
| `reading --percent <p> --resets-at <time>` | Record a weekly reading by hand |
| `statusline` | Claude Code status line command that stores readings |

Every command accepts `--json` and prints one versioned object (`"schemaVersion": 1`). Run `usage-ledger <command> --help` for details.

## For orchestrators

[`docs/orchestrator.md`](docs/orchestrator.md) documents every JSON field, error code and exit code, and the labelling flow, with an example per command. Every example in it is checked against real output in the test suite.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `USAGE_LEDGER_LOGS` | `~/.config/claude` and `~/.claude` | Claude Code data folder to read |
| `USAGE_LEDGER_DB` | `~/.usage-ledger/ledger.db` | Ledger database (created owner-only) |

## How the numbers are made

- **Tokens and cost** come from [ccusage](https://github.com/ccusage/ccusage), which reads Claude Code's logs and prices each model's tokens at list prices. Cost is an estimate, not a bill.
- **Weekly share** is the rise in the account's weekly percentage between the last reading before a session and the first after it. When sessions overlap, the rise is split by each session's estimated cost. With no reading on one side, the share is unknown.
- **The week** runs from the latest reading's reset time back seven days, matching the account's own window.

## Development

```sh
npm ci
npm test          # vitest
npm run build
```

## Vision

See [VISION.md](VISION.md) for what usage-ledger is for, and what it deliberately will not do.

## License

[MIT](LICENSE)
