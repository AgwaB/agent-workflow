# agent-workflow

`@agwab/agent-workflow` is a host-agnostic workflow engine for coding-agent CLIs.
It runs staged, multi-worker workflows (fan-out, loops, required-read gates,
structured outputs) and dispatches each worker to a pluggable executor such as
Pi, Codex, or Claude Code, through a public executor SDK. The engine itself does
not depend on any single agent host; host integrations live behind separate
entry points. It descends from `@agwab/pi-workflow`.

## Status

Pre-alpha skeleton (WP0). Every entry point is a stub; do not depend on it yet.

The design, decisions, and stage-1 plan live in the owner's analysis workspace
and will be summarized in `docs/` as work packages land.

## Planned entry points

- `@agwab/agent-workflow` — core engine and SDK re-exports
- `@agwab/agent-workflow/sdk` — executor contract, capabilities, events, error classes
- `@agwab/agent-workflow/runtime` — durable worker, process gate, launch receipts, run registry
- `@agwab/agent-workflow/executors/pi` — `pi --mode json` executor (optional Pi peers)
- `@agwab/agent-workflow/executors/codex` — `codex app-server` executor
- `@agwab/agent-workflow/executors/claude` — `claude -p` stream-json executor
- `@agwab/agent-workflow/hosts/cli` — host-neutral `agent-workflow` CLI
- `@agwab/agent-workflow/hosts/pi` — Pi extension host (optional Pi peers)

## License

MIT. See `LICENSE` and `NOTICE`.
