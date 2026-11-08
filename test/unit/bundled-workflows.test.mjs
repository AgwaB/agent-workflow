// New in agent-workflow (WP10): the bundled workflows, skills and agents after the migration
// (docs/usage.md#bundled-workflows): they validate and compile, carry no Pi-only references, the
// deep-research report states that source verification is model-reported, and the committed
// per-executor support table matches the offline negotiation.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { parseWorkflow } from "../../dist/core/schema.js";
import {
	BUNDLED_SPEC_FILES,
	computeBundledSupportRows,
	readCommittedSupportTable,
	renderBundledSupportTable,
} from "../helpers/bundled-support-table.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function filesUnder(dir) {
	const out = [];
	for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await filesUnder(path)));
		else out.push(path);
	}
	return out.sort();
}

async function scaffoldSpecFiles() {
	return (await filesUnder("skills/workflow-guide/scaffolds")).filter((file) =>
		file.endsWith("/spec.json"),
	);
}

test("every bundled workflow and scaffold validates and compiles with the bundled agents", async () => {
	// A project without its own agents: the bundled scout/researcher agents resolve.
	const cwd = await mkdtemp(join(tmpdir(), "aw-bundled-compile-"));
	try {
		const specs = [...BUNDLED_SPEC_FILES, ...(await scaffoldSpecFiles())];
		assert.ok(specs.length >= 12, specs.join(", "));
		for (const file of specs) {
			const specPath = join(root, file);
			const spec = parseWorkflow(JSON.parse(await readFile(specPath, "utf8")));
			const compiled = await compileWorkflow(spec, {
				cwd,
				specPath,
				task: "WP10 bundled compile check",
			});
			assert.ok(compiled.tasks.length > 0, file);
			assert.deepEqual(compiled.warnings ?? [], [], `${file} warnings`);
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

// agent-workflow 2026-11-08: a stage that reads its sources with sourcePolicy "partial" can finish
// while a source failed; resume reruns that source, so the stage must rerun too (deep-research and
// spec-review had no declaration and kept results built from the old inputs).
test("every bundled and scaffold non-foreach partial consumer invalidates on dependency resume", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-bundled-resume-"));
	try {
		for (const file of [
			...BUNDLED_SPEC_FILES,
			...(await scaffoldSpecFiles()),
		]) {
			const specPath = join(root, file);
			const raw = JSON.parse(await readFile(specPath, "utf8"));
			const partial = (raw.artifactGraph?.stages ?? []).filter(
				(stage) => stage.sourcePolicy === "partial" && stage.type !== "foreach",
			);
			const compiled = await compileWorkflow(parseWorkflow(raw), {
				cwd,
				specPath,
				task: "resume invalidation check",
			});
			for (const stage of partial) {
				const task = compiled.tasks.find(
					(row) => row.id === `${stage.id}.main`,
				);
				assert.equal(
					task?.artifactGraph?.inputPolicy?.invalidateOnDependencyResume,
					true,
					`${file}: ${stage.id}`,
				);
			}
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

// 2026-11-08 (found by the L4 live check on deep-review): a foreach that reads a stage which reruns on
// resume must rematerialize too; without its own declaration it kept the old children (dispatch map of
// the old generation) and the next stage failed "dispatch map generation is stale". The engine
// rematerializes a declared foreach transactionally; that needs an item identity.
test("every bundled and scaffold foreach fed by a rerunning stage invalidates on dependency resume", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-bundled-foreach-resume-"));
	try {
		for (const file of [
			...BUNDLED_SPEC_FILES,
			...(await scaffoldSpecFiles()),
		]) {
			const specPath = join(root, file);
			const raw = JSON.parse(await readFile(specPath, "utf8"));
			const stages = raw.artifactGraph?.stages ?? [];
			const rerunning = new Set(
				stages
					.filter(
						(stage) => stage.inputPolicy?.invalidateOnDependencyResume === true,
					)
					.map((stage) => stage.id),
			);
			const fed = stages.filter((stage) => {
				if (stage.type !== "foreach") return false;
				const source =
					typeof stage.from === "string" ? stage.from : stage.from?.source;
				return rerunning.has(source);
			});
			const compiled = await compileWorkflow(parseWorkflow(raw), {
				cwd,
				specPath,
				task: "foreach resume invalidation check",
			});
			for (const stage of fed) {
				assert.ok(
					stage.each?.itemIdentityPath,
					`${file}: ${stage.id} needs each.itemIdentityPath`,
				);
				const task = compiled.tasks.find(
					(row) => row.id === `${stage.id}.item`,
				);
				assert.equal(
					task?.artifactGraph?.inputPolicy?.invalidateOnDependencyResume,
					true,
					`${file}: ${stage.id}`,
				);
			}
		}
	} finally {
		await rm(cwd, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("bundled assets name the artifact tool by its workflow name only", async () => {
	const forbidden = [
		[/mcp__workflow_artifact__/u, "executor-specific artifact tool name"],
	];
	const files = [
		...(await filesUnder("workflows")),
		...(await filesUnder("skills")),
		...(await filesUnder("agents")),
	];
	assert.ok(files.length > 90, `${files.length} bundled files`);
	const hits = [];
	for (const file of files) {
		const text = await readFile(join(root, file), "utf8");
		for (const [pattern, why] of forbidden)
			if (pattern.test(text)) hits.push(`${file}: ${why}`);
	}
	assert.deepEqual(hits, []);
});

test("bundled specs use no Pi-only capability and opt into the readOnly downgrade", async () => {
	const piOnly = new Set(["toolResultBudget", "fast", "inheritHostTools"]);
	for (const file of BUNDLED_SPEC_FILES) {
		const spec = JSON.parse(await readFile(join(root, file), "utf8"));
		const found = [];
		const walk = (value, path) => {
			if (Array.isArray(value))
				value.forEach((item, index) => walk(item, `${path}[${index}]`));
			else if (value && typeof value === "object")
				for (const [key, child] of Object.entries(value)) {
					if (piOnly.has(key)) found.push(`${path}.${key}`);
					walk(child, `${path}.${key}`);
				}
		};
		walk(spec, "$");
		assert.deepEqual(found, [], file);
		assert.equal(spec.defaults.readOnly, true, file);
		assert.equal(spec.allowReadOnlyDowngrade, true, file);
	}
	const research = JSON.parse(
		await readFile(join(root, "workflows/deep-research/spec.json"), "utf8"),
	);
	assert.deepEqual(research.defaults.tools, [
		"read",
		"grep",
		"find",
		"ls",
		"web_search",
		"fetch_content",
	]);
	const researcher = await readFile(join(root, "agents/researcher.md"), "utf8");
	assert.match(
		researcher,
		/^tools: read, grep, find, ls, web_search, fetch_content$/mu,
	);
});

test("deep-research report and audit state that source verification is model-reported", async () => {
	const { default: render, SOURCE_VERIFICATION_STATEMENT } = await import(
		"../../workflows/deep-research/helpers/render-executive.mjs"
	);
	const { default: finalPacket } = await import(
		"../../workflows/deep-research/helpers/final-audit-packet.mjs"
	);
	assert.equal(
		SOURCE_VERIFICATION_STATEMENT,
		"Source verification: model-reported (byte-level source verification is not performed).",
	);
	const fixture = JSON.parse(
		await readFile(
			join(
				root,
				"test/fixtures/deep-research/max-synthesis-handoff-replay.json",
			),
			"utf8",
		),
	);
	// Same overlay shape as core-deep-research-completion-output (a passing v2 render).
	const packet = await finalPacket({
		sources: structuredClone(fixture.sources),
	});
	const row = (area, ids, status) => ({
		area,
		subjectStatus: "Stated by the audited packet.",
		referencePattern: "Reference pattern.",
		assessment: "Assessment.",
		supportingClaimIds: ids,
		evidenceStatus: status,
	});
	const result = await render({
		sources: {
			"final-audit-packet": packet,
			"final-audit": {
				schema: "deep-research-final-synthesis-v2",
				digest: "Evidence-qualified comparison.",
				synthesis: {
					bottomLine: "The evidence supports a qualified conclusion.",
					comparisonRows: [
						row("Primary capability", ["claim-001"], "verified"),
						row("Compatibility", ["claim-019"], "partially supported"),
						row("Maturity", ["claim-018"], "partially supported"),
					],
					keyFindingIds: ["claim-001", "claim-018", "claim-019"],
					recommendations: [
						{
							recommendation: "Prioritize the verified gap.",
							supportingClaimIds: ["claim-019"],
							evidenceStatus: "partially supported",
						},
					],
					actionPlan: [],
					caveatNotes: [
						{
							note: "Unverified leads remain outside the audited claim denominator.",
							readerNote: "Validate demand before investing.",
							relatedClaimIds: ["claim-019"],
							gapIds: ["gap-remaining-001"],
						},
					],
					parentDecisionNotes: [],
				},
			},
		},
	});
	assert.equal(result.status, "passed", JSON.stringify(result.gates));
	for (const [name, markdown] of [
		["completion summary", result.completionSummaryMarkdown],
		["final report", result.reportMarkdown],
		["audit", result.auditMarkdown],
	])
		assert.ok(
			markdown.includes(SOURCE_VERIFICATION_STATEMENT),
			`${name} lacks the source-verification statement`,
		);
});

test("the committed support table matches the offline B4 negotiation", async () => {
	const rows = await computeBundledSupportRows();
	assert.equal(rows.length, BUNDLED_SPEC_FILES.length * 3 * 2);
	const { text, start, end } = await readCommittedSupportTable();
	assert.equal(
		text.slice(start, end),
		renderBundledSupportTable(rows),
		"docs/usage.md#bundled-workflows is stale: run `npm run build && node test/helpers/bundled-support-table.mjs --write`",
	);
	// The table is honest about the bundled shape: nothing refuses on Claude; Codex records the
	// coarse tool allowlist in both modes, and only `safe` degrades the precise tool lists to
	// readOnly (spec opt-in) while `free` (the default) accepts them; web stages record the unknown
	// safety policy. Every pair appears in both permission modes.
	for (const row of rows) {
		assert.ok(["free", "safe"].includes(row.permissionMode), row.workflow);
		if (row.executor === "claude")
			assert.notEqual(row.declared.status, "refuse");
		if (row.executor === "codex") {
			const where = `${row.workflow} (${row.permissionMode})`;
			assert.equal(row.declared.status, "degrade", where);
			assert.ok(
				row.declared.detail.includes("CAPABILITY_MISSING:toolAllowlist.fine"),
				where,
			);
			assert.equal(
				row.declared.detail.includes("forcedReadOnly"),
				row.permissionMode === "safe",
				where,
			);
		}
		if (row.workflow.startsWith("deep-research/"))
			assert.ok(
				row.probed.detail.includes("webTools.safetyPolicy:unknown"),
				`${row.workflow} on ${row.executor}`,
			);
	}
});
