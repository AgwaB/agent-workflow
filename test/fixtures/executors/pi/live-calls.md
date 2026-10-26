# WP6 live Pi calls

Budget: at most 25 Pi invocations that reach a model. Used: **18**. Pi 1.1.0, macOS. All runs used the
caller's real environment (Pi owns its login, D1) in fresh `/tmp/aw-live-pi-*` directories (`<TMP>`), except
calls #5–#11. Those ran from `test/unit/executor-pi-live.test.mjs` before the test was switched to `/tmp` and used
the OS temp dir. No credential file was read. No dangerous, bypass or auto-approve mode was used. Every run
except #1 went through the adapter (isolated: `--no-context-files --no-extensions --no-skills
--no-prompt-templates --no-themes --no-approve`). The prompt goes to stdin, so it is never on argv.

Model choice:

- The cheapest model in `pi --list-models` with a working credential.
- `openai/gpt-5-nano` ($0.05/$0.40 per M) is cheaper on paper. The `OPENAI_API_KEY` in the environment is
  stale (#1), although `pi auth check` reports `ready`.
- `google/gemma-4-26b-a4b-it` costs $0 in Pi's catalog, but it failed with HTTP 500 after its first tool call (#2).
- `google/gemini-2.5-flash-lite` ($0.10/$0.40) was used next. Its Google free-tier daily quota (20 requests)
  ran out at #15.
- `google/gemini-3.1-flash-lite` ($0.25/$1.50) was used after that.
- Effort was `minimal` throughout.

Cost: Pi computes it from its model catalog (`usage.cost.total`), so the adapter reports it as `estimated`. A cost
of 0 is reported as unknown. The key is on Google's free tier, so the amount actually billed is probably $0.

Common argv prefix (written `<iso>` below), from the adapter:
`pi --mode json --print --no-session --exclude-tools subagent --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`.
Each run also gets `-e <attempt>/pi-extension.mjs`, the generated per-run extension.

| # | Purpose | argv (after `pi`; secrets: none on argv) | Model | Duration | Tokens in/out/cached | Cost (Pi, estimated) | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | Accidental. A model-id probe for the error table; `:bogus` became a custom model id, and Pi sent the request | `--mode json --print --no-session -ne -ns -np -nc -na --model openai/gpt-5-nano:bogus --no-tools hi` | openai/gpt-5-nano:bogus | ~1 s | 0/0/0 | 0 (not reported) | failed: OpenAI 401 `invalid_api_key`, Pi exit 0, stopReason `error`. Transcript `fail-auth-openai-401` |
| 2 | Smoke (read tool) | `<iso> --model google/gemma-4-26b-a4b-it --thinking minimal --tools read -e …` | google/gemma-4-26b-a4b-it | 4.1 s | 743/16/0 | not reported (0) | read tool ran; 2nd request failed with Google HTTP 500. Transcript `fail-transient-google-500` |
| 3 | Smoke (read tool + answer) | `<iso> --model google/gemini-2.5-flash-lite --thinking minimal --tools read -e …` | gemini-2.5-flash-lite | 3.5 s | 1794/142/0 | $0.000236 | completed ("bravo"). Transcript `complete-read` |
| 4 | Native MCP: `workflow_artifact` server, 50,000-char artifact, `--max-output-chars 20480` | `<iso> --model google/gemini-2.5-flash-lite --thinking minimal --tools read,mcp__workflow_artifact__* -e …` | gemini-2.5-flash-lite | 4.4 s | 7172/231/0 | $0.000810 | completed. Tool `mcp__workflow_artifact__workflow_artifact`; 20,480 chars delivered, no Pi cut; ledger `deliveryUnverified: true`. Transcript `mcp-artifact-read` |
| 5 | Live test smoke | `<iso> --model google/gemini-2.5-flash-lite --thinking minimal --tools read -e …` | gemini-2.5-flash-lite | 3.2 s | 1806/146/0 | $0.000239 | completed |
| 6 | Kit `live.readonly_enforced` (tools read,write,edit,bash + readOnly) | `<iso> --model … --thinking minimal --tools read -e …` | gemini-2.5-flash-lite | 1.9 s | 770/87/0 | $0.000112 | pass (file not created) |
| 7 | Kit `live.tool_allowlist` (tools read, readOnly false) | `<iso> --model … --thinking minimal --tools read -e …` | gemini-2.5-flash-lite | 3.1 s | 771/135/0 | $0.000131 | pass (no shell) |
| 8 | Kit `live.isolation` (AGENTS.md + CLAUDE.md in cwd) | `<iso> --model … --thinking minimal --no-tools -e …` | gemini-2.5-flash-lite | 2.1 s | 574/25/0 | $0.000067 | pass (token not followed) |
| 9 | Kit `live.session_ownership` | `pi --mode json --print --session-dir <state>/sessions/<uuid> --session-id <uuid> …isolation… --model … --thinking minimal --no-tools -e …` | gemini-2.5-flash-lite | 2.1 s | 574/18/0 | $0.000065 | pass (ownedSession reported) |
| 10 | Kit `live.resume`, turn 1 | as #9 with a new uuid | gemini-2.5-flash-lite | ~1.9 s | 580/32/0 | $0.000071 | turn kept |
| 11 | Kit `live.resume`, turn 2 | `pi --mode json --print --session-dir <state>/sessions/<uuid> --session <state>/sessions/<uuid>/<file>.jsonl …` (different cwd) | gemini-2.5-flash-lite | ~1.9 s | 634/46/0 | $0.000082 | pass (codeword recalled) |
| 12 | Concurrency 1/3 (parallel) | `<iso> --model google/gemini-2.5-flash-lite --thinking minimal --tools read -e …` | gemini-2.5-flash-lite | 4.6 s | 882/97/740 | $0.000134 | completed, own file content |
| 13 | Concurrency 2/3 | same | gemini-2.5-flash-lite | 4.0 s | 1742/112/0 | $0.000219 | completed, own file content |
| 14 | Concurrency 3/3 | same | gemini-2.5-flash-lite | 4.5 s | 1720/125/0 | $0.000222 | completed, own file content |
| 15 | Web tool (`web_search` via pi-web-access, loaded with `-e` under isolation) | `<iso> --model google/gemini-2.5-flash-lite --thinking minimal --tools web_search -e … -e <HOME>/.pi/agent/npm/node_modules/pi-web-access` (+ `pi list` probe, no model) | gemini-2.5-flash-lite | 3.7 s | 1260/128/0 | $0.000177 | `web_search` **completed**; the follow-up request failed: Google 429 `RESOURCE_EXHAUSTED` (free-tier day quota). Transcript `fail-rate-limit-google-429` |
| 16 | Interrupted run: adapter `cancel(owned)` after 2.5 s | `<iso> --model google/gemini-3.1-flash-lite --thinking minimal --no-tools -e …` | gemini-3.1-flash-lite | 2.5 s | not reported (cut before usage) | not reported | failed/cancelled, Pi exit 143, 10 text deltas before the cut. Transcript `interrupted-live-sigterm` |
| 17 | Runtime: detached durable worker reloads the adapter from its descriptor | `<iso> --model google/gemini-3.1-flash-lite --thinking minimal --tools read -e <attempt dir>/pi-extension.mjs` | gemini-3.1-flash-lite | 12.8 s (incl. worker) | 1590/27/0 | $0.000438 | completed ("charlie"), authority released, exec-events + raw stream in the attempt dir |
| 18 | Web tool, second call (**deviation**, see below) | `<iso> --model google/gemini-3.1-flash-lite --thinking minimal --tools web_search -e … -e <HOME>/.pi/agent/npm/node_modules/pi-web-access` | gemini-3.1-flash-lite | 4.5 s | 3467/38/0 | $0.000924 | completed; `web_search` completed (2,893 chars). Transcript `web-search-live` |

**Totals:** 18 invocations, 26,079 input / 1,405 output / 740 cached tokens. Pi's estimated cost is
**$0.00393**. Billing is probably $0, because the key is on Google's free tier.

**Deviation (web budget).** The task allowed at most one live call to the CLI's native web tool. #15 called
`web_search` successfully, but I misread its failed terminal state (quota 429 on the follow-up request) as
"the tool never ran". I then ran #18, so `web_search` executed twice. Nothing else touched the web.

Offline evidence used the real Pi CLI with a scripted faux provider (`@earendil-works/pi-ai` `fauxProvider`)
loaded by `-e`. These runs make no model call and are not counted. They covered:

- isolation sections;
- native MCP (private instance, user `mcp.json` not loaded);
- the 20,480/20,481-byte MCP boundary;
- stdin prompt;
- secret-channel deletion;
- orphan guard (worker SIGKILL ⇒ Pi exits);
- cross-cwd resume;
- the tool-result budget;
- SIGTERM exit 143;
- the error transcripts `fail-config-model-not-found`, `fail-auth-no-api-key` and `fail-unknown-flag-conflict`.
