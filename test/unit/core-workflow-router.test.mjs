import assert from "node:assert/strict";
import { drainWorkflowFixture } from "../helpers/workflow-fixture-lifecycle.mjs";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { setTaskRuntimeApiForTests as setTaskRuntimeApiForTests } from "../../dist/core/runtime-port.js";
import {
	assertWorkflowAutoResolvedCandidateSafety,
	buildWorkflowAutoCandidates,
	formatWorkflowAutoRecommendation,
	parseWorkflowAutoComparisonOutput,
	recommendWorkflowAuto,
	WORKFLOW_AUTO_COMPARE_CORRELATION_ID,
	WORKFLOW_AUTO_METADATA_BOUNDS,
} from "../../dist/core/workflow-router.js";
import {
	listWorkflowRoutingSpecs,
	resolveWorkflowRef,
	WORKFLOW_ROUTING_CATALOG_BOUNDS,
} from "../../dist/core/workflow-specs.js";
import { loadAgentMetadataByName } from "../../dist/core/agents.js";
import { readIndex, readRunRecord } from "../../dist/core/store.js";
import { parseArtifactGraphWorkflowSpec } from "../../dist/core/artifact-graph-schema.js";

const ROOT = mkdtempSync(join(tmpdir(), "agent-workflow-auto-test-"));
after(() => {
	setTaskRuntimeApiForTests(undefined);
	rmSync(ROOT, {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 100,
	});
});

function project() {
	return mkdtempSync(join(ROOT, "project-"));
}

function writeAgent(
	cwd,
	name = "unit-agent",
	tools = ["read"],
	readOnly = true,
) {
	const dir = join(cwd, ".agent-workflow", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: ${name}\ntools: ${JSON.stringify(tools)}\nreadOnly: ${readOnly}\n---\n# ${name}\n`,
	);
}

function writeAutoOutput(cwd, runId, attemptId, output) {
	const dir = join(
		cwd,
		".agent-workflow",
		"workflows",
		"auto-router-runs",
		runId,
		"attempts",
		attemptId,
	);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "output.log");
	writeFileSync(path, output);
	return path;
}

function writeSpec(cwd, name, overrides = {}) {
	const dir = join(cwd, "workflows", name);
	mkdirSync(dir, { recursive: true });
	const spec = {
		schemaVersion: 1,
		name,
		description: `${name} authored description`,
		routing: {
			useWhen: [`Use ${name} for bounded review.`],
			avoidWhen: ["Avoid when a direct answer is enough."],
			outputs: ["A reviewed report."],
		},
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [
				{
					id: "main",
					type: "single",
					prompt: "Review the task.",
					output: { analysis: { required: true } },
				},
			],
		},
		...overrides,
	};
	writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
	return join(dir, "spec.json");
}

function installBlockingDynamicSubagentApi(cwd, statusGate) {
	const calls = { launches: 0, interrupts: 0 };
	const launches = new Map();
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			calls.launches += 1;
			const runId = `run_dynamic_${calls.launches}`;
			const attemptId = `attempt_dynamic_${calls.launches}`;
			const artifactDir = join(
				cwd,
				String(options.runsDir ?? ".agent-workflow/runs"),
				runId,
				"attempts",
				attemptId,
			);
			mkdirSync(artifactDir, { recursive: true });
			writeFileSync(join(artifactDir, "output.log"), "");
			writeFileSync(join(artifactDir, "stderr.log"), "");
			writeFileSync(
				join(artifactDir, "result.json"),
				JSON.stringify({ status: "running" }),
			);
			launches.set(runId, { runId, attemptId, artifactDir });
			return { runId, attemptId, status: "running" };
		},
		async reconcileSubagentRun() {
			return {};
		},
		async getSubagentStatus({ runId }) {
			const launch = launches.get(runId);
			assert.ok(launch, `missing dynamic subagent run ${runId}`);
			await statusGate;
			return {
				runId,
				attemptId: launch.attemptId,
				backend: "headless",
				status: "running",
				failureKind: null,
				startedAt: new Date(Date.now() - 1_000).toISOString(),
				completedAt: new Date().toISOString(),
				logs: [
					{
						type: "output",
						path: "output.log",
						artifactCwd: launch.artifactDir,
					},
					{
						type: "stderr",
						path: "stderr.log",
						artifactCwd: launch.artifactDir,
					},
					{
						type: "result",
						path: "result.json",
						artifactCwd: launch.artifactDir,
					},
				],
				metadata: { contextLengthExceeded: false },
				attempts: [{ attemptId: launch.attemptId, status: "running" }],
			};
		},
		async interruptSubagent({ runId, attemptId }) {
			calls.interrupts += 1;
			return {
				status: "already-terminal",
				runId,
				interruptedAttempts: [],
				unsupportedAttempts: [],
				record: { attempts: [{ attemptId, status: "cancelled" }] },
			};
		},
	});
	return calls;
}

function validComparison(
	cards,
	selected = cards.find((card) => card.readiness?.startAllowed) ?? cards[0],
) {
	return JSON.stringify({
		status: "recommendation",
		recommendation: {
			candidateId: selected.candidateId,
			confidence: "high",
			reason: "The supplied metadata fits the task.",
			alternatives: cards
				.filter((card) => card.candidateId !== selected.candidateId)
				.slice(0, 1)
				.map((card) => card.candidateId),
		},
		assessments: cards.map((card) => ({
			candidateId: card.candidateId,
			fit: card === selected ? "complete" : "partial",
			reason: "Compared only supplied fields.",
			evidence: ["task", "routing.useWhen"],
		})),
		questions: [],
		unknowns: [],
	});
}

// Moved (WP38b, `/aw auto` (WP32)): test("auto v2 command capture preserves the supplied slash arguments exactly once") → test/unit/host-wp38b-auto-router.test.mjs.

// Moved (WP11a, host API parsers): test("explicit run and dynamic reject retired routing flags while preserving quoted task text") → test/unit/host-ported-cli-args.test.mjs.

test("routing hints are schema-validated, bounded, and author-controlled", () => {
	const base = {
		schemaVersion: 1,
		routing: {
			useWhen: ["Use for review."],
			avoidWhen: [],
			outputs: ["Report."],
		},
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Review." }],
		},
	};
	assert.deepEqual(parseArtifactGraphWorkflowSpec(base).routing?.useWhen, [
		"Use for review.",
	]);
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...base,
				routing: { useWhen: ["x".repeat(481)] },
			}),
		/480 UTF-8 bytes/,
	);
	assert.throws(
		() =>
			parseArtifactGraphWorkflowSpec({
				...base,
				routing: { arbitraryPrompt: ["no"] },
			}),
		/unknown field/,
	);
});

test("routing catalog uses normal workflow roots, validates metadata, and records partial/invalid entries", async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "review-a");
	const bad = join(cwd, "workflows", "bad");
	mkdirSync(bad, { recursive: true });
	writeFileSync(join(bad, "spec.json"), "{ not json");
	const catalog = await listWorkflowRoutingSpecs(cwd);
	const candidate = catalog.records.find(
		(record) => record.name === "review-a",
	);
	assert.ok(candidate);
	assert.equal(candidate.scope, "project-shared");
	assert.deepEqual(candidate.spec.routing?.outputs, ["A reviewed report."]);
	assert.equal(
		catalog.partial,
		true,
		"invalid catalog entries must not be claimed unfit",
	);
	assert.ok(
		catalog.issues.some((issue) => issue.specPath?.endsWith("bad/spec.json")),
	);
});

test("routing catalog marks an exact candidate cap partial before lower-priority roots are scanned", async () => {
	const cwd = project();
	writeAgent(cwd);
	for (let index = 0; index < 48; index += 1)
		writeSpec(cwd, `cap-${String(index).padStart(2, "0")}`);
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(
		catalog.records.filter((record) => record.scope === "project-shared")
			.length,
		48,
	);
	assert.equal(catalog.partial, true);
	assert.ok(
		catalog.issues.some((issue) =>
			/candidate limit 48 reached/.test(issue.reason),
		),
	);
});

test("routing catalog stops at its aggregate byte budget without partially reading another spec", async () => {
	const cwd = project();
	writeAgent(cwd);
	for (let index = 0; index < 9; index += 1)
		writeSpec(cwd, `aggregate-${index}`, { description: "x".repeat(60_000) });
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(catalog.partial, true);
	assert.ok(
		catalog.issues.some((issue) =>
			/aggregate UTF-8 limit 524288 reached/.test(issue.reason),
		),
	);
	assert.ok(catalog.records.length < 9);
});

test("routing catalog bounds deeply nested root metadata before schema parsing", async () => {
	const cwd = project();
	mkdirSync(join(cwd, "workflows"), { recursive: true });
	let deeplyNested = { value: "x" };
	for (
		let index = 0;
		index < WORKFLOW_ROUTING_CATALOG_BOUNDS.maxJsonDepth + 2;
		index += 1
	)
		deeplyNested = { nested: deeplyNested };
	writeFileSync(
		join(cwd, "workflows", "deep-root.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "deep-root",
			defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Review." }],
			},
			metadataProbe: deeplyNested,
		}),
	);
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(
		catalog.records.some((record) => record.name === "deep-root"),
		false,
	);
	assert.ok(
		catalog.issues.some((issue) => /JSON depth limit/.test(issue.reason)),
	);
});

test("routing catalog keeps the resolver's higher-priority alias winner without false ambiguity", async () => {
	const cwd = project();
	writeAgent(cwd);
	const spec = (name) => ({
		schemaVersion: 1,
		name,
		defaults: { agent: "unit-agent", readOnly: true, tools: ["read"] },
		artifactGraph: {
			stages: [{ id: "main", type: "single", prompt: "Review." }],
		},
	});
	mkdirSync(join(cwd, "workflows"), { recursive: true });
	writeFileSync(
		join(cwd, "workflows", "alias-collision.json"),
		JSON.stringify(spec("shared-alias-winner")),
	);
	const lower = join(cwd, ".agent-workflow", "workflows", "alias-collision");
	mkdirSync(lower, { recursive: true });
	writeFileSync(
		join(lower, "spec.json"),
		JSON.stringify(spec("private-loser")),
	);
	const catalog = await listWorkflowRoutingSpecs(cwd);
	const winners = catalog.records.filter((record) =>
		record.aliases.includes("alias-collision"),
	);
	assert.equal(winners.length, 1);
	assert.equal(winners[0]?.scope, "project-shared");
	assert.deepEqual(winners[0]?.ambiguousAliases, []);
	const resolved = await resolveWorkflowRef("alias-collision", cwd);
	assert.equal(
		resolved.specPath,
		join(cwd, "workflows", "alias-collision.json"),
	);

	writeFileSync(
		join(cwd, "workflows", "same-priority.json"),
		JSON.stringify(spec("same-priority-flat")),
	);
	const samePriorityBundle = join(cwd, "workflows", "same-priority");
	mkdirSync(samePriorityBundle, { recursive: true });
	writeFileSync(
		join(samePriorityBundle, "spec.json"),
		JSON.stringify(spec("same-priority-bundle")),
	);
	const ambiguousCatalog = await listWorkflowRoutingSpecs(cwd);
	const ties = ambiguousCatalog.records.filter((record) =>
		record.aliases.includes("same-priority"),
	);
	assert.equal(ties.length, 2);
	assert.ok(
		ties.some((record) => record.ambiguousAliases.includes("same-priority")),
		"the bundle-only representative has no unambiguous launch alias",
	);
	assert.ok(
		ties.some(
			(record) =>
				record.ambiguousAliases.length === 0 &&
				record.aliases.includes("same-priority.json"),
		),
		"the flat representative remains launchable only through its unique .json alias",
	);
	await assert.rejects(
		() => resolveWorkflowRef("same-priority", cwd),
		/ambiguous workflow name/,
	);
});

test("routing catalog rejects a discovered bundle spec symlink that escapes its root", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = project();
	writeAgent(cwd);
	const outside = project();
	const outsideSpec = writeSpec(outside, "escaped-review");
	const unsafeBundle = join(cwd, "workflows", "unsafe-link");
	mkdirSync(unsafeBundle, { recursive: true });
	symlinkSync(outsideSpec, join(unsafeBundle, "spec.json"));
	const catalog = await listWorkflowRoutingSpecs(cwd);
	assert.equal(
		catalog.records.some((record) => record.name === "unsafe-link"),
		false,
	);
	assert.equal(catalog.partial, true);
	assert.ok(
		catalog.issues.some((issue) => /non-symlink spec file/.test(issue.reason)),
	);
});

test("routing agent metadata resolves a bounded frontmatter alias without reading its body", async () => {
	const cwd = project();
	const agents = join(cwd, ".agent-workflow", "agents");
	mkdirSync(agents, { recursive: true });
	const frontmatter =
		"---\nname: routing-alias\ndescription: bounded\ntools: [read]\nreadOnly: true\n---\n";
	const body = "AGENT_BODY_MUST_NOT_BE_READ\n".repeat(1_000);
	writeFileSync(
		join(agents, "different-file-name.md"),
		`${frontmatter}${body}`,
	);
	const metadata = await loadAgentMetadataByName("routing-alias", cwd);
	assert.equal(metadata?.agent.name, "routing-alias");
	assert.equal(metadata?.agent.body, "");
	assert.equal(metadata?.bytes, Buffer.byteLength(frontmatter));
	assert.ok(
		(metadata?.bytes ?? 0) < Buffer.byteLength(`${frontmatter}${body}`),
	);
	writeFileSync(join(agents, "plain-body.md"), "NOT_FRONTMATTER".repeat(2_000));
	const plain = await loadAgentMetadataByName("plain-body", cwd);
	assert.equal(plain?.agent.body, "");
	assert.equal(
		plain?.bytes,
		3,
		"a non-frontmatter body is rejected once its opening delimiter is impossible",
	);
});

test("candidate construction offers workflows only and blocks unsafe or unresolved paths", async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "read-only-review");
	const catalog = await listWorkflowRoutingSpecs(cwd);
	const candidates = buildWorkflowAutoCandidates(
		catalog,
		{
			noWorkflow: false,
			noSubagent: false,
			noNetwork: false,
			explicitNoExternalModel: false,
			ambiguousTransmission: false,
			requiresWrite: true,
			readOnlyOnly: false,
		},
		["unit-agent"],
	);
	const direct = candidates.find((candidate) => candidate.kind === "direct");
	const dynamic = candidates.find(
		(candidate) => candidate.kind === "direct-dynamic",
	);
	const named = candidates.find(
		(candidate) => candidate.label === "read-only-review",
	);
	assert.equal(direct, undefined);
	assert.ok(
		candidates.every((candidate) =>
			["named-workflow", "direct-dynamic"].includes(candidate.kind),
		),
	);
	assert.equal(dynamic?.readiness.status, "blocked");
	assert.match(dynamic?.readiness.blockers.join(" ") ?? "", /researcher/);
	assert.equal(named?.readiness.status, "blocked");
	assert.match(named?.readiness.blockers.join(" ") ?? "", /patch or edit/i);
});

test("auto comparison sends bounded metadata once, has no tools, and never launches a candidate itself", async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "review-b");
	let calls = 0;
	let packet;
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			assert.equal(options.correlationId, WORKFLOW_AUTO_COMPARE_CORRELATION_ID);
			assert.deepEqual(options.tools, []);
			calls += 1;
			packet = JSON.parse(options.task);
			const output = validComparison(packet.candidateCards);
			const runId = `auto-${calls}`;
			const attemptId = `attempt-${calls}`;
			const path = writeAutoOutput(cwd, runId, attemptId, output);
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review the supplied implementation.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(calls, 1);
	assert.equal(result.status, "recommendation");
	assert.equal(
		result.comparison?.recommendation?.candidateId,
		packet.candidateCards.find((card) => card.readiness.startAllowed)
			.candidateId,
	);
	assert.ok(packet.candidateCards.every((card) => card.kind !== "direct"));
	assert.match(packet.responseContract.assessments, /non-empty evidenceFields/);
	assert.equal(
		JSON.stringify(packet).includes(cwd),
		false,
		"private local path must not be classifier input",
	);
	const reviewCard = packet.candidateCards.find(
		(card) => card.label === "review-b",
	);
	assert.equal(
		reviewCard?.comparison.description,
		"review-b authored description",
		"bounded authored descriptions are untrusted comparison data",
	);
	assert.ok(reviewCard);
});

test("auto derives mutation-capable bash facts despite an authored readOnly declaration", async () => {
	const cwd = project();
	writeAgent(cwd, "unit-agent", ["bash"], true);
	writeSpec(cwd, "unsafe-effective-tools", {
		defaults: { agent: "unit-agent", readOnly: true, tools: ["bash"] },
	});
	let calls = 0;
	setTaskRuntimeApiForTests({
		async runSubagent() {
			calls += 1;
			throw new Error("offline candidate gating must not invoke a classifier");
		},
	});
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Perform a read-only review with no changes.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(calls, 1);
	assert.equal(result.transmission, "allowed");
	const card = result.candidates.find(
		(candidate) => candidate.label === "unsafe-effective-tools",
	);
	// WP12d-1 (review #1): a readOnly stage with no read-only tool is refused at compile, so the
	// candidate has no effective facts and stays blocked (it was mutation-capable before).
	assert.equal(card?.facts.effective, undefined);
	assert.ok(
		card?.readiness.cautions.some((c) => /metadata validation/.test(c)),
	);
	assert.equal(card?.readiness.startAllowed, false);
	assert.equal(card?.readiness.status, "blocked");
	assert.match(
		card?.readiness.blockers.join(" ") ?? "",
		/mixed or unknown write posture/i,
	);
});

test("auto derives inherited bash and unknown custom tools before local safety-boundary choices", async () => {
	const cwd = project();
	writeAgent(cwd, "inherited-bash", ["bash"], true);
	writeAgent(cwd, "unknown-custom", ["custom_capability"], true);
	writeSpec(cwd, "inherits-bash", {
		defaults: { agent: "inherited-bash", readOnly: true },
	});
	writeSpec(cwd, "unknown-custom-tool", {
		defaults: { agent: "unknown-custom", readOnly: true },
	});
	let calls = 0;
	setTaskRuntimeApiForTests({
		async runSubagent() {
			calls += 1;
			throw new Error(
				"explicit local safety constraints must not invoke a classifier",
			);
		},
	});
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Do a read-only review with no changes.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["inherited-bash", "unknown-custom"],
	});
	assert.equal(calls, 1);
	// WP12d-1 (review #1): the bash stage keeps no read-only tool and is refused at compile (no
	// effective facts; was mutation-capable/network). 2026-11-02: a readOnly stage keeps an unknown
	// tool (dropping it would run the stage without it), so that card has unknown facts. Both blocked.
	const card = (label) =>
		result.candidates.find((candidate) => candidate.label === label);
	assert.equal(card("inherits-bash")?.facts.effective, undefined);
	assert.deepEqual(card("unknown-custom-tool")?.facts.effective, {
		capability: "unknown",
		network: "unknown",
		unknownTools: ["custom_capability"],
	});
	for (const label of ["inherits-bash", "unknown-custom-tool"]) {
		assert.equal(card(label)?.readiness.startAllowed, false, label);
		assert.equal(card(label)?.readiness.status, "blocked", label);
	}
});

test("auto rejects removed provider metadata before comparison", async () => {
	const cwd = project();
	writeAgent(cwd);
	const root = join(cwd, "workflows", "nested-provider");
	writeSpec(cwd, "nested-provider", {
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: {
						uses: "./controller.mjs",
						workflows: { child: { uses: "./nested/spec.json" } },
					},
				},
			],
		},
	});
	mkdirSync(join(root, "nested"), { recursive: true });
	writeFileSync(
		join(root, "controller.mjs"),
		"export default () => ({ control: {} });\n",
	);
	writeFileSync(
		join(root, "nested", "spec.json"),
		JSON.stringify({
			schemaVersion: 1,
			name: "nested-child",
			defaults: {
				agent: "unit-agent",
				readOnly: true,
				tools: [
					{
						name: "read",
						extensions: ["unfrozen-provider-extension"],
					},
				],
			},
			artifactGraph: {
				stages: [{ id: "main", type: "single", prompt: "Review." }],
			},
		}),
	);
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review nested provider metadata.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	const card = result.candidates.find(
		(candidate) => candidate.label === "nested-provider",
	);
	assert.equal(card?.readiness.startAllowed, false);
	assert.equal(card?.readiness.status, "needs-check");
});

test("auto comparison does not traverse helper import closures before a path is selected", async () => {
	const cwd = project();
	writeAgent(cwd);
	const root = join(cwd, "workflows", "metadata-only-helper");
	writeSpec(cwd, "metadata-only-helper", {
		artifactGraph: {
			stages: [
				{
					id: "adaptive",
					type: "dynamic",
					dynamic: { uses: "./controller.mjs" },
				},
			],
		},
	});
	// A selected-launch bundle bind will own this malformed import closure. If
	// recommendation traversed source, the directory import would already fail.
	writeFileSync(
		join(root, "controller.mjs"),
		'// HELPER_SOURCE_MUST_NOT_REACH_COMPARISON\nimport "./source-closure.mjs";\nexport default () => ({ control: {} });\n',
	);
	mkdirSync(join(root, "source-closure.mjs"));
	let packetText = "";
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			packetText = options.task;
			const packet = JSON.parse(options.task);
			const runId = "metadata-only-auto";
			const attemptId = "metadata-only-attempt";
			const path = writeAutoOutput(
				cwd,
				runId,
				attemptId,
				validComparison(packet.candidateCards),
			);
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review the bounded workflow metadata.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	const card = result.candidates.find(
		(candidate) => candidate.label === "metadata-only-helper",
	);
	assert.equal(card?.readiness.startAllowed, true);
	assert.ok(
		result.shortlist.some((candidate) => candidate.kind === "direct-dynamic"),
		"bounded metadata inspection retains the built-in dynamic choice",
	);
	assert.ok(
		result.shortlist.some(
			(candidate) =>
				candidate.kind === "named-workflow" && candidate.readiness.startAllowed,
		),
		"bounded metadata inspection retains a named workflow choice",
	);
	assert.equal(
		packetText.includes("HELPER_SOURCE_MUST_NOT_REACH_COMPARISON"),
		false,
	);
});

test("auto marks oversized and deeply nested declarative metadata as needs-check", async () => {
	const cwd = project();
	writeAgent(cwd);
	const oversizedRoot = join(cwd, "workflows", "oversized-routing-schema");
	writeSpec(cwd, "oversized-routing-schema", {
		artifactGraph: {
			stages: [
				{
					id: "main",
					type: "single",
					prompt: "Review.",
					output: { controlSchema: "./large.schema.json" },
				},
			],
		},
	});
	writeFileSync(
		join(oversizedRoot, "large.schema.json"),
		"x".repeat(WORKFLOW_AUTO_METADATA_BOUNDS.maxMetadataBytesPerFile + 1),
	);
	const deepRoot = join(cwd, "workflows", "deep-routing-schema");
	writeSpec(cwd, "deep-routing-schema", {
		artifactGraph: {
			stages: [
				{
					id: "main",
					type: "single",
					prompt: "Review.",
					output: { controlSchema: "./deep.schema.json" },
				},
			],
		},
	});
	let deep = { type: "string" };
	for (
		let index = 0;
		index < WORKFLOW_AUTO_METADATA_BOUNDS.maxJsonDepth + 2;
		index += 1
	)
		deep = { nested: deep };
	writeFileSync(join(deepRoot, "deep.schema.json"), JSON.stringify(deep));
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review bounded declarative metadata.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	for (const label of ["oversized-routing-schema", "deep-routing-schema"]) {
		const card = result.candidates.find(
			(candidate) => candidate.label === label,
		);
		assert.equal(card?.readiness.status, "needs-check", label);
		assert.equal(card?.readiness.startAllowed, false, label);
		assert.match(
			card?.readiness.cautions.join(" ") ?? "",
			/bounded workflow metadata/i,
		);
	}
});

test("auto revalidates resolved profile/runtime tools against explicit safety constraints", () => {
	const candidate = {
		kind: "named-workflow",
		facts: {
			stageCount: 1,
			stageTypes: ["single"],
			agents: ["unit-agent"],
			tools: ["read"],
			readOnly: true,
			hasSupport: false,
			hasDynamic: false,
			requiresApproval: false,
			usesNetwork: false,
			effective: {
				capability: "read-only",
				network: "local",
				unknownTools: [],
			},
		},
		readiness: {
			status: "ready",
			startAllowed: true,
			blockers: [],
			cautions: [],
		},
	};
	assert.throws(
		() =>
			assertWorkflowAutoResolvedCandidateSafety(
				candidate,
				{
					tasks: [
						{
							kind: "single",
							agent: "unit-agent",
							runtime: { tools: ["bash"] },
							safety: { capability: "mutation-capable" },
						},
					],
				},
				"Perform a read-only offline review with no network and no changes.",
			),
		/resolved profile\/runtime capability is incompatible/,
	);
	assert.doesNotThrow(() =>
		assertWorkflowAutoResolvedCandidateSafety(
			candidate,
			{
				tasks: [
					{
						kind: "single",
						agent: "unit-agent",
						runtime: {
							tools: ["read"],
							toolProviders: {
								read: {
									classification: "read-only",
								},
							},
						},
						safety: { capability: "read-only" },
					},
				],
			},
			"Perform a read-only review with no changes.",
		),
	);
});

test("auto comparison reads only its bounded canonical output artifact", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "bounded-output");
	const cases = ["escaped", "oversized", "symlink", "invalid-utf8"];
	let index = 0;
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			const packet = JSON.parse(options.task);
			const kind = cases[index++];
			assert.ok(kind);
			const runId = `bounded-${kind}`;
			const attemptId = "attempt";
			let path;
			if (kind === "escaped") {
				path = join(cwd, "outside-output.log");
				writeFileSync(path, validComparison(packet.candidateCards));
			} else {
				const output =
					kind === "oversized"
						? "x".repeat(65_537)
						: kind === "invalid-utf8"
							? (() => {
									const bytes = Buffer.from(
										validComparison(packet.candidateCards),
										"utf8",
									);
									const marker = bytes.indexOf(Buffer.from("Compared", "utf8"));
									assert.ok(marker >= 0);
									bytes[marker] = 0xc3; // invalid leading UTF-8 byte before ASCII
									return bytes;
								})()
							: validComparison(packet.candidateCards);
				path = writeAutoOutput(cwd, runId, attemptId, output);
				if (kind === "symlink") {
					const target = `${path}.target`;
					writeFileSync(target, validComparison(packet.candidateCards));
					unlinkSync(path);
					symlinkSync(target, path);
				}
			}
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
	for (const _case of cases) {
		const result = await recommendWorkflowAuto({
			executor: "pi",
			cwd,
			task: "Review this bounded output.",
			transmissionPolicy: "allowed",
			availableAgentNames: ["unit-agent"],
		});
		assert.equal(result.status, "routing-unavailable");
	}
});

test("auto comparison accepts a valid multibyte UTF-8 artifact", async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "utf8-output");
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			const packet = JSON.parse(options.task);
			const response = JSON.parse(validComparison(packet.candidateCards));
			response.recommendation.reason = "Résumé verified 🚀";
			response.assessments[0].reason = "Multibyte control: café";
			const runId = "utf8-output";
			const attemptId = "utf8-output";
			const path = writeAutoOutput(
				cwd,
				runId,
				attemptId,
				JSON.stringify(response),
			);
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
	const result = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review valid UTF-8 output.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(result.status, "recommendation");
});

// Moved (WP38b, `/aw auto` (WP32)): test("headless /workflow auto fails closed without structured transmission authorization") → test/unit/host-wp38b-auto-router.test.mjs.

// Moved (WP38b, `/aw auto` (WP32)): test("TUI cancellation keeps a Korean no-transmit task out of the classifier") → test/unit/host-wp38b-auto-router.test.mjs.

// Moved (WP38b, `/aw auto` (WP32)): test("TUI keeps safe choices after no-fit without metadata noise or routing jargon") → test/unit/host-wp38b-auto-router.test.mjs.

for (const task of [
	"Do not send this to any external model.",
	"Do not write to disk; do not use the network.",
]) {
	// Moved (WP38b, `/aw auto` (WP32)): test("TUI offers only cancellation under a transmission restriction: ${task}") → test/unit/host-wp38b-auto-router.test.mjs.
}

// Moved (WP38b, `/aw auto` (WP32)): test("TUI confirms an unranked named manual fallback with null v2 provenance") → test/unit/host-wp38b-auto-router.test.mjs.

test("structured transmission policy fails closed across languages and preserves detected denials", async () => {
	const cwd = project();
	writeAgent(cwd);
	writeSpec(cwd, "review-c");
	let calls = 0;
	setTaskRuntimeApiForTests({
		async runSubagent(options) {
			calls += 1;
			const packet = JSON.parse(options.task);
			const output = JSON.stringify({
				status: "recommendation",
				recommendation: {
					candidateId: "f".repeat(64),
					confidence: "high",
					reason: "invented",
					alternatives: [],
				},
				assessments: packet.candidateCards.map((card) => ({
					candidateId: card.candidateId,
					fit: "partial",
					reason: "x",
					evidence: ["task"],
				})),
				questions: [],
				unknowns: [],
			});
			const runId = "invalid";
			const attemptId = "invalid";
			const path = writeAutoOutput(cwd, runId, attemptId, output);
			return {
				runId,
				attemptId,
				status: "completed",
				cwd,
				artifacts: [{ type: "output", path }],
			};
		},
	});
	const invalid = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "review",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(invalid.status, "routing-unavailable");
	assert.equal(calls, 1);

	const unrecognizedWithoutPolicy = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "გთხოვთ გადახედოთ ამ ცვლილებას.",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(unrecognizedWithoutPolicy.transmission, "needs-clarification");
	assert.match(unrecognizedWithoutPolicy.reason ?? "", /not authorized/);
	assert.equal(calls, 1);

	const invalidPolicy = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Review with an invalid runtime policy.",
		transmissionPolicy: "permit",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(invalidPolicy.transmission, "needs-clarification");
	assert.equal(calls, 1);

	const koreanProhibition = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "이 작업을 외부 모델로 보내지 마세요.",
		transmissionPolicy: "blocked",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(koreanProhibition.transmission, "blocked");
	assert.equal(calls, 1);

	const explicitlyAuthorized = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "გთხოვთ გადახედოთ ამ ცვლილებას.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(explicitlyAuthorized.transmission, "allowed");
	assert.equal(calls, 2);

	const blocked = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Do not send this task to any external model.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(blocked.status, "routing-unavailable");
	assert.equal(blocked.transmission, "blocked");
	const notTransmitted = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Do not transmit this task outside this machine.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(notTransmitted.transmission, "blocked");
	const cannotOverrideTaskPrivacy = await recommendWorkflowAuto({
		executor: "pi",
		cwd,
		task: "Keep my data local only; do not transmit it.",
		transmissionPolicy: "allowed",
		availableAgentNames: ["unit-agent"],
	});
	assert.equal(cannotOverrideTaskPrivacy.transmission, "blocked");
	assert.equal(calls, 2);
});

test("formatted recommendations never interpolate model prose or the original task into generic output", () => {
	const candidate = {
		candidateId: "a".repeat(64),
		identitySha256: "b".repeat(64),
		kind: "named-workflow",
		label: "safe-review",
		scope: "project-shared",
		description: "safe",
		routing: { useWhen: [], avoidWhen: [], outputs: [] },
		facts: {
			stageCount: 1,
			stageTypes: ["single"],
			agents: [],
			tools: [],
			readOnly: true,
			hasSupport: false,
			hasDynamic: false,
			requiresApproval: false,
			usesNetwork: false,
		},
		readiness: {
			status: "ready",
			startAllowed: true,
			blockers: [],
			cautions: [],
		},
		launchRef: "safe-review",
		comparison: {
			description: "Bounded authored description.",
			purpose: "Bounded authored purpose.",
			declaredOutputs: ["review report"],
			declaredSchemas: ["stage main: control schema declared"],
			declaredVerification: ["stage main: references are required"],
			overhead: {
				stages: 1,
				executionStages: 1,
				foreachStages: 0,
				loopStages: 0,
				dynamic: false,
				support: false,
			},
			unknowns: ["No declared output or helper schema."],
		},
	};
	const text = formatWorkflowAutoRecommendation({
		status: "recommendation",
		catalog: { records: [], totalDiscovered: 0, partial: false, issues: [] },
		candidates: [candidate],
		shortlist: [candidate],
		transmission: "allowed",
		comparison: {
			status: "recommendation",
			recommendation: {
				candidateId: candidate.candidateId,
				confidence: "high",
				reason: "SECRET ORIGINAL TASK",
				alternatives: [],
			},
			assessments: [],
			questions: ["SECRET ORIGINAL TASK"],
			unknowns: ["SECRET ORIGINAL TASK"],
		},
	});
	assert.equal(text.includes("SECRET ORIGINAL TASK"), false);
	assert.match(text, /<original task>/);
	assert.match(text, /Description: Bounded authored description\./);
	assert.match(text, /Declared schemas: stage main: control schema declared/);
	assert.match(text, /Overhead proxy: 1 execution stage/);
});

test("generic auto formatting neutralizes untrusted display metadata and unsafe command refs", () => {
	const candidate = {
		candidateId: "a".repeat(64),
		identitySha256: "b".repeat(64),
		kind: "named-workflow",
		label: "review\n\u001b[2J",
		scope: "project\nshared",
		description: "safe",
		routing: { useWhen: [], avoidWhen: [], outputs: [] },
		facts: {
			stageCount: 1,
			stageTypes: ["single"],
			agents: [],
			tools: [],
			readOnly: true,
			hasSupport: false,
			hasDynamic: false,
			requiresApproval: false,
			usesNetwork: false,
		},
		readiness: {
			status: "blocked",
			startAllowed: false,
			blockers: ["missing\nagent"],
			cautions: [],
		},
		launchRef: 'unsafe"; /workflow dynamic "x',
	};
	const text = formatWorkflowAutoRecommendation({
		status: "routing-unavailable",
		catalog: { records: [], totalDiscovered: 0, partial: false, issues: [] },
		candidates: [candidate],
		shortlist: [candidate],
		transmission: "blocked",
	});
	assert.equal(text.includes("\u001b"), false);
	assert.equal(text.includes("\nagent"), false);
	assert.equal(text.includes("project\nshared"), false);
	assert.equal(text.includes("/workflow run unsafe"), false);
	const blockedSafeRef = formatWorkflowAutoRecommendation({
		status: "routing-unavailable",
		catalog: { records: [], totalDiscovered: 0, partial: false, issues: [] },
		candidates: [{ ...candidate, launchRef: "safe-review" }],
		shortlist: [{ ...candidate, launchRef: "safe-review" }],
		transmission: "blocked",
	});
	assert.equal(blockedSafeRef.includes("/workflow run safe-review"), false);
});

test("strict output parser requires an assessment for every candidate and uses only supplied evidence fields", () => {
	const cards = [
		{
			candidateId: "a".repeat(64),
			readiness: { startAllowed: true, status: "ready" },
		},
	];
	assert.equal(
		parseWorkflowAutoComparisonOutput(validComparison(cards), cards)?.status,
		"recommendation",
	);
	const invalidEvidence = JSON.stringify({
		status: "needs-clarification",
		recommendation: undefined,
		assessments: [
			{
				candidateId: "a".repeat(64),
				fit: "partial",
				reason: "x",
				evidence: ["invented.path"],
			},
		],
		questions: ["What scope?"],
		unknowns: [],
	});
	assert.equal(
		parseWorkflowAutoComparisonOutput(invalidEvidence, cards),
		undefined,
	);
	const comparisonEvidence = JSON.stringify({
		status: "needs-clarification",
		assessments: [
			{
				candidateId: "a".repeat(64),
				fit: "partial",
				reason:
					"The supplied bounded description leaves a key constraint open.",
				evidence: ["comparison.description", "comparison.declaredSchemas"],
			},
		],
		questions: ["What output is required?"],
		unknowns: [],
	});
	assert.equal(
		parseWorkflowAutoComparisonOutput(comparisonEvidence, cards)?.status,
		"needs-clarification",
	);
	const ungrounded = JSON.stringify({
		status: "needs-clarification",
		assessments: [
			{
				candidateId: "a".repeat(64),
				fit: "partial",
				reason: "x",
				evidence: [],
			},
		],
		questions: ["What scope?"],
		unknowns: [],
	});
	assert.equal(parseWorkflowAutoComparisonOutput(ungrounded, cards), undefined);
	const contradictoryRecommendation = JSON.stringify({
		status: "recommendation",
		recommendation: {
			candidateId: "a".repeat(64),
			confidence: "high",
			reason: "x",
			alternatives: [],
		},
		assessments: [
			{
				candidateId: "a".repeat(64),
				fit: "not-fit",
				reason: "x",
				evidence: ["task"],
			},
		],
		questions: [],
		unknowns: [],
	});
	assert.equal(
		parseWorkflowAutoComparisonOutput(contradictoryRecommendation, cards),
		undefined,
	);
});

// WP39b O3: gpt-5.6-luna (live bundle 5, Codex ×2 and Pi ×1) named flattened sub-fields of a card's
// nested objects as evidence (`facts.tools`, `facts.usesNetwork`, `readiness.status`, an unprefixed
// `declaredVerification`). The parser normalizes them to the offered evidence fields and validates
// as before; an evidence path that names nothing on the card stays invalid.
test("recorded luna classifier outputs with flattened evidence fields parse after normalization", async () => {
	const { readFile, readdir } = await import("node:fs/promises");
	const dir = new URL("../fixtures/live5/auto-router/", import.meta.url);
	const files = (await readdir(dir)).filter((name) =>
		name.endsWith(".output.log"),
	);
	assert.equal(files.length, 3);
	for (const name of files) {
		const text = await readFile(new URL(name, dir), "utf8");
		const raw = JSON.parse(text);
		const cards = raw.assessments.map((assessment) => ({
			candidateId: assessment.candidateId,
			readiness: { startAllowed: true, status: "ready" },
		}));
		const parsed = parseWorkflowAutoComparisonOutput(text, cards);
		assert.equal(parsed?.status, "recommendation", name);
		assert.equal(
			parsed.recommendation.candidateId,
			raw.recommendation.candidateId,
		);
		const offered = new Set([
			"task",
			"routing.useWhen",
			"routing.avoidWhen",
			"routing.outputs",
			"facts",
			"comparison.description",
			"comparison.purpose",
			"comparison.declaredOutputs",
			"comparison.declaredSchemas",
			"comparison.declaredVerification",
			"comparison.overhead",
			"comparison.unknowns",
			"readiness",
		]);
		for (const assessment of parsed.assessments) {
			assert.ok(assessment.evidence.length > 0);
			assert.equal(
				new Set(assessment.evidence).size,
				assessment.evidence.length,
				"normalized evidence is deduplicated",
			);
			for (const field of assessment.evidence)
				assert.ok(offered.has(field), `${name}: ${field}`);
		}
	}
	const one = [
		{
			candidateId: "a".repeat(64),
			readiness: { startAllowed: true, status: "ready" },
		},
	];
	const withEvidence = (evidence) =>
		JSON.stringify({
			status: "needs-clarification",
			assessments: [
				{ candidateId: "a".repeat(64), fit: "partial", reason: "x", evidence },
			],
			questions: ["What scope?"],
			unknowns: [],
		});
	assert.deepEqual(
		parseWorkflowAutoComparisonOutput(
			withEvidence([
				"facts.tools",
				"facts.usesNetwork",
				"facts.effective.network",
				"readiness.startAllowed",
				"comparison.overhead.stages",
				"declaredVerification",
			]),
			one,
		)?.assessments[0].evidence,
		[
			"facts",
			"readiness",
			"comparison.overhead",
			"comparison.declaredVerification",
		],
	);
	for (const invalid of [
		["facts.invented"],
		["readiness.nope"],
		["invented.path"],
		["routing.useWhen.0"],
		["comparison"],
		["overhead.stages"],
	])
		assert.equal(
			parseWorkflowAutoComparisonOutput(withEvidence(invalid), one),
			undefined,
			invalid.join(),
		);
});
