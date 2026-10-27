# agent-workflow

`@agwab/agent-workflow` runs staged, multi-worker workflows for coding-agent CLIs. A workflow is a
JSON spec: a graph of model stages (fan-out, fan-in, loops), deterministic helper stages, structured
outputs and required-read gates. agent-workflow compiles it, schedules the stages, and dispatches each
worker to an **executor**, a supported agent CLI: **Pi**, **Codex** or **Claude Code**. The engine
does not depend on any one of them; you can run the same workflow on each. It descends from
`@agwab/pi-workflow`.

**Status: pre-release (stage 1).** The engine, the three executors, the CLI and the Pi host work and
were accepted live on all four bundled workflows ([`docs/support.md`](docs/support.md)). Expect
breaking changes before 1.0, including to the executor SDK contract (0.1.0).

## Permission modes: `free` by default

> **By default (`free`), workers run without approval prompts and without a sandbox** on every stage
> the workflow does not declare `readOnly`. Read-only stages stay read-only, and workers still do not
> load your personal settings, instructions, hooks or skills unless a stage opts in.
>
> Use **`safe`** for the conservative behavior: no bypass flags, policy-based approvals that fail
> closed, a worktree for every write-capable stage. Choose it per run (`--permission-mode safe`), in
> a workflow-declared profile, or as `permissionMode` on a saved profile.

All four bundled workflows are read-only. Details: [`docs/permissions.md`](docs/permissions.md).

## Install

Node.js 22 or newer, plus at least one executor CLI, installed and logged in with its own login:
[Pi](docs/executors/pi.md) 1.1+, [Codex](docs/executors/codex.md) (`codex-cli` 0.159+) or
[Claude Code](docs/executors/claude.md) 2.1+. agent-workflow never handles credentials.

```sh
npm install @agwab/agent-workflow       # project-local; provides the agent-workflow bin
npm install -g @agwab/agent-workflow    # or globally
```

The package has no runtime dependencies. The Pi packages are optional peers, needed only by the Pi
host.

## Quick start

### CLI (`agent-workflow`)

```sh
npx agent-workflow list                                   # workflows you can run
npx agent-workflow validate deep-review
npx agent-workflow run deep-review "Review the current diff for reliability" --executor claude
npx agent-workflow run spec-review "Check docs/spec.md against src/" --executor codex --permission-mode safe
id=$(npx agent-workflow run deep-research "State of X" --detach --json | jq -r .data.runId)
npx agent-workflow wait "$id" --timeout 30m
npx agent-workflow inspect "$id" --failures --results
```

`run` prints a capability preview, starts the run and waits in the foreground; `--detach` hands it
to a background supervisor. Full reference: [`docs/cli.md`](docs/cli.md).

### Pi (`/aw`)

```sh
pi -e npm:@agwab/agent-workflow            # one session, without changing Pi settings
pi install npm:@agwab/agent-workflow       # or install as a Pi package (add -l for the project)
```

Then in Pi: `/aw list`, `/aw run deep-review "Review the current diff" --executor codex`,
`/aw wait <run>`. The agent can use the `aw_list`, `aw_run`, `aw_dynamic` and `aw_wait` tools. Pi is
the parent agent; workers run on whichever executor is selected. `/aw` and `aw_*` do not collide with
pi-workflow's `/workflow`. See [`docs/pi-host.md`](docs/pi-host.md).

### Codex and Claude Code as hosts

Codex and Claude Code are supported **executors** (they run the workers). To run workflows *from
inside* them, install the `agent-workflow` plugin: it registers the host MCP server
`agent-workflow-mcp` with the right `--host` and adds the `agent-workflow`, `workflow-guide` and
`execution-router` skills.

```sh
claude plugin marketplace add AgwaB/agent-workflow && claude plugin install agent-workflow@agent-workflow
codex plugin marketplace add AgwaB/agent-workflow && codex plugin add agent-workflow@agent-workflow
```

Alternative without the plugin (server only):
`claude mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host claude-code`
or `codex mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host codex`.
Then ask for a workflow in the conversation: the agent launches it with `workflow_run`, waits in
bounded 45 s `workflow_wait` calls and quotes the result and report paths. Local development
(`--plugin-dir`), timeouts and tool names: [`docs/plugins.md`](docs/plugins.md); the server:
[`docs/host-mcp.md`](docs/host-mcp.md).

## Executors

| Executor | Runs | Notes |
|---|---|---|
| `pi` | `pi --mode json` | Native MCP and tool allowlist; deep-research needs the `pi-web-access` extension. |
| `codex` | `codex app-server` | Coarse tool allowlist (sandbox modes); global `AGENTS.md` and exec-policy rules apply. |
| `claude` | `claude -p` stream-json | Fine tool allowlist, native read-only mode. |

Choose with `--executor <id>`, with a profile (`--profile <name>`: one the workflow declares, else a
saved one, see `agent-workflow profile`), or with a saved default profile. Precedence for the executor
and the permission mode: **run flag > workflow-declared profile > saved user profile > default**
(executor: the host's own CLI, in a terminal the first installed and logged-in of `pi` → `claude` →
`codex`; mode `free`). `agent-workflow doctor` shows which executors are ready. Before any run starts, the engine probes the executor and checks every stage's needs
against what the executor can enforce; gaps are refused or recorded, never silent
([`docs/usage.md`](docs/usage.md#capability-preview-and-degradations)). Writing your own executor:
[`docs/sdk.md`](docs/sdk.md).

## Bundled workflows

| Workflow | Use when |
|---|---|
| `deep-research` | You need a grounded answer based on source material (uses the executor's web tools). |
| `deep-review` | You want code or design reviewed carefully from several angles. |
| `spec-review` | You want to check whether a spec or contract is reflected in the implementation and tests. |
| `impact-review` | Before merging or releasing: affected areas, risks, missing tests and docs. |

Per-executor results: [`docs/support.md`](docs/support.md). Workflow details:
[`workflows/README.md`](workflows/README.md). Write your own with the bundled `workflow-guide`
skill and [`docs/usage.md`](docs/usage.md).

## Documentation

[`docs/README.md`](docs/README.md) indexes everything: usage, CLI, Pi host, permission modes,
support matrix, executors, SDK, architecture, environment variables.

## License

MIT. See `LICENSE` and `NOTICE`.
