# pi-workflow test inventory for the WP4 port

Source: pi-workflow `b83cc4f` (v0.16.4). `test/unit/` has 147 top-level
entries: 140 `*.test.mjs` files, 6 support modules/data files, and the
`helpers/` directory (2 more support modules). `test/e2e/` has 3 cases plus
4 harness files. Counts in `[n]` are top-level `test(...)` calls; some files
generate more tests from tables.

Tags (for WP4, the core port):

- `port-as-is`: engine/core behavior with no Pi or pi-subagent dependency. Only
  import paths should change.
- `port-adapted`: the behavior moves to agent-workflow, but the test drives the
  pi-subagent `SubagentApi` fake, Pi extension or tool registration, Pi
  process/env conventions, or bundled workflows that WP10 changes. It needs a
  new harness, either the executor SDK fake or the WP1b replay executor.
- `drop(reason)`: Pi-host-only, pi-workflow-package-only, or a surface the plan
  removes.
- `unknown`: I could not classify it quickly and with confidence.

These are first-pass tags. I classified from file names, test names, and
imported modules. I did not read every test body.

## test/unit/*.test.mjs (140)

| File | Covers | Tag |
|---|---|---|
| artifact-sidecar-settlement.test.mjs [1] | Output bundle failure waits for every started sidecar write before settling | port-as-is |
| bounded-raw-link-contract.test.mjs [15] | Raw output link/snapshot contract across runtime, store, artifact tool, output artifacts | port-adapted (uses subagent-backend refresh) |
| built-engine-frozen-bundle-regression.test.mjs [2] | Built engine cold-loads workflow-local seeds and fails before provider send on tampered copies | port-adapted |
| code-search-compat.test.mjs [10] | Legacy `code_search` Pi tool contract shim | drop(Pi extension tool compat shim) |
| dag-hardening.test.mjs [21] | Nested DAG requiredReads namespacing and fail-before-launch validation | port-as-is |
| deep-research-completion-output.test.mjs [5] | deep-research v2 completion renderer (evidence table, omitted candidates) | port-adapted (WP10 bundled change) |
| deep-research-integrity-regressions.test.mjs [14] | deep-research schemas/packets preserve local evidence; byte gate aliases | port-adapted (WP10; web parts drop) |
| deep-research-live-correction.test.mjs [1] | Research correction reconciles canonical slots, keeps blockers | port-adapted (WP10) |
| deep-research-optional-string-guidance.test.mjs [1] | Optional-string prompt guidance matches output contract | port-adapted (WP10) |
| deep-research-reader-output.test.mjs [8] | Historical synthesis readability, escaping in completion | port-adapted (WP10) |
| deep-research-runtime-constraints.test.mjs [1] | Verifier materialization preserves user constraints | port-adapted (WP10) |
| deep-research-sanitizer-followup.test.mjs [1] | Sanitizer rewrites unquoted obligations | port-adapted (WP10) |
| deep-research-static-floor.test.mjs [3] | Zero-candidate verification floor for repo-local claims | port-adapted (WP10) |
| deep-research-synthesis-pages.test.mjs [6] | Synthesis header/page structure at scale | port-adapted (WP10) |
| deep-research-verifier-identity.test.mjs [3] | Claim-owner materialization through runtime; verifier rejection cases | port-adapted (WP10) |
| deep-review-d01-d10.test.mjs [12] | deep-review defect identity/verifier payload rules D01-D10 | port-adapted (WP10) |
| deep-review-ledger-corrective.test.mjs [7] | deep-review partial-consumer replay after resume; read/OCR coverage | port-adapted (WP10) |
| deep-review-source-scope.test.mjs [2] | Source coverage scope/range contract | port-adapted (WP10) |
| dependency-lock-consistency.test.mjs [3] | Release script dependency/lock checks and CI node matrix | drop(pi-workflow release tooling; agent-workflow has its own tools/release) |
| dynamic-audit.test.mjs [9] | Dynamic claim-support audit joins (URL/ref ids, evidenceRefs) | port-as-is |
| dynamic-controller-regressions.test.mjs [9] | Decision dependencies, executable ids, invalid-attempt artifacts | port-as-is |
| dynamic-coordination-bundle-parity.test.mjs [7] | Bundled direct-dynamic planner prompt byte parity and escaping | port-adapted (bundle path) |
| dynamic-coordination-projection.test.mjs [35] | Coordination summary rendering order/ties | port-as-is |
| dynamic-coordination-replay.test.mjs [2] | Decision-loop replay keeps requestHash; fails closed on digest change | port-as-is |
| dynamic-fanout-requestid.test.mjs [1] | Fanout branch requestId sanitization | port-as-is |
| dynamic-tool-result-budget.test.mjs [8] | Dynamic child telemetry and tool-result budget metrics | port-adapted (Pi tool-result budget) |
| engine-output-retry-dispatch.test.mjs [4] | Output-validated attempts are never re-dispatched | port-adapted (fake SubagentApi) |
| engine-refresh.test.mjs [40] | waitForRun/refresh poll failures, foreach identity, refresh semantics | port-adapted (fake SubagentApi) |
| execution-profiles.test.mjs [8] | Execution profile names/defaults/overrides; bundled specs compile | port-as-is (bundled part WP10) |
| fast-mode.test.mjs [5] | `fast` runtime layering and Fast-model eligibility | port-adapted (Pi/OpenAI fast mode) |
| foreach-batch-runtime.test.mjs [20] | Foreach batch keys, envelopes, prompts, launch authority | port-adapted (fake SubagentApi) |
| graph-schema-contracts.test.mjs [9] | Loader/validator rejects malformed JSON-schema keyword values | port-as-is |
| helper-grounding-integrity.test.mjs [7] | Scaffold exact identity across reordering/case | port-as-is |
| host-package-policy.test.mjs [2] | Host packages are peers, never runtime deps | port-adapted (agent-workflow peer policy differs) |
| host-sdk-compat.test.mjs [3] | Host SDK peers match dev deps; fast-mode extension | drop(Pi host package policy) |
| impact-review-enum-control-guidance.test.mjs [1] | impact-review enum reducers show schema-valid controls | port-adapted (WP10) |
| impact-review-impact-fixes.test.mjs [18] | impact-review control validation, observation identity | port-adapted (WP10) |
| launch-slot-observer.test.mjs [1] | Launch-queue observer and abort ordering | port-adapted (launch slots move to runtime) |
| metrics-estimate-contracts.test.mjs [2] | Stage rollups and duration sampling | port-as-is |
| nested-workflow-depth-behavior.test.mjs [9] | Nested workflow depth allowances | port-as-is |
| no-send-controls.test.mjs [11] | State-root capabilities, pi-subagent 0.7.2 durable API lock | port-adapted (state root as-is; API lock drop) |
| normalized-provider-corrective.test.mjs [11] | Normalized web provider fetch policy | drop(workflow_web_* removed in WP10) |
| optional-output-sections.test.mjs [4] | Optional analysis/refs section rules | port-as-is |
| parent-usage-retention.test.mjs [4] | Parent-session usage vs pruning | port-adapted (parent usage is Pi-session specific) |
| partial-output-literal-preservation.test.mjs [7] | Partial output publication immutability, literal markers | port-as-is |
| pi-agent-dir.test.mjs [2] | `PI_CODING_AGENT_DIR` resolution for workflows/agents | drop(Pi config dir; hosts/pi only) |
| product-corrective-11.test.mjs [4] | Fetch cache EEXIST winner, provider URL abort | drop(web fetch cache removed in WP10) |
| product-corrective-12.test.mjs [6] | Legacy provider callbacks redaction | drop(web provider removed in WP10) |
| prompt-schema-reliability.test.mjs [6] | Prompt-schema diagnostics bytes/order/policy | port-as-is |
| raw-artifact-read-roundtrip.test.mjs [3] | Raw snapshot clone fallback via artifact tool | port-adapted (artifact tool becomes MCP server) |
| release-gates.test.mjs [2] | Forbidden-term scanner | drop(pi-workflow release tooling) |
| release-provenance.test.mjs [7] | npm publication provenance verification | drop(pi-workflow release tooling; agent-workflow has its own) |
| required-artifact-read-completeness.test.mjs [3] | Required-read ledger completeness | port-adapted (read ledger via artifact tool) |
| review-core-fixes.test.mjs [10] | Lease timeout deltas, durable receipts, parent usage | unknown |
| review-helper-byte-gates.test.mjs [16] | Scaffold byte gates (CRLF/whitespace) | port-as-is |
| review-helper-materialized.test.mjs [2] | spec-review scheduler/partition/renderer, scaffold byte gate | port-adapted (WP10) |
| review-runtime-refs-dns.test.mjs [2] | refs URL DNS timeout/recheck | drop(refs URL probing is web-tool coupled) / unknown |
| review-runtime-retention-depth.test.mjs [15] | Retention/prune of nested runs and ancestry | port-as-is |
| run-estimates.test.mjs [8] | Duration estimates from history | port-as-is |
| run-usage-rollup.test.mjs [2] | Terminal run usage rollup | port-as-is |
| runtime-bundled-api-boundary.test.mjs [1] | Installed bundled pi-subagent v2 release/revoke API | drop(pi-subagent bundling) |
| runtime-refs-transport-boundary.test.mjs [1] | refs URL probe with abrupt GET | drop(web-coupled) / unknown |
| runtime-storage-boundaries.test.mjs [10] | Multi-process lease serialization, atomic JSON, cancelled ops | port-as-is |
| runtime-transport-boundaries.test.mjs [1] | Direct-safe web transport on abrupt responses (flaky once under full-suite load during WP1a) | drop(web transport removed in WP10) |
| spec-requirement-coverage.test.mjs [2] | Escaped max-schema projections | port-adapted (WP10) |
| spec-review-live-spec-correction.test.mjs [2] | NONBLOCKING scope / NEEDS_HUMAN chain | port-adapted (WP10) |
| store-final-review-regression.test.mjs [3] | Frozen bundle provider collection, final stage selection | port-as-is |
| store-lease-contention.test.mjs [1] | Four-process lease handoffs | port-as-is |
| store-lease-handoff.test.mjs [6] | Lease release snapshot/rename races | port-as-is |
| store-lock-corrective.test.mjs [2] | Supervisor/index lock release | port-as-is |
| subagent-extension-preflight.test.mjs [1] | Pi extension preflight before model execution | port-adapted (executors/pi) |
| subagent-partial-output.test.mjs [1] | pi-subagent 0.7 partial-output scenarios | port-adapted (executor partial output) |
| surface-regressions.test.mjs [19] | Parent-usage ownership, previews, formatting, extension surfaces | unknown (mixed core/Pi) |
| surface-rpc-readiness.test.mjs [8] | Real Pi RPC startup readiness | drop(Pi RPC host) |
| surface-rpc.test.mjs [1] | Real Pi RPC `/workflow` command | drop(Pi RPC host; hosts/pi e2e) |
| thinking-max.test.mjs [3] | `max` thinking level mapping via pi-ai | port-adapted (executor capability) |
| unit-artifact-web.test.mjs [123] | Artifact-graph schema/runtime plus web-source tooling (domain split) | port-adapted (split: artifact part as-is, web part drop) |
| unit-authoring-interface.test.mjs [73] | Status helpers, formatRun, authoring surfaces | port-as-is (mostly) |
| unit-core-runtime.test.mjs [111] | Retry limits, scheduling, runtime core (domain split) | port-adapted (many tests use fake SubagentApi) |
| unit-dynamic-runtime.test.mjs [143] | Dynamic controller/decision loop runtime (domain split) | port-adapted (fake SubagentApi) |
| unit-engine-store.test.mjs [84] | Fail-fast, store, process roles, launch authority (domain split) | port-adapted (fake SubagentApi, Pi roles) |
| unit-model-task-runtime.test.mjs [6] | maxRuntimeMs semantics, compiler defaults | port-as-is |
| unit-nested-backend-refresh.test.mjs [1] | Nested child refresh under lease | port-adapted (fake SubagentApi) |
| unit-resource-inheritance-compiler.test.mjs [7] | Resource policy resolver/compiler stamps | port-as-is |
| unit-resource-inheritance-recovery.test.mjs [1] | Resource policy recovery | port-as-is |
| unit-resource-inheritance-runtime.test.mjs [5] | Sealed launch skills/tools | port-adapted (launch sealing per executor) |
| unit-resource-inheritance-sdk.test.mjs [1] | Resource policy reaches Pi argv/SDK discovery | port-adapted (executors/pi) |
| unit-split-contract.test.mjs [1] | 540-test inventory preserved across domain split | drop(pi-workflow test bookkeeping) |
| unit-test-cleanup.test.mjs [1] | Global test cleanup drains index work | port-adapted (test harness) |
| unit-unlimited-loop.test.mjs [5] | Unlimited loop semantics | port-as-is |
| unlimited-supervisor.test.mjs [0, table-driven 4] | CLI `supervise` deadline vs unlimited loops | port-adapted (hosts/cli) |
| verification-ontology-parity.test.mjs [2] | TS/mjs ontology twins | port-as-is |
| wb-001-web-provider-compat.test.mjs [14] | Web query classifier/credential detection | drop(workflow_web_* removed in WP10) |
| wb-002-json-path-hardening.test.mjs [2] | Simple JSON path safety | port-as-is |
| wb-002-normalized-web-contract.test.mjs [22] | Normalized web URL/numResults contract | drop(workflow_web_* removed in WP10) |
| wb-003-package-closure.test.mjs [8] | TypeScript package closure for release | port-adapted (release tooling exists in agent-workflow) |
| wb-003-web-security.test.mjs [4] | Web network policy (IPv6, slow drip) | drop(workflow_web_* removed in WP10) |
| wb-004-backend-lifecycle.test.mjs [6] | Backend op timeouts, interrupt rejection | port-adapted (executor lifecycle) |
| wb-005-index-durability.test.mjs [7] | Index visibility/repair | port-as-is |
| wb-006-rate-limit-lock.test.mjs [1] | Cross-process shared model rate-limit backoff | port-adapted (runtime) |
| wb-007-dynamic-recovery.test.mjs [3] | Stale dynamic recovery fails closed | port-as-is |
| wb-008-filesystem-security.test.mjs [5] | Secure atomic writes, symlink swaps | port-as-is |
| wb-009-workflow-policy.test.mjs [10] | Publish workflow/tag policy | drop(pi-workflow release tooling) |
| wb-012-public-contracts.test.mjs [4] | Workflow name resolution; docs mirror help | port-adapted (docs/help differ) |
| wb-014-platform-package.test.mjs [8] | CI package surface on macOS/Linux | drop(pi-workflow package CI) |
| wb-016-scheduler-performance.test.mjs [3] | Scheduler wake at retry deadlines | port-as-is |
| wb-017-artifact-index-performance.test.mjs [4] | Memoized artifact reads | port-as-is |
| wb-018-dynamic-tail-performance.test.mjs [5] | Dynamic ledger append cursor/queue | port-as-is |
| worker-role.test.mjs [2] | Child launches inherit worker role env; no supervisor resume | port-adapted (PI_WORKFLOW_ROLE becomes runtime env) |
| workflow-active-ui.test.mjs [4] | Pi "Active workflows" widget | drop(Pi TUI) |
| workflow-artifact-footprint.test.mjs [9] | Snapshot inodes, dedup of raw output | port-as-is |
| workflow-authoring-corrective.test.mjs [3] | Foreach agent/runtime compile, schema rejects | port-as-is |
| workflow-authoring-gates.test.mjs [7] | Bundle dir resolution, inspect fallbacks | port-as-is |
| workflow-auto-binding.test.mjs [5] | `/workflow auto` binding identity | port-adapted (auto router host-coupled) |
| workflow-auto-negative-boundaries.test.mjs [7] | Auto routing negative cases | port-adapted (router) |
| workflow-command-actions.test.mjs [2] | Slash-command action list vs help | drop(Pi slash command; hosts/pi) |
| workflow-contract-findings-006-008.test.mjs [17] | Bundled spec-review/deep-research batch contracts | port-adapted (WP10) |
| workflow-extension-isolation.test.mjs [1] | Extension isolation sealed at dispatch | port-adapted (executors/pi) |
| workflow-fixture-lifecycle.test.mjs [2] | Fixture lease waits instead of skipping | port-as-is |
| workflow-guide-fixed-inventory.test.mjs [5] | Fixed-inventory initializer for workflow-guide skill | port-adapted (skill) |
| workflow-launch-cancellation.test.mjs [7] | Auto launch cancellation boundaries | port-adapted (fake SubagentApi, extension) |
| workflow-launch-metadata.test.mjs [7] | Launch command artifact privacy/integrity | port-as-is |
| workflow-mtbyqwu0-security.test.mjs [4] | Source-context cap, provider progress bounds, secure writers | port-adapted (provider callback part drop) |
| workflow-native-boundary.test.mjs [2] | Native host launch cannot borrow cwd peer | drop(Pi native host context) |
| workflow-native-cli.test.mjs [1] | Real headless Pi loads native child tools | drop(Pi native host) |
| workflow-native-host.test.mjs [1] | Native MCP/codemode references | drop(Pi native host) / unknown (MCP part may map to WP9) |
| workflow-native-launch.test.mjs [4] | Native default reaches sealed launch argv | drop(Pi native host) |
| workflow-native-prompt-policy.test.mjs [1] | Sealed prompt parity, native vs not | port-adapted (prompt sealing is core; native part drop) |
| workflow-native-session.test.mjs [2] | Native host context per SDK session | drop(Pi native host) |
| workflow-native-tool-policy.test.mjs [6] | Native codemode/MCP tool classification | drop(Pi native host) / unknown |
| workflow-notice-acknowledgements.test.mjs [11] | Notices list/ack/clear | port-adapted (extension command surface) |
| workflow-parent-usage-topology-retry.test.mjs [4] | Parent usage topology retries | drop(Pi parent session usage) / unknown |
| workflow-parent-usage.test.mjs [3] | Parent usage accumulation from assistant messages | drop(Pi parent session usage) |
| workflow-profile-routing-compat.test.mjs [11] | Saved profiles across routing edits | port-adapted (settings location) |
| workflow-profile-tui.test.mjs [14] | Profile selector TUI | drop(Pi TUI) |
| workflow-report-contracts.test.mjs [7] | spec-review renderer dispositions | port-adapted (WP10) |
| workflow-router.test.mjs [31] | `/workflow auto` v2 command capture and routing | port-adapted (router uses one-shot subagent) |
| workflow-user-profiles.test.mjs [27] | profileRole validation, canonical profile slots, TUI parts | port-adapted (TUI parts drop) |
| workflow-view.test.mjs [11] | Workflow board rendering | drop(Pi TUI) / port-adapted if board moves to CLI |
| workflow-wait-tool.test.mjs [37] | workflow_wait boundary, run-file lease | port-adapted (tool becomes host/MCP) |

### Support files (8, not tests)

| File | Role | Tag |
|---|---|---|
| unit-test-support.mjs | Shared harness: HOME isolation, project factories, `setSubagentApiForTests` fakes, exports | port-adapted (fake executor instead of fake SubagentApi) |
| unit-test-inventory.json | 540-test inventory for unit-split-contract | drop(bookkeeping) |
| impact-review-fixtures.mjs | impact-review fixtures | port-adapted (WP10) |
| raw-host-fixture.mjs | Raw host fixture for output tests | port-as-is |
| surface-rpc-harness.mjs | Real Pi RPC harness | drop(Pi RPC) |
| workflow-fixture-lifecycle.mjs | Fixture lease lifecycle helper | port-as-is |
| helpers/workflow-artifact-fixture.mjs | Artifact fixture builder | port-as-is |
| helpers/workflow-native-host-mcp-fixture.mjs | Native host MCP fixture | drop(Pi native host) |

## test/e2e

| File | Covers | Tag |
|---|---|---|
| cases/packed-workflows.mjs | Packed package lists/compiles the 4 bundled workflows and their local refs/agents | port-adapted (WP10 bundled set) |
| cases/packed-durable-barrier-v2.mjs | Packed pi-subagent durable launch barrier v2 release/revoke with a fake `pi` | port-adapted (runtime launch receipts/fencing) |
| cases/packed-web-loader.mjs | Packed web-source loader modes legacy/normalized/mixed | drop(workflow_web_* removed in WP10) |
| run.mjs | E2E driver: pack, isolated install, no-external-actions shims (npm/curl/pi...) | port-adapted |
| forbidden-term-scanner.mjs | Release forbidden-term scan | port-adapted (agent-workflow release checks) |
| no-external-actions-guard.mjs | Process guard that blocks external actions in E2E | port-as-is |
| no-external-actions-command-shim.mjs | Command shim for the guard | port-as-is |

## Counts (140 unit test files)

| Tag | Count |
|---|---|
| port-as-is | 42 |
| port-adapted | 63 |
| drop | 33 |
| unknown | 2 |

Rows with a mixed tag such as `drop / unknown` count under the first tag. Five
more rows carry a secondary `unknown`. All 140 file names were checked against
`git ls-tree b83cc4f test/unit/`.
