# Fixture status line input

Claude Code status line JSON, for `usage-ledger statusline --at <time>`.
Record them at these times to match the fixture logs in `../logs`:

- `week-5.0.json` at 2026-11-20T09:59:00Z, `week-5.5.json` at 2026-11-20T10:02:00Z.
  - Session 11111111-... (10:00:05 to 10:01:00) used 0.5%, estimated.
- `week-10.0.json` at 2026-11-22T09:55:00Z, `week-14.0.json` at 2026-11-22T11:35:00Z.
  - Sessions 33333333-... (3,000 tokens on Sonnet, $0.021) and 44444444-... (1,000 tokens on Opus, $0.027) overlap.
  - The 4% rise is split by estimated cost: 1.75% and 2.25%, both marked overlapping. By tokens it would have been 3% and 1%.
- Session 22222222-... (2026-11-21T09:00) sits between 5.5% and 10%: 4.5%, estimated.
- Session 55555555-... (2026-11-23T08:00) has no snapshot after it: unknown.
- `no-rate-limits.json` carries no weekly figure: nothing is stored.
- `week-85.0.json` carries 85%, resetting 2026-11-27T10:00:00Z: above the default 80% warning threshold.
