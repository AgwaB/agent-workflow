#!/usr/bin/env node
// New in agent-workflow (WP10): offline support table for the bundled workflows. For every bundled
// spec × executor (pi, codex, claude) it compiles the spec and runs the B4 negotiation against the
// capability table the adapter declares (`createExecutor(null).capabilities()`, no probe, no CLI or
// model call), with the run policy a default non-interactive run gets (no unverified opt-in, no
// strict profile, the spec's own `allowReadOnlyDowngrade`). A second column merges the rows the
// adapter's own probe reports in a clean environment (built from the adapters' probe code paths,
// not by running them): Pi with pi-web-access installed, Codex without a global AGENTS.md or
// `~/.codex/rules` allow rules; Claude's probe changes no negotiated row. Each pair is negotiated
// in both permission modes (WP4e): `free` (the default) and `safe`. Run after `npm run build`:
//
//   node test/helpers/bundled-support-table.mjs           # print the table
//   node test/helpers/bundled-support-table.mjs --write   # update docs/bundled-workflows.md
//
// `test/unit/bundled-workflows.test.mjs` fails when the committed table is stale.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (path) => join(root, "dist", path);

export const BUNDLED_SPEC_FILES = [
	"workflows/deep-research/spec.json",
	"workflows/deep-research/tiered-verification.spec.json",
	"workflows/deep-review/spec.json",
	"workflows/impact-review/spec.json",
	"workflows/spec-review/spec.json",
];
export const SUPPORT_TABLE_EXECUTORS = ["pi", "codex", "claude"];
/** Permission modes (docs/permissions.md); `free` is the default of every run. */
export const SUPPORT_TABLE_PERMISSION_MODES = ["free", "safe"];
export const SUPPORT_TABLE_START = "<!-- bundled-support-table:start -->";
export const SUPPORT_TABLE_END = "<!-- bundled-support-table:end -->";
const DOC = join(root, "docs", "bundled-workflows.md");

async function modules() {
	const [{ compileWorkflow }, { parseWorkflow }, negotiation, profiles, sdk] =
		await Promise.all([
			import(dist("core/compiler.js")),
			import(dist("core/schema.js")),
			import(dist("core/capability-negotiation.js")),
			import(dist("core/execution-profile.js")),
			import(dist("sdk/index.js")),
		]);
	const executors = {};
	const probedClean = {};
	for (const id of SUPPORT_TABLE_EXECUTORS) {
		const adapter = await import(dist(`executors/${id}/index.js`));
		executors[id] = adapter.createExecutor(null);
		probedClean[id] = cleanEnvironmentProbeRows(id, adapter);
	}
	return {
		compileWorkflow,
		parseWorkflow,
		negotiation,
		profiles,
		sdk,
		executors,
		probedClean,
	};
}

/** Probe rows of a clean environment, from the adapters' probe code paths (no CLI call). */
function cleanEnvironmentProbeRows(id, adapter) {
	if (id === "pi")
		// src/executors/pi/executor.ts probe(): `pi list` lists pi-web-access.
		return {
			webTools: {
				level: "native",
				source: "probed",
				verifiedWith: "pi-web-access via pi list",
				detail: "search+fetch",
				safetyPolicy: "unknown",
			},
		};
	if (id === "codex")
		return adapter.codexEnvironmentCapabilities({
			codexHome: "~/.codex",
			rulesPath: "~/.codex/rules",
			rulesFiles: 0,
			allowRules: 0,
			agentsPath: "~/.codex/AGENTS.md",
			globalAgentsMd: "absent",
			problems: [],
		});
	return {};
}

/** Compiles one bundled spec the way a default run does (declared default profile applied). */
export async function compileBundledSpec(file, mods) {
	const specPath = join(root, file);
	const raw = JSON.parse(await readFile(specPath, "utf8"));
	const parsed = mods.parseWorkflow(raw);
	const profileName =
		typeof parsed.defaultExecutionProfile === "string"
			? parsed.defaultExecutionProfile
			: undefined;
	const spec = mods.profiles.applyWorkflowExecutionProfile(
		parsed,
		profileName,
		undefined,
	).spec;
	const compiled = await mods.compileWorkflow(spec, {
		cwd: root,
		specPath,
		task: "bundled support table (offline)",
	});
	return { spec, compiled };
}

function summarize(stages, preview) {
	if (!preview.accepted) {
		const reasons = new Set();
		for (const stage of stages)
			for (const entry of stage.report.entries)
				if (entry.outcome === "refused") reasons.add(entry.code ?? entry.key);
		return { status: "refuse", detail: [...reasons].sort() };
	}
	const degradations = new Set();
	for (const stage of stages)
		for (const entry of stage.report.entries)
			if (entry.outcome === "degraded")
				degradations.add(
					entry.code ??
						(entry.key === "webTools"
							? "webTools.safetyPolicy:unknown"
							: entry.key),
				);
	if (preview.forcedReadOnly.length > 0) degradations.add("forcedReadOnly");
	if (degradations.size > 0)
		return { status: "degrade", detail: [...degradations].sort() };
	return { status: "accept", detail: [] };
}

/**
 * Rows `{workflow, executor, permissionMode, stages, declared, probed}` for every bundled spec ×
 * executor × permission mode.
 */
export async function computeBundledSupportRows() {
	const mods = await modules();
	const rows = [];
	for (const file of BUNDLED_SPEC_FILES) {
		const { spec, compiled } = await compileBundledSpec(file, mods);
		const targets = mods.negotiation.workflowNegotiationTargets(compiled);
		for (const id of SUPPORT_TABLE_EXECUTORS) {
			const executor = mods.executors[id];
			const ref = { id: executor.id, version: executor.version };
			for (const permissionMode of SUPPORT_TABLE_PERMISSION_MODES) {
				const policy = {
					interactive: false,
					allowUnverified: [],
					strict: [],
					allowReadOnlyDowngrade: spec.allowReadOnlyDowngrade === true,
					permissionMode,
				};
				const negotiate = (capabilities) => {
					const stages = targets.map((task) => ({
						label: task.id,
						report: mods.sdk.negotiateCapabilities(
							ref,
							capabilities,
							mods.negotiation.workflowTaskRequirementContext(task, policy),
						),
					}));
					return summarize(
						stages,
						mods.sdk.buildCapabilityPreview(stages, {
							executor: ref,
							permissionMode,
						}),
					);
				};
				const declared = executor.capabilities();
				rows.push({
					workflow: relative(root, join(root, file)).replace(
						/^workflows\//,
						"",
					),
					executor: id,
					permissionMode,
					stages: targets.length,
					declared: negotiate(declared),
					probed: negotiate(
						mods.sdk.mergeProbedCapabilities(declared, mods.probedClean[id]),
					),
				});
			}
		}
	}
	return rows;
}

export function renderBundledSupportTable(rows) {
	const lines = [
		SUPPORT_TABLE_START,
		"<!-- Generated by test/helpers/bundled-support-table.mjs; do not edit by hand. -->",
		"",
		"| Workflow | Executor | Mode | Stages | Declared table | Probed, clean environment |",
		"|---|---|---|---|---|---|",
	];
	const cell = ({ status, detail }) =>
		detail.length === 0
			? status
			: `${status}: ${detail.map((item) => `\`${item}\``).join(", ")}`;
	for (const row of rows)
		lines.push(
			`| \`${row.workflow}\` | ${row.executor} | ${row.permissionMode} | ${row.stages} | ${cell(row.declared)} | ${cell(row.probed)} |`,
		);
	lines.push("", SUPPORT_TABLE_END);
	return lines.join("\n");
}

export async function readCommittedSupportTable() {
	const text = await readFile(DOC, "utf8");
	const start = text.indexOf(SUPPORT_TABLE_START);
	const end = text.indexOf(SUPPORT_TABLE_END);
	if (start < 0 || end < start)
		throw new Error("docs/bundled-workflows.md has no support-table markers");
	return { text, start, end: end + SUPPORT_TABLE_END.length };
}

async function main() {
	const table = renderBundledSupportTable(await computeBundledSupportRows());
	if (!process.argv.includes("--write")) {
		process.stdout.write(`${table}\n`);
		return;
	}
	const { text, start, end } = await readCommittedSupportTable();
	await writeFile(DOC, `${text.slice(0, start)}${table}${text.slice(end)}`);
	process.stdout.write("updated docs/bundled-workflows.md\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	await main();
