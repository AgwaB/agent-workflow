# Claude Code and Codex plugins

WP14/WP15. One plugin, `plugins/agent-workflow/`, makes agent-workflow usable from a Claude Code or
Codex conversation: it registers the [host MCP server](host-mcp.md) `agent-workflow-mcp` with the
right `--host` for each host and ships three skills. The plugin is the main install path; a one-line
`mcp add` is the alternative. Verified offline with Claude Code 2.1.310 and codex-cli 0.159.2.

## What the user gets

Ask for a workflow in the conversation ("run deep-review on the current diff", "deep-research X").
The agent calls `workflow_list` if the name is unclear, `workflow_run` (returns a `runId` at once,
the run is detached), then `workflow_wait` in calls of at most 45 s until the run is finished, and
finally quotes the result preview and report paths. Permission mode is `free` unless the user asks
for `safe`; the executor is the workflow profile or the host default unless the user names one.
`workflow_status`, `workflow_inspect`, `workflow_logs` and `workflow_stop` manage runs, `workflow_validate` checks a
spec. WP28: the other CLI commands are tools too (`workflow_resume`, `workflow_show`, `workflow_roles`,
`workflow_agents`, `workflow_notices`, `workflow_doctor`, `workflow_prune`, `workflow_profile`,
`workflow_supervise`); prune, profile and notices changes ask the user to confirm in a dialog.
WP29: `workflow_approve` answers a dynamic-controller approval a run waits on, also after a dialog.
Details: [host-mcp.md](host-mcp.md).

WP36: when a run outlives the host's patience, the user follows it in a terminal with
`agent-workflow watch <runId>`, sees it in Claude Code's status line (`agent-workflow statusline`,
user setting), and the Claude Code plugin's prompt hook adds a line such as
`agent-workflow: workflow "deep-review" (run …) finished — verdict NEEDS_WORK, report …` to the
conversation at the user's next message ([below](#completion-check-hook)).

## Layout

```
.claude-plugin/marketplace.json          Claude Code marketplace (repo root)
.agents/plugins/marketplace.json         Codex marketplace (repo root)
plugins/agent-workflow/
  .claude-plugin/plugin.json             Claude Code manifest: mcpServers → --host claude-code,
                                         hooks → UserPromptSubmit notify-check (WP36)
  .codex-plugin/plugin.json              Codex manifest: mcpServers → --host codex, skills, timeouts
  README.md
  skills/agent-workflow/                 tool call protocol (source: skills/agent-workflow/)
  skills/workflow-guide/                 authoring guide + scaffolds, adapted to the MCP tools
  skills/execution-router/               route recommendation, adapted to the MCP tools
  reference/                             docs/usage.md, workflows/README.md, 4 bundled spec.json
```

Why this shape:

- **One directory, two manifests.** Claude Code reads only `.claude-plugin/plugin.json`; Codex reads
  the first of root `plugin.json` (Agent Plugins), `.codex-plugin/plugin.json`,
  `.claude-plugin/plugin.json`. Each manifest declares the server inline with its own `--host`, so
  each host passes the right value. There is no `.mcp.json` (Claude Code would load it as a second
  server).
- **No portable root `plugin.json`/`mcp.json`.** Codex starts Agent Plugins stdio servers in the
  plugin root (`cwd` defaults to `${PLUGIN_ROOT}` and may only point inside the plugin or its data
  directory), but the server takes its project from its working directory. Measured: a portable
  `mcp.json` server started in `$CODEX_HOME/plugins/cache/agent-workflow/agent-workflow/0.1.0`; the
  same server from `.codex-plugin/plugin.json` started in the session directory. The compatibility
  manifest stays supported by Codex. Switching to the portable layout needs the server to learn the
  project from the client instead (open item).
- **Not the repo root as plugin.** The repository is ~40 MB with `agents/*.md` that Claude Code would
  load as subagents; hosts copy or clone the plugin directory on install.
- **Generated.** `node tools/release/plugins.mjs build` writes the plugin and both marketplaces from
  `package.json` (version), `skills/` and the docs; `… check` reports drift and the unit test fails
  on drift. The root skills keep the Pi names (`aw_*`, `/aw`); the generator replaces them with the
  MCP tool names and fails when an expected source sentence changed. Do not edit
  `plugins/agent-workflow/` by hand.
- **Pi skills (WP33).** The same generator writes `plugins/pi/skills/aw-workflow-guide/` and
  `plugins/pi/skills/aw-execution-router/`: renamed copies of `skills/workflow-guide` and
  `skills/execution-router` (frontmatter `name` with the `aw-` prefix, relative paths pointing into
  the package) for the Pi package manifest (`pi.skills`; `plugins/pi` is in package.json `files`).
  Pi keeps the first skill of a name and pi-workflow ships the unprefixed names (owner decision
  Q10). `check` also fails when `pi.skills` does not list exactly these directories.

## Server launch

Released plugin: `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow-mcp
--host <claude-code|codex>`. The version is pinned exactly (test: equal to `package.json`).
`--package` is required: with `npx <package> agent-workflow-mcp`, npx runs the package's bin named
like the package (`agent-workflow`) and passes `agent-workflow-mcp` as an argument. The first start
downloads the package (Node.js 22+). Until the package is on npm (stage 3) use the dev plugin below
or an `mcp add` registration of a local install. Verified with a packed tarball:

```
$ npx -y --package=<dir>/agwab-agent-workflow-0.1.0.tgz agent-workflow-mcp --host codex   # + initialize, tools/list
serverInfo: {"name":"agent-workflow","version":"0.1.0"}
tools: workflow_list,workflow_run,workflow_dynamic,workflow_status,workflow_wait,workflow_stop,workflow_inspect,workflow_validate
```

(Recorded before WP18b added `workflow_logs` and WP28 added the CLI-command tools; the server now
lists 18 tools.)

## Install (plugin)

Claude Code:

```sh
claude plugin marketplace add AgwaB/agent-workflow
claude plugin install agent-workflow@agent-workflow              # --scope project|local to share/limit
# in a session (Claude Code 2.1.275+): /plugin install agent-workflow --marketplace AgwaB/agent-workflow
```

Codex:

```sh
codex plugin marketplace add AgwaB/agent-workflow                # optional: --sparse .agents/plugins --sparse plugins/agent-workflow
codex plugin add agent-workflow@agent-workflow
```

Per project, Codex can switch an installed plugin on or off in `.codex/config.toml` (loaded only for
trusted projects): `[plugins."agent-workflow@agent-workflow"] enabled = true|false`. The repo
marketplace file `.agents/plugins/marketplace.json` alone was not picked up by the 0.159.2 CLI
(`codex plugin marketplace list`: "No plugin marketplaces in scope." in a trusted project); the
CLI needs `codex plugin marketplace add` (or a `marketplaces` config entry), and `plugin add`
installs the copy into `$CODEX_HOME/plugins/cache/`.

Codex's `approval_policy` decides whether you see the confirmation dialogs: under
`approval_policy = "never"` Codex auto-accepts confirm dialogs (auto consent, degradations,
approvals, profile/prune/notice changes) without asking, and agent-workflow treats that as your
consent (owner decision O2, like the permission mode `free`). To be asked, start Codex with
`-c approval_policy="on-request"` ([host-mcp.md](host-mcp.md#codex-approval_policy--never-owner-decision-o2-2026-10-28)).

Restart the session after installing. Claude Code shows the server as
`plugin:agent-workflow:agent-workflow` (`claude mcp list`), Codex as `agent-workflow`.

## Alternative: `mcp add`

Without the plugin (no skills; the server's own instructions carry the call protocol):

```sh
claude mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host claude-code
codex mcp add agent-workflow -- npx -y --package=@agwab/agent-workflow@0.1.0 agent-workflow-mcp --host codex
```

With the package installed (`npm install -g @agwab/agent-workflow`), the command is just
`agent-workflow-mcp --host …`. `claude mcp add` takes `--scope local|project|user`
(`project` writes `.mcp.json`); `codex mcp add` writes `~/.codex/config.toml`
(`[mcp_servers.agent-workflow]`).

## Timeouts

- `workflow_wait` blocks at most 45 s per call, below Codex's default `tool_timeout_sec` (60 s).
  The Codex manifest sets `tool_timeout_sec = 120` (launches can take longer than a wait) and
  `startup_timeout_sec = 120` (first `npx` download). With `codex mcp add`, set both under
  `[mcp_servers.agent-workflow]` in `~/.codex/config.toml` if the first start times out.
- Claude Code: `MCP_TIMEOUT` (server start, ms) and `MCP_TOOL_TIMEOUT` (tool calls, ms), or a
  per-server `timeout` (ms) in an `.mcp.json`/`mcpServers` entry. The plugin sets none; if the first
  `npx` start is slow, start Claude Code once with `MCP_TIMEOUT=60000`.

## Status line and watch

WP36 ([host-ux-investigation.md](host-ux-investigation.md), [cli.md](cli.md#statusline-watch-notify-check)).

- **Claude Code status line.** A plugin cannot set `statusLine` (a plugin's settings apply only
  `agent` and `subagentStatusLine`), so the user adds it to `~/.claude/settings.json` or the
  project's `.claude/settings.json`:
  `{"statusLine": {"type": "command", "command": "agent-workflow statusline", "refreshInterval": 2}}`
  (with `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow statusline` when the
  package is not installed globally). It shows `aw: deep-review 5/13 running 12m · +1 more` and
  nothing when idle; the folder must be trusted.
- **Codex and Claude Code: `agent-workflow watch [runId]`** in another terminal pane: tasks, status,
  elapsed, pending approvals and the verdict and report at the end; `--bell` rings the terminal bell
  when the run ends. Codex has no status-line command (`tui.status_line` takes only built-in items)
  and no `watch` of its own.

## Completion check hook

The host MCP server cannot push a result into the conversation (no completion push on the installed
versions: [host-ux-investigation.md](host-ux-investigation.md)). The common mechanism (owner decision
E2) is `agent-workflow notify-check`, run from a hook whose output the host adds to the model's
context: at the user's next message, each run that finished since the last check is announced once.

- **Claude Code (shipped in the plugin).** `.claude-plugin/plugin.json` declares an inline
  `UserPromptSubmit` command hook (timeout 60 s) that runs
  `npx -y --package=@agwab/agent-workflow@<package version> agent-workflow notify-check --host claude-code`
  in the project directory (`$CLAUDE_PROJECT_DIR`; exact command: `notifyHookCommand` in
  `tools/release/plugins.mjs`). The hook runs on every prompt, so it starts the CLI only when it has
  something to check: in a project without runs it is a directory test, and after a successful check
  it keeps a stamp (`.agent-workflow/notify-check/hook-claude-code.stamp`) and exits at once unless a
  `run.json` changed since (one `find`; no `npx` start while nothing changed). The stamp is touched
  before the check starts and kept only when the check succeeded, so a change during a check or a
  failed check is looked at again on the next prompt. It never blocks a prompt and prints nothing on
  errors. Claude Code adds the plain stdout of `UserPromptSubmit` hooks to the
  context. There is no `hooks/hooks.json` (Claude Code loads that file by default, and Codex would
  read it too). The dev plugin runs the checkout's CLI instead of `npx`.
- **Codex (manual).** The plugin ships no Codex hook: Codex skips plugin hooks until the user
  trusts them in `/hooks`, and plugins with lifecycle hooks are not eligible for the public plugin
  directory. Add it to `~/.codex/hooks.json` or the project's `.codex/hooks.json` (trusted projects
  only), then trust it with `/hooks`:

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

  Codex runs hooks in the session directory and adds plain stdout of `UserPromptSubmit` as developer
  context. Without a global install, use the `npx -y --package=@agwab/agent-workflow@<package version>
  agent-workflow` form.
- Not live-verified yet (bundle 5, checks L1 and L5 in the investigation). Push into an idle
  session (Claude Code plugin monitors with `notify-check --follow`, `asyncRewake` hooks, a
  backgrounded long wait; `codex queue`) needs live checks first.

## Tool names

The skills use the short names (`workflow_run`, …). Hosts prefix them:

| Registration | Name the model sees |
|---|---|
| Claude Code plugin | `mcp__plugin_agent-workflow_agent-workflow__workflow_run` (Claude Code's `mcp__plugin_<plugin>_<server>__` scheme) |
| `claude mcp add agent-workflow` | `mcp__agent-workflow__workflow_run` |
| Codex (plugin or `mcp add`) | `mcp__agent_workflow__workflow_run`: Codex turns the hyphen of the server name into an underscore (observed live 4b, codex-cli 0.159.2). In code mode, the 0.159.2 default, the model's only tools are `exec` (a JavaScript cell) and `wait`; the MCP tools are functions inside the cell, called as `tools.mcp__agent_workflow__workflow_run({…})`. The `codex exec --json` stream still reports server `agent-workflow`, tool `workflow_run`. |

A `workflow_wait` call (up to 45 s) can outlast Codex's 30 s code-mode cell yield; the model then
resumes the cell with `wait` ([live-acceptance-stage2.md](live-acceptance-stage2.md#case-2-codex-host--codex-workers)).

Codex lists plugin skills as `agent-workflow:agent-workflow`, `agent-workflow:workflow-guide`,
`agent-workflow:execution-router`.

## Local development

```sh
npm run build                                          # bin.mjs runs dist/
node tools/release/plugins.mjs dev /tmp/aw-dev        # marketplace root; --force to rewrite
claude --plugin-dir /tmp/aw-dev/plugins/agent-workflow
```

The dev copy equals the committed plugin except the server command:
`<node> <checkout>/src/mcp/host-server/bin.mjs --host claude-code|codex` (absolute paths). For Codex,
test in a throw-away `CODEX_HOME` so the user configuration stays untouched (next section).

## Validation evidence (offline, no model turn)

Paths are scrubbed (`<repo>`, `<tmp>`, `$CODEX_HOME`).

Claude Code 2.1.310:

```
$ claude plugin validate plugins/agent-workflow --strict        → ✔ Validation passed
$ claude plugin validate . --strict                             → ✔ Validation passed   (marketplace)
$ claude plugin validate <tmp>/market/plugins/agent-workflow --strict   → ✔ Validation passed (dev copy)
$ claude --plugin-dir <tmp>/market/plugins/agent-workflow mcp list       # in <tmp>/proj
plugin:agent-workflow:agent-workflow: <node> <repo>/src/mcp/host-server/bin.mjs --host claude-code - ✔ Connected
# with CLAUDE_CONFIG_DIR=<tmp>/claude-config (not the user's config):
$ claude plugin marketplace add <tmp>/market       → ✔ Successfully added marketplace: agent-workflow
$ claude plugin install agent-workflow@agent-workflow --scope project
                                                   → ✔ Successfully installed plugin: agent-workflow@agent-workflow (scope: project)
$ claude plugin details agent-workflow@agent-workflow
  Skills (3)  agent-workflow, execution-router, workflow-guide
  MCP servers (1)  agent-workflow
  Always-on: ~246 tok
$ claude mcp list   → plugin:agent-workflow:agent-workflow: … --host claude-code - ✔ Connected
```

WP36, same procedure with the dev plugin (throw-away `CLAUDE_CONFIG_DIR` and project):
`claude plugin validate plugins/agent-workflow --strict` → `✔ Validation passed`;
`claude plugin details agent-workflow@agent-workflow` → `Hooks (1)  UserPromptSubmit  (harness-only
— no model context cost)`, `Always-on: ~267 tok`.

A probe server confirmed that Claude Code starts plugin servers in the project directory
(`CLAUDE_PROJECT_DIR` set) and expands `${CLAUDE_PLUGIN_ROOT}` (not `${PLUGIN_ROOT}`) in `args`; it
ignores a root `mcp.json`.

codex-cli 0.159.2, temporary project `<tmp>/cproj` = the dev marketplace root (`node tools/release/plugins.mjs dev <tmp>/cproj`)
plus `git init` and `.codex/config.toml` enabling `agent-workflow@agent-workflow`; `CODEX_HOME` is a
temporary directory (no login); per-run overrides
`T='projects={"<tmp>/cproj"={trust_level="trusted"}}'` and
`M='marketplaces={agent-workflow={source_type="local",source="<tmp>/cproj"}}'` (the dotted form
`projects."<path>".trust_level=…` did not apply):

```
$ codex -c "$T" plugin marketplace list            → No plugin marketplaces in scope.
$ codex -c "$T" -c "$M" plugin marketplace list    → agent-workflow  <tmp>/cproj
$ codex -c "$T" -c "$M" plugin list                → agent-workflow@agent-workflow  not installed
$ codex -c "$T" -c "$M" plugin add agent-workflow@agent-workflow
  Installed plugin root: $CODEX_HOME/plugins/cache/agent-workflow/agent-workflow/0.1.0
$ codex -c "$T" -c "$M" plugin list                → agent-workflow@agent-workflow  installed, enabled  0.1.0
$ codex -c "$T" -c "$M" mcp list
  agent-workflow  <node>  <repo>/src/mcp/host-server/bin.mjs --host codex  -  -  enabled  Unsupported
# user config emptied: enablement then comes from the project file; untrusted (no "$T") → not installed;
# project enabled = false → installed, disabled
```

`codex mcp list` does not start servers. To see skills and tools without a model turn, drive
`codex app-server` over stdio, cwd `<tmp>/cproj`: `initialize` → `thread/start {cwd, ephemeral:
true}` → `skills/list {cwds:[cwd], forceReload:true}` → `mcpServerStatus/list {threadId}`; never
`turn/start`. (Thread start also tries to pre-connect the Responses websocket; without a login it
fails with 401 and nothing is sent.)

**`thread/start` trusts its cwd in the config it runs with**: it writes `[projects."<cwd>"]
trust_level = "trusted"` into `$CODEX_HOME/config.toml` unless the project is already trusted
(live 4 wrote this entry into the real `~/.codex/config.toml`). Keep the probe away from the user
config:

```sh
export CODEX_HOME="$(mktemp -d)"          # throw-away; never the real ~/.codex for this probe
T='projects={"<tmp>/cproj"={trust_level="trusted"},"/private<tmp>/cproj"={trust_level="trusted"}}'
codex -c "$T" -c "$M" app-server          # inline trust: thread/start writes no trust_level entry
```

The inline `projects` override (both the path and its `/private` realpath on macOS) also kept the
real config untouched in live 4b, where the real `CODEX_HOME` (login) was needed. If the real
config must be used, back it up first and restore it afterwards:

```sh
cp ~/.codex/config.toml /tmp/codex-config.backup.toml
# … codex -c "$T" … runs …
diff /tmp/codex-config.backup.toml ~/.codex/config.toml   # expect no trust_level line
cp /tmp/codex-config.backup.toml ~/.codex/config.toml && cmp /tmp/codex-config.backup.toml ~/.codex/config.toml
```

```
skill: agent-workflow:agent-workflow   -> $CODEX_HOME/plugins/cache/agent-workflow/agent-workflow/0.1.0/skills/agent-workflow/SKILL.md
skill: agent-workflow:execution-router -> …/skills/execution-router/SKILL.md
skill: agent-workflow:workflow-guide   -> …/skills/workflow-guide/SKILL.md
mcp server: agent-workflow plugin: agent-workflow@agent-workflow status: "connected" server: agent-workflow
  tools: workflow_dynamic,workflow_inspect,workflow_list,workflow_run,workflow_status,workflow_stop,workflow_validate,workflow_wait
```

Probe findings for Codex: `.codex-plugin/plugin.json` servers start in the thread's cwd without
`PLUGIN_ROOT`/`PLUGIN_DATA` and without placeholder expansion in `args`; portable `mcp.json` servers
start in the plugin cache root with `PLUGIN_ROOT`/`PLUGIN_DATA` set and `${PLUGIN_ROOT}` (not
`${CLAUDE_PLUGIN_ROOT}`) expanded in `args`. `startup_timeout_sec`/`tool_timeout_sec` in the
compatibility manifest are honored (`codex mcp list --json`).

Unit tests: `test/unit/plugin-manifests.test.mjs` (generator drift, fields, version, npx pin,
per-host `--host`, timeouts, no `.mcp.json`/portable manifest, marketplace paths, not in the npm
package), `plugin-skills.test.mjs` (skills present, tool names = server tools, 45 s cap, no Pi names,
`../../reference` paths exist), `plugin-dev-generator.test.mjs` (dev output, `--force`, usage
errors, the dev Codex command serving `tools/list` in a project directory).

## Open items (live step)

- One live conversation per host: install from the marketplace, run deep-review through the tools,
  confirm the exact tool permission names above, which of `content`/`structuredContent` the model
  sees, elicitation with the empty form, and that the server's cwd is the project in a real session.
- Codex: whether the repo marketplace is picked up by the interactive CLI or only the desktop app.
- The `npx` pin works only after `@agwab/agent-workflow` is published (stage 3).
- Portable Agent Plugins layout for Codex once the server can take the project from the client
  (for example MCP roots or Codex's sandbox-state metadata) instead of its working directory.
- Windows: `npx` resolves to `npx.cmd`; not verified. The WP36 hook command is POSIX shell (Claude
  Code runs hooks through Git Bash on Windows; not verified).
- WP36 live checks L1-L6 ([host-ux-investigation.md](host-ux-investigation.md#live-checks-for-bundle-5-one-host-turn-each-temporary-projects-and-config)).
