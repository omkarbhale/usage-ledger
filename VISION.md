# Vision

usage-ledger shows where a fleet of coding agents spends its usage, so the owner can decide where it should go.

## What it is

One person runs many coding agents at once: workers spawned for tasks, longer-lived agents that own whole areas of work, and the supervisor that coordinates them. They draw on a small number of subscriptions and accounts, each with weekly limits. Today the only number anyone sees is how much of the week is left. usage-ledger answers the next question: spent on what.

It attributes usage to the work that caused it: the project, the kind of task, the agent, the account, and the model. It reports both the share of each account's weekly limit and an estimated API-price cost, side by side.

## What better means

- **Attribution the owner can trust.** Every figure says where it came from. A share of the weekly limit that cannot be tied to work is reported as unattributed, never spread across tasks to make the totals look complete.
- **The limit that actually binds.** The weekly limit as the vendor reports it is the measure that matters for planning. Estimated API cost is shown beside it, never in its place, and never presented as what was paid.
- **Decisions, not dashboards.** The point is to decide how much of the week a project or a kind of task should get, and to notice when that is overrun. A view that does not help with that decision is not needed.
- **Nothing in the path.** It reads what agents and vendors already record. It never sits between an agent and its model, and an agent works the same whether usage-ledger is running or not.
- **History survives.** What each task was, and what it spent, is kept after the task and its records are gone.
- **Local and personal.** It runs on the owner's machine, for the owner's own accounts. Usage data does not leave the machine.

## Not this

- A proxy or gateway in front of the agents.
- A billing system or an exact invoice.
- A team or organisation dashboard.
- A replacement for the tools that already parse session logs or read quota; it builds on them.
