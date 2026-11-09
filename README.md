# agent-workflow

`@agwab/agent-workflow` runs multi-worker workflows on coding-agent CLIs: **Pi**, **Codex**,
**Claude Code** and experimental **Antigravity**. A JSON spec defines model stages, fan-out,
fan-in, loops, deterministic helpers, structured outputs and required-read gates. The engine
compiles the spec, schedules stages and dispatches workers to the selected executors.

Pre-release: expect breaking changes before 1.0, including to the executor SDK contract.

## Install

Requires Node.js 22+ and at least one executor CLI installed and logged in:
[Pi](docs/executors.md#pi) 1.1+, [Codex](docs/executors.md#codex) (`codex-cli` 0.159+),
[Claude Code](docs/executors.md#claude-code) 2.1+, or [Antigravity](docs/executors.md#antigravity-acp).
Each executor uses its own login; agent-workflow never handles credentials.

```sh
npm install @agwab/agent-workflow       # project-local
npm install -g @agwab/agent-workflow    # or globally
```

The package has no runtime dependencies. Pi packages are optional peers, needed only by the Pi host.

## Quick start

```sh
npx agent-workflow list
npx agent-workflow validate deep-review
npx agent-workflow run deep-review "Review the current diff for reliability" --executor claude
npx agent-workflow run spec-review "Check docs/spec.md against src/" --executor codex --permission-mode safe
id=$(npx agent-workflow run deep-research "State of X" --detach --json | jq -r .data.runId)
npx agent-workflow wait "$id" --timeout 30m
npx agent-workflow inspect "$id" --failures --results
```

`run` prints a capability preview and waits in the foreground. `--detach` hands the run to a
background supervisor. Run records and logs live in a private [per-project state directory](docs/usage.md#where-run-state-lives),
not the repository. See the [CLI reference](docs/cli.md).

**The default permission mode is `free`: workers run without approval prompts or a sandbox, even
when the stage declares `readOnly`.** Use `--permission-mode safe` to enforce read-only intent,
policy-based approvals that fail closed and a worktree for every write-capable stage. All four
bundled workflows declare read-only intent; it is not a safety boundary in `free`.
See [permission modes](docs/usage.md#permission-modes) for limits and executor mappings.

Every launch prints a link to the loopback-only [dashboard](docs/hosts.md#dashboard), with live tasks,
logs, reports and controls. `agent-workflow dashboard --open` opens it; `run … --open` opens it
for a new run. No sign-in is required by default; `--auth` adds a browser session for shared
machines and `--readonly` disables controls.

## Hosts and executors

A **host** is where you launch and monitor workflows. An **executor** runs the workers; it need
not be the same CLI as the host.

| Executor | Runs | Notes |
|---|---|---|
| `pi` | `pi --mode json` | Native MCP and tool allowlist; deep-research needs `pi-web-access`. |
| `codex` | `codex app-server` | Coarse tool allowlist (sandbox modes); global `AGENTS.md` and exec-policy rules apply. |
| `claude` | `claude -p` stream-json | Fine tool allowlist, native read-only mode. |
| `antigravity` (experimental) | `agy_acp_server` (ACP) | Antigravity login, Gemini models; workspace `AGENTS.md`/`GEMINI.md` not isolated. |

Choose with `--executor <id>` or an [execution profile](docs/usage.md#profiles). Without a choice,
hosts use their own CLI; the terminal selects an installed, logged-in executor from `pi` →
`claude` → `codex`, preferring verified logins. `agent-workflow doctor` checks readiness.
The [preflight](docs/usage.md#preflight-capability-tools-models-and-effort) refuses unsupported
stage needs or records explicit degradations before launch.

### Pi host

```sh
pi -e npm:@agwab/agent-workflow          # one session
pi install npm:@agwab/agent-workflow     # persistent; add -l for the project
```

In Pi: `/aw list`, `/aw run deep-review "Review the current diff" --executor codex`,
`/aw wait <run>`. The agent can also use the `aw_*` tools. See the [Pi host guide](docs/hosts.md#pi).

### Codex and Claude Code hosts

Install the plugin to register the host MCP server and the `agent-workflow`, `workflow-guide`
`execution-router` and `aw` skills:

```sh
claude plugin marketplace add AgwaB/agent-workflow && claude plugin install agent-workflow@agent-workflow
codex plugin marketplace add AgwaB/agent-workflow && codex plugin add agent-workflow@agent-workflow
```

Use `/aw` (or `/agent-workflow:aw`) in Claude Code; `$aw` or `aw …` in Codex (trust the plugin hook on first start).
The six forms are help (`aw`), `dashboard [run]`, `run <workflow> <task…>`, `dynamic <task…>`,
`auto <task…>` and `stop <run>`: no options or questions; launches detach. `auto` immediately starts
the classifier’s top pick, without approval questions (launch consent source `command`). Or ask for a workflow in the conversation.
Codex cannot add `/aw` slash commands; plugins with hooks use our marketplace, not OpenAI’s public directory.
For server-only installation, local development and
timeouts, see [plugins](docs/hosts.md#claude-code-and-codex) and the [host MCP server](docs/hosts.md#claude-code-and-codex).

## Bundled workflows

| Workflow | Use when |
|---|---|
| `deep-research` | You need a grounded answer based on source material, using the executor's web tools. |
| `deep-review` | You want code or design reviewed from several angles. |
| `spec-review` | You want to check a spec or contract against implementation and tests. |
| `impact-review` | You need affected areas, risks, missing tests and docs before merging or releasing. |

See [workflow details](workflows/README.md) and [executor support](docs/usage.md#support-matrix).
Write your own with the bundled `workflow-guide` skill and the [usage guide](docs/usage.md).

## Documentation

- **Connect a host:** [Pi, Claude Code or Codex setup](docs/hosts.md).
- **Run and monitor:** [usage](docs/usage.md#running), [CLI commands](docs/cli.md),
  [dashboard](docs/hosts.md#dashboard).
- **Write a workflow:** [stages and DAGs](docs/usage.md#stage-model); **integrate a CLI:**
  [executor behavior](docs/executors.md) and [adapter development](docs/extending.md).

| Document | For |
|---|---|
| [docs/usage.md](docs/usage.md) | Running and writing workflows: profiles, permission modes, bundled workflows, support matrix, environment variables |
| [docs/cli.md](docs/cli.md) | The `agent-workflow` command reference |
| [docs/hosts.md](docs/hosts.md) | Using it from Claude Code, Codex and Pi; the dashboard |
| [docs/executors.md](docs/executors.md) | How each executor CLI (Pi, Codex, Claude Code, Antigravity) is driven |
| [docs/extending.md](docs/extending.md) | Writing an executor adapter or another host; architecture |

Tests: `npm run validate` (checks, typecheck, unit tests, integration tests), `npm run validate:unit` (without the
integration tier), `npm run e2e` (packed install), `npm run test:ui-motion` (dashboard animation timing).

## License

MIT. See `LICENSE` and `NOTICE`.
