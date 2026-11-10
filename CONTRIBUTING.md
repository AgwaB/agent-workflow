# Contributing to agent-workflow

Thanks for contributing to agent-workflow. This guide covers public documentation, code, workflows, executor and host integrations, and package changes.

## AI use and responsibility

You may freely use AI tools and autonomous agents for code, documentation, issues, and pull requests. No AI-use disclosure is required.

You must be able to explain what your change does, why it is needed, and how it affects the relevant workflow, runtime, executor, host integration, or public interface. AI-assisted and agent-submitted contributions follow the same validation and review requirements as any other contribution.

## Choose the right entry path

Open a pull request directly for a typo, clarification, or small documentation correction that does not change behavior.

For code, workflows, executor adapters, host integrations (the CLI, the MCP server and plugins, the Pi host), public APIs or schemas, performance or default changes, security-related design or configuration work, releases, or package changes, discuss the change in an existing issue or open one and align with a maintainer on:

- the problem and intended outcome;
- the proposed scope and non-goals;
- related issues or pull requests; and
- the validation plan.

Search existing issues and pull requests before opening a new one. Use **Bug Report** for a reproducible fault and **Change Proposal** to discuss a proposed change. An existing bug report can serve as the coordination issue; a separate proposal is not needed once a maintainer agrees on the scope and validation.

Keep issues short, concrete, and actionable: state the problem, why it matters, and whether you intend to implement the change. Never include credentials, access tokens, or private data. For suspected vulnerabilities, use [private security reporting](SECURITY.md) instead of a public issue or pull request.

Keep each pull request focused on one feature, fix, or documentation change. Do not combine unrelated cleanup with a behavioral change.

## Set up a local checkout

agent-workflow requires Node.js `>=22`. CI runs on macOS and Linux; native Windows is not tested.

Install the locked dependencies:

```bash
npm ci --legacy-peer-deps
```

Follow the surrounding code and documentation style. Keep generated workflow runs (in the [project state directory](docs/usage.md#where-run-state-lives)),
session data, and local investigation files out of commits. Repository `.agent-workflow/`
workflow specs and agent definitions are source files, not run state.

## Verify your change

Run every applicable check below. If a change fits more than one category, run the combined set of checks and report the results in the pull request.

| Change type | Required validation before opening a PR |
| --- | --- |
| Documentation-only | Review the rendered Markdown and verify changed links, commands, and examples. |
| General code or configuration | `npm run validate` |
| Workflow, CLI, executor, host, or runtime behavior | `npm run validate` and `npm run e2e` |
| Package contents, exports, plugins, or install surface | `npm run validate`, `npm run e2e`, and `npm run pack:dry` |
| Performance or default behavior | Include the applicable checks above plus an agreed before/after comparison and evidence that the change does not regress the affected behavior. |

Tests come in two tiers (`test/run-unit.mjs --tier=…`). A unit test must not depend on the clock: no fixed sleeps,
no assertions on elapsed time, no workflow engine runs, Chrome, HTTP servers or long-lived child processes —
`test/unit/test-tiers.test.mjs` checks the files and the unit-tier run refuses such processes and servers. A test that
needs them is an integration test: make `// test-tier: integration` its first line. Both tiers run in `validate` and
in CI. In an integration test, wait for the event (`test/helpers/wait-until.mjs`) rather than a fixed time, and count
or observe what happened rather than how long it took; a time bound should only guard against a hang.

After a large change, also run `npm run test:regression` once (not part of `validate` or CI): it replays recorded
real runs (`test/fixtures/regression/`) through the engine with their recorded model outputs and compares every
task's outcome and the final report with `test/fixtures/regression/golden/`. An intended change is re-recorded with
`AGENT_WORKFLOW_WRITE_REGRESSION=1 npm run test:regression` and reviewed in the diff; a new fixture is captured with
`node test/helpers/regression-fixtures.mjs --capture <run dir> <name>`. The same command checks, with the installed
`codex` binary (or `AGENT_WORKFLOW_CODEX_PATH`), a throwaway login and local fake servers, that a token refresh
inside a private worker home reaches the user's `auth.json`; it is skipped when no `codex` is installed.

Changes to dashboard animations also need `npm run test:ui-motion` (headless Chrome; its real-time animation checks are not part of `validate` or CI).

Changes to workflow prompts, agent/skill instructions, schemas, or helpers that affect behavior belong in the workflow/runtime category, regardless of file extension. For bug fixes, add a regression test when practical; otherwise explain how you verified the fix.

The unit and E2E suites do not start real executor CLIs or make model calls. Live tiers that do (`AGENT_WORKFLOW_LIVE=1`) cost model usage; they are not required for a pull request unless a maintainer asks for them, and then the model and cost are agreed first.

GitHub CI independently runs validation, E2E, and a package dry run across its supported OS and Node.js matrix. Local checks do not replace CI. If you cannot run an applicable check, say so in the pull request and explain why.

## Write commits

Use a concise conventional-commit subject, for example:

```text
fix: preserve workflow artifact paths
```

When the change needs context, add a short bullet-list body:

```text
fix(mcp): keep the project of a call without cwd

- use the client's single MCP root when the call names no cwd
- refuse a cwd-less call when the client has several roots
```

Standard Git trailers are allowed when they are accurate. For example, use `Co-authored-by` for an actual human coauthor. Do not use a tool or model as a human coauthor, and do not add inaccurate attribution. The project does not currently require DCO sign-off.

## Open a pull request

Use the repository pull request template. Replace its prompts with the relevant information rather than leaving required context blank.

A pull request should include:

- a short description of the problem and the change;
- a link to the prior coordination issue when one is required;
- the validation commands run and their results, plus anything not run;
- any behavior, compatibility, performance, or package-surface impact; and
- enough reproduction detail for a bug fix to be understood and checked.

Passing CI does not guarantee that a pull request will be merged. Maintainers may request changes to scope, implementation, tests, documentation, or validation evidence.
