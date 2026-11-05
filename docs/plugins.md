# Claude Code and Codex plugins

The plugin in `plugins/agent-workflow/` registers the [host MCP server](host-mcp.md) with the correct `--host` and supplies three skills: `agent-workflow` (tool protocol), `workflow-guide` (authoring and scaffolds), and `execution-router` (route recommendation). A direct `mcp add` registration is an alternative without skills.

## What the user gets

Ask for a workflow in the conversation, for example “run deep-review on the current diff”. The agent launches a detached run, reports its id and dashboard link, then waits or receives a completion notification. It quotes the result preview and report paths when finished.

Permission mode defaults to `free`; the executor is the workflow profile or host default unless you name one. Tools support status, logs, inspection, stopping, resuming, validation, profiles and dynamic approvals. State-changing profile, prune and notice calls require confirmation. See [tools and confirmation behavior](host-mcp.md#tools).

## Layout

```text
.claude-plugin/marketplace.json          Claude Code marketplace (repo root)
.agents/plugins/marketplace.json         Codex marketplace (repo root)
plugins/agent-workflow/
  .claude-plugin/plugin.json             Claude Code server, prompt hook and monitor
  .codex-plugin/plugin.json              Codex server, skills and timeouts
  skills/agent-workflow/
  skills/workflow-guide/
  skills/execution-router/
  reference/                            Usage guide, workflow guide and bundled specs
```

The plugin uses two manifests so each host passes its own `--host`. It has no `.mcp.json`, which Claude Code would load as a second server. Codex's compatibility manifest starts the server in the session directory; portable Agent Plugins manifests use the plugin root instead.

For maintainers, `node tools/release/plugins.mjs build` generates the plugin and marketplaces from `package.json`, `skills/` and documentation; `check` reports drift. Do not edit generated plugin files by hand. The generator also writes Pi's prefixed `aw-workflow-guide` and `aw-execution-router` skills under `plugins/pi/skills/`, avoiding collisions with other packages' skill names.

## Server launch

The released plugin uses an exact package version:

```sh
npx -y --package=@agwab/agent-workflow@<package version> agent-workflow-mcp --host <claude-code|codex>
```

Node.js 22+ is required. First startup downloads the package. Keep `--package`: `npx <package> agent-workflow-mcp` would select the package's `agent-workflow` binary and pass `agent-workflow-mcp` as an argument. For an unpublished or local version, use the development plugin below or register a local install with `mcp add`.

## Install (plugin)

Claude Code:

```sh
claude plugin marketplace add AgwaB/agent-workflow
claude plugin install agent-workflow@agent-workflow
# Add --scope project|local to share or limit the installation.
# In a session, Claude Code 2.1.275+ also supports:
# /plugin install agent-workflow --marketplace AgwaB/agent-workflow
```

Codex:

```sh
codex plugin marketplace add AgwaB/agent-workflow
codex plugin add agent-workflow@agent-workflow
```

Codex marketplace registration can use `--sparse .agents/plugins --sparse plugins/agent-workflow`. The repository marketplace file alone is not enough: register it with `plugin marketplace add` or a `marketplaces` configuration entry. Installed copies live under `$CODEX_HOME/plugins/cache/`.

Trusted projects can enable or disable the Codex plugin in `.codex/config.toml`:

```toml
[plugins."agent-workflow@agent-workflow"]
enabled = true
```

Codex's `approval_policy = "never"` automatically accepts empty confirmation dialogs; required-field workflow choices are cancelled. To see dialogs, use `-c approval_policy="on-request"` ([Codex approval](host-mcp.md#codex-approval)).

Restart the session after installation. Claude Code lists the server as `plugin:agent-workflow:agent-workflow`; Codex lists it as `agent-workflow`.

## Alternative: `mcp add`

Without plugin skills, the server's instructions still provide the tool protocol:

```sh
claude mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host claude-code
codex mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host codex
```

Replace the version with the package version you want. With a global install (`npm install -g @agwab/agent-workflow`), use `agent-workflow-mcp --host …` directly.

`claude mcp add` accepts `--scope local|project|user` (`project` writes `.mcp.json`). `codex mcp add` writes `[mcp_servers.agent-workflow]` in `~/.codex/config.toml`.

## Timeouts

`workflow_wait` uses up to 30 min per call where the host limit is known, otherwise 45 s. See [long waits](host-mcp.md#long-waits).

- The Codex plugin sets `tool_timeout_sec = 1920`, server flag `--tool-timeout-ms 1920000`, and `startup_timeout_sec = 120` for the first `npx` download.
- With `codex mcp add`, waits remain 45 s. For 30 min waits, add `--tool-timeout-ms 1920000` after `--host codex` **and** set `tool_timeout_sec = 1920` under `[mcp_servers.agent-workflow]`. The flag alone can exceed Codex's tool limit. Add `startup_timeout_sec = 120` if first startup times out.
- Claude Code uses `MCP_TIMEOUT` for startup and `MCP_TOOL_TIMEOUT` for calls (milliseconds), or per-server `timeout` in `.mcp.json`/`mcpServers`. The plugin sets none. If the first download is slow, start Claude Code with `MCP_TIMEOUT=60000`.

## Status line and watch

A Claude Code plugin cannot set the main status line. Add this to `~/.claude/settings.json` or a trusted project's `.claude/settings.json`:

```json
{"statusLine": {"type": "command", "command": "agent-workflow statusline", "refreshInterval": 2}}
```

Without a global install, use `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow statusline` as the command. It shows active workflow progress and nothing when idle.

For either host, run `agent-workflow watch [runId]` in another terminal pane to see tasks, elapsed time, pending approvals, and final verdict/report. `--bell` rings when the run ends. Codex's `tui.status_line` accepts only built-in items, not commands. See [CLI feedback commands](cli.md#statusline-watch-notify-check).

## Completion check hook

`agent-workflow notify-check` announces newly settled run states once. A `UserPromptSubmit` hook adds its output to the host's context at the user's next message. Interactive session wake mechanisms work without waiting for another prompt; see [completion delivery](host-mcp.md#completion-delivery).

### Claude Code

The plugin includes a `UserPromptSubmit` command hook with a 60 s timeout. It runs this in `$CLAUDE_PROJECT_DIR`:

```sh
npx -y --package=@agwab/agent-workflow@<package version> agent-workflow notify-check --host claude-code
```

The generated hook skips CLI startup when there are no runs or no `run.json` changes since `.agent-workflow/notify-check/hook-claude-code.stamp`. Its shell only reads workspace paths; `notify-check --stamp hook-claude-code` writes the stamp through a contained writer after success. Failed checks or changes during a check are retried at the next prompt. At most 5 runs are announced per check; deferred runs prevent stamping so the next prompt drains the backlog. Errors print nothing and do not fail the prompt.

The plugin also declares the interactive `run-completion` monitor under `experimental.monitors`. It follows session-scoped completion checks and wakes idle sessions, so agents need not poll. See [Claude Code monitor](host-mcp.md#waiting-without-polling-the-claude-code-completion-monitor).

### Codex

The plugin ships no Codex lifecycle hook. To add next-prompt completion checks, put this in `~/.codex/hooks.json` or a trusted project's `.codex/hooks.json`, then trust it with `/hooks`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -d .agent-workflow/workflows ] || exit 0; agent-workflow notify-check --host codex 2>/dev/null; exit 0",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

Codex runs hooks in the session directory and adds stdout as developer context. Without a global install, substitute the version-pinned `npx --package` command. Interactive Codex sessions also receive supervisor-delivered completions through `codex queue`; `codex exec` uses waits ([details](host-mcp.md#waiting-without-polling-codex-sessions)).

## Tool names

Skills use short tool names; hosts prefix them:

| Registration | Model-visible name |
|---|---|
| Claude Code plugin | `mcp__plugin_agent-workflow_agent-workflow__workflow_run` |
| `claude mcp add agent-workflow` | `mcp__agent-workflow__workflow_run` |
| Codex plugin or `mcp add` | `mcp__agent_workflow__workflow_run` |

In Codex code mode, MCP functions are called inside JavaScript cells, for example `tools.mcp__agent_workflow__workflow_run({…})`. A long call can outlast the cell's 30 s yield; the model resumes it with `wait`. Long-wait guidance supplies a `// @exec` `yield_time_ms` pragma ([long waits](host-mcp.md#long-waits)).

Codex names plugin skills `agent-workflow:agent-workflow`, `agent-workflow:workflow-guide`, and `agent-workflow:execution-router`.

## Local development

```sh
npm run build
node tools/release/plugins.mjs dev /tmp/aw-dev
claude --plugin-dir /tmp/aw-dev/plugins/agent-workflow
```

Use `--force` to rewrite a development marketplace. Its server command uses absolute paths: `<node> <checkout>/src/mcp/host-server/bin.mjs --host claude-code|codex`.

Use a throw-away `CODEX_HOME` for Codex integration probes: `codex app-server`'s `thread/start` can write project trust into its configuration. Do not probe against the user's real configuration.

## Limits

The generated completion-hook command uses POSIX shell. Windows `npx.cmd` startup and Git Bash hook behavior have not been verified.
