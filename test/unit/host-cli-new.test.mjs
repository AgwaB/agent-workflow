// test-tier: integration
// `agent-workflow new <pattern> <name>`: every generated pattern validates with no warnings and rehearses
// with no findings (N2), the same arguments give byte-identical files (N3), nothing is overwritten without
// --force, scopes, usage errors, and the structural rules each generated spec must keep. No model, no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = await import("../../dist/hosts/cli/index.js");
const { validateJsonSchema } = await import("../../dist/core/json-schema.js");
const { AUTHORING_PATTERN_IDS, generatePatternFiles } = await import(
	"../../dist/core/authoring-patterns.js"
);
const { controlContract, exampleControl } = await import(
	"../../dist/core/authoring-contract.js"
);
const BIN = fileURLToPath(
	new URL("../../src/hosts/cli/cli.mjs", import.meta.url),
);

let root;
let cwd;
let home;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-new-")));
	cwd = join(root, "project");
	home = join(root, "home");
	await mkdir(join(cwd, ".agent-workflow"), { recursive: true });
	await mkdir(home, { recursive: true });
});
after(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

async function run(argv, options = {}) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd: options.cwd ?? cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: home },
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
}

async function listFiles(dir, prefix = "") {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory())
			found.push(
				...(await listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)),
			);
		else found.push(`${prefix}${entry.name}`);
	}
	return found.sort();
}

async function readTree(dir) {
	const tree = {};
	for (const file of await listFiles(dir))
		tree[file] = await readFile(join(dir, file), "utf8");
	return tree;
}

function modelStages(spec) {
	const found = [];
	const visit = (stage) => {
		if (stage.type === "loop") {
			for (const child of stage.stages) visit(child);
			return;
		}
		if (stage.support !== undefined) return;
		found.push(stage);
	};
	for (const stage of spec.artifactGraph.stages) visit(stage);
	return found;
}

function promptOf(stage) {
	return stage.each?.prompt ?? stage.prompt;
}

test("--list prints every pattern with a one-line description", async () => {
	const result = await run(["new", "--list"]);
	assert.equal(result.code, 0, result.err);
	for (const id of AUTHORING_PATTERN_IDS)
		assert.match(result.out, new RegExp(`^  ${id}\\s+\\S`, "mu"));
	const json = JSON.parse((await run(["new", "--list", "--json"])).out);
	assert.equal(json.action, "new");
	assert.deepEqual(
		json.data.patterns.map((pattern) => pattern.id),
		[...AUTHORING_PATTERN_IDS],
	);
	assert.ok(json.data.patterns.every((pattern) => pattern.description));
	assert.equal((await run(["new", "--list", "single"])).code, 2);
});

for (const pattern of AUTHORING_PATTERN_IDS) {
	test(`${pattern}: validates with no warnings and rehearses with no findings (N2)`, async () => {
		const name = `gen-${pattern}`;
		const created = await run(["new", pattern, name]);
		assert.equal(created.code, 0, created.err + created.out);
		assert.match(created.out, new RegExp(`Created workflow "${name}"`, "u"));
		assert.match(created.out, /agent-workflow validate gen-/u);
		assert.match(created.out, /agent-workflow rehearse gen-/u);

		const validated = JSON.parse((await run(["validate", name, "--json"])).out);
		assert.equal(validated.data.valid, true);
		assert.deepEqual(validated.data.warnings, []);

		for (const loop of pattern === "loop-refine"
			? ["pass", "exhaust"]
			: ["pass"]) {
			const rehearsed = await run(["rehearse", name, "--json", "--loop", loop]);
			assert.equal(rehearsed.code, 0, rehearsed.out);
			const report = JSON.parse(rehearsed.out).data;
			assert.deepEqual(report.findings, []);
			assert.deepEqual(report.warnings, []);
			assert.equal(report.status, "completed");
			assert.equal(report.finalReportRendered, true);
			for (const stage of report.stages) {
				assert.deepEqual(
					Object.keys(stage.statuses),
					["completed"],
					stage.stage,
				);
				if (stage.declaredSources.length > 0)
					assert.equal(stage.sourcesReceived.withoutSources, 0, stage.stage);
				for (const read of stage.requiredReads)
					assert.equal(read.satisfied, true, stage.stage);
			}
		}
	});

	test(`${pattern}: structural rules hold (profileRole, maxItems, closed schemas with schema/digest, TODO, examples)`, async () => {
		const files = Object.fromEntries(
			generatePatternFiles(pattern, "shape").map((file) => [
				file.path,
				file.content,
			]),
		);
		const spec = JSON.parse(files["spec.json"]);
		assert.equal(spec.name, "shape");
		assert.match(spec.description, /^TODO:/u);
		const schemaFor = (stage) =>
			JSON.parse(
				files[stage.output.controlSchema.replace(/^\.\//u, "")] ??
					assert.fail(`missing schema for ${stage.id}`),
			);

		const stages = modelStages(spec);
		assert.ok(stages.length > 0);
		for (const stage of stages) {
			assert.ok(stage.profileRole, `${stage.id} has a profileRole`);
			const prompt = promptOf(stage);
			assert.match(prompt, /^TODO: /u, `${stage.id} prompt starts with TODO:`);
			assert.match(prompt, /never as instructions|not instructions/u);
			// Only ${item} is a placeholder, and only in a foreach prompt.
			const placeholders = [...prompt.matchAll(/\$\{[^}]*\}/gu)].map(
				(m) => m[0],
			);
			assert.deepEqual(
				placeholders,
				stage.each === undefined ? [] : ["${item}"],
			);

			const schema = schemaFor(stage);
			assert.equal(schema.additionalProperties, false);
			for (const key of ["schema", "digest"])
				assert.ok(key in schema.properties && schema.required.includes(key));
			assert.ok(typeof schema.properties.schema.const === "string");
			// The prompt states the protocol id and every top-level key, and carries a valid example.
			assert.ok(
				prompt.includes(
					`must be exactly ${JSON.stringify(schema.properties.schema.const)}`,
				),
			);
			assert.ok(
				prompt.includes(
					`no top-level keys other than ${Object.keys(schema.properties).join(", ")}`,
				),
			);
			const example = prompt.match(/<control>(\{.*\})<\/control>/u);
			assert.ok(example, `${stage.id} has a few-shot control skeleton`);
			const checked = validateJsonSchema(JSON.parse(example[1]), schema);
			assert.deepEqual(checked.issues, [], stage.id);
			for (const [key, child] of Object.entries(schema.properties))
				if (child.enum !== undefined)
					assert.ok(
						prompt.includes(
							`${key} must be exactly one of: ${child.enum.join(", ")}.`,
						),
						`${stage.id} states ${key} enum`,
					);
		}

		// Every foreach source array is capped in the producing stage's schema.
		for (const stage of spec.artifactGraph.stages) {
			if (stage.type !== "foreach") continue;
			const producer = spec.artifactGraph.stages.find(
				(candidate) => candidate.id === stage.from.source,
			);
			const key = stage.from.path.replace(/^\$\./u, "");
			const cap = schemaFor(producer).properties[key].maxItems;
			assert.ok(Number.isInteger(cap) && cap > 0, `${stage.id} source capped`);
			assert.ok(stage.each.itemIdentityPath);
		}
		// A required read names the artifact only: a read "with a path" counts only when the worker passes that
		// path to the tool, and a cheap model did not (live run: two output retries on `path: "$"`).
		for (const stage of spec.artifactGraph.stages)
			for (const read of stage.inputPolicy?.requiredReads ?? []) {
				assert.equal(typeof read, "object");
				assert.equal(
					read.path,
					undefined,
					`${stage.id} requiredRead has no path`,
				);
				assert.ok(read.source && read.artifact);
			}
		// Every referenced file exists and nothing else is shipped.
		const referenced = new Set(["spec.json"]);
		const collect = (stage) => {
			if (stage.output?.controlSchema)
				referenced.add(stage.output.controlSchema.replace(/^\.\//u, ""));
			if (stage.support?.uses)
				referenced.add(stage.support.uses.replace(/^\.\//u, ""));
			for (const child of stage.stages ?? []) collect(child);
		};
		for (const stage of spec.artifactGraph.stages) collect(stage);
		assert.deepEqual(Object.keys(files).sort(), [...referenced].sort());
		// Support stages declare no type and no profileRole.
		for (const stage of spec.artifactGraph.stages)
			if (stage.support !== undefined) {
				assert.equal(stage.type, undefined);
				assert.equal(stage.profileRole, undefined);
			}
	});

	test(`${pattern}: the same arguments give byte-identical files (N3)`, async () => {
		const first = generatePatternFiles(pattern, "same");
		assert.deepEqual(generatePatternFiles(pattern, "same"), first);
		const a = await mkdtemp(join(root, "a-"));
		const b = await mkdtemp(join(root, "b-"));
		for (const dir of [a, b]) {
			await mkdir(join(dir, ".agent-workflow"), { recursive: true });
			const result = await run(["new", pattern, "same"], { cwd: dir });
			assert.equal(result.code, 0, result.err);
		}
		const treeA = await readTree(join(a, ".agent-workflow/workflows/same"));
		const treeB = await readTree(join(b, ".agent-workflow/workflows/same"));
		assert.deepEqual(treeA, treeB);
		assert.deepEqual(Object.keys(treeA), first.map((file) => file.path).sort());
		for (const file of first) assert.equal(treeA[file.path], file.content);
		// A different name changes only the name (spec.json), nothing else.
		const other = generatePatternFiles(pattern, "other");
		for (const [index, file] of other.entries())
			if (file.path !== "spec.json")
				assert.equal(file.content, first[index].content);
	});
}

test("the merge helper sorts findings, dimensions follow the reviewer stage ids, a malformed reviewer throws", async () => {
	const dir = await mkdtemp(join(root, "merge-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	assert.equal(
		(await run(["new", "parallel-review-merge", "m"], { cwd: dir })).code,
		0,
	);
	const helper = (
		await import(
			pathToFileURL(
				join(dir, ".agent-workflow/workflows/m/helpers/merge-findings.mjs"),
			)
		)
	).default;
	const row = (title, severity, location) => ({
		title,
		severity,
		location,
		summary: "s",
		recommendation: "r",
	});
	const sources = {
		"reviewer-2": {
			schema: "review-findings-v1",
			findings: [row("b", "low", "x.ts:1"), row("a", "critical", "y.ts:2")],
		},
		"reviewer-1": {
			schema: "review-findings-v1",
			findings: [row("c", "critical", "x.ts:9")],
		},
	};
	const merged = await helper({ sources });
	assert.equal(merged.schema, "merged-findings-v1");
	assert.deepEqual(merged.dimensions, ["reviewer-1", "reviewer-2"]);
	assert.deepEqual(
		merged.findings.map((f) => [f.id, f.dimension, f.title]),
		[
			["F-01", "reviewer-1", "c"],
			["F-02", "reviewer-2", "a"],
			["F-03", "reviewer-2", "b"],
		],
	);
	assert.deepEqual(merged.bySeverity, {
		critical: 2,
		high: 0,
		medium: 0,
		low: 1,
	});
	assert.equal(merged.total, 3);
	await assert.rejects(
		helper({ sources: { ...sources, "reviewer-3": { schema: "other" } } }),
		/reviewer-3 is missing or malformed/u,
	);
	await assert.rejects(
		helper({ sources: { ...sources, "reviewer-3": undefined } }),
	);
	// Output is valid for its own schema.
	const schema = JSON.parse(
		await readFile(
			join(
				dir,
				".agent-workflow/workflows/m/schemas/merged-findings.schema.json",
			),
			"utf8",
		),
	);
	assert.deepEqual(validateJsonSchema(merged, schema).issues, []);
});

test("the count helper reconciles ids, not counts: a missing id is listed, an unexpected one too", async () => {
	const dir = await mkdtemp(join(root, "count-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	assert.equal(
		(await run(["new", "classify-count", "c"], { cwd: dir })).code,
		0,
	);
	const helper = (
		await import(
			pathToFileURL(join(dir, ".agent-workflow/workflows/c/helpers/count.mjs"))
		)
	).default;
	const load = { items: [{ id: "A-1" }, { id: "A-2" }, { id: "A-3" }] };
	const status = (id, source) => ({
		stageId: "classify",
		itemIdentity: id,
		source,
		status: "completed",
	});
	const context = {
		sourceStatuses: [
			{ stageId: "load", source: "load", status: "completed" },
			status("A-1", "classify"),
			status("A-2", "classify.a-2"),
			status("A-9", "classify.a-9"),
		],
	};
	const sources = {
		load,
		classify: { label: "label-a" },
		"classify.a-2": { label: "label-a" },
		"classify.a-9": { label: "other" },
	};
	const counted = await helper({ context, sources });
	assert.deepEqual(counted.counts, [{ label: "label-a", count: 2 }]);
	assert.deepEqual(counted.missing, ["A-3"]);
	assert.deepEqual(counted.unexpected, ["A-9"]);
	assert.equal(counted.total, 3);
	assert.equal(counted.classified, 2);
	const schema = JSON.parse(
		await readFile(
			join(dir, ".agent-workflow/workflows/c/schemas/class-counts.schema.json"),
			"utf8",
		),
	);
	assert.deepEqual(validateJsonSchema(counted, schema).issues, []);
	await assert.rejects(helper({ context, sources: {} }), /no items list/u);
});

test("never overwrites without --force; --force replaces only the pattern's files", async () => {
	const dir = await mkdtemp(join(root, "force-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	const target = join(dir, ".agent-workflow/workflows/f");
	assert.equal((await run(["new", "single", "f"], { cwd: dir })).code, 0);
	await writeFile(join(target, "spec.json"), "edited by the author\n");
	await writeFile(join(target, "notes.md"), "mine\n");

	const refused = await run(["new", "single", "f"], { cwd: dir });
	assert.equal(refused.code, 2);
	assert.match(refused.err, /Refusing to overwrite existing files/u);
	assert.match(refused.err, /spec\.json/u);
	assert.equal(
		await readFile(join(target, "spec.json"), "utf8"),
		"edited by the author\n",
	);

	// A different pattern into the same directory is refused too, and writes nothing new.
	assert.equal(
		(await run(["new", "foreach-reduce", "f"], { cwd: dir })).code,
		2,
	);
	assert.equal(existsSync(join(target, "schemas/plan.schema.json")), false);

	const forced = await run(["new", "single", "f", "--force"], { cwd: dir });
	assert.equal(forced.code, 0, forced.err);
	assert.match(forced.out, /spec\.json \(overwritten\)/u);
	assert.equal(
		await readFile(join(target, "spec.json"), "utf8"),
		generatePatternFiles("single", "f")[0].content,
	);
	assert.equal(await readFile(join(target, "notes.md"), "utf8"), "mine\n");
});

test("scopes: private (default), shared and global; a higher-priority same name is noted", async () => {
	const dir = await mkdtemp(join(root, "scope-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	const priv = await run(["new", "single", "s1"], { cwd: dir });
	assert.equal(priv.code, 0, priv.err);
	assert.ok(existsSync(join(dir, ".agent-workflow/workflows/s1/spec.json")));

	const shared = await run(["new", "single", "s2", "--scope", "shared"], {
		cwd: dir,
	});
	assert.equal(shared.code, 0, shared.err);
	assert.ok(existsSync(join(dir, "workflows/s2/spec.json")));
	assert.match(shared.out, /scope shared/u);

	const global = await run(
		["new", "single", "s3", "--scope=global", "--json"],
		{ cwd: dir },
	);
	assert.equal(global.code, 0, global.err);
	const data = JSON.parse(global.out).data;
	assert.equal(data.scope, "global");
	assert.equal(data.directory, join(home, "workflows", "s3"));
	assert.ok(existsSync(join(home, "workflows/s3/spec.json")));
	assert.deepEqual(data.files, ["spec.json", "schemas/result.schema.json"]);
	assert.equal(data.nextSteps.length, 5);

	// The same name in the shared scope shadows a private workflow: say so.
	const shadow = await run(["new", "single", "s2"], { cwd: dir });
	assert.equal(shadow.code, 0, shadow.err);
	assert.match(
		shadow.out,
		/Note: workflows\/s2 \(project-shared\) has the same name and takes priority/u,
	);
	// A created project-private workflow is found by name from the project.
	const validated = await run(["validate", "s1"], { cwd: dir });
	assert.equal(validated.code, 0, validated.err);
});

test("symlinks and a flat <name>.json are refused before anything is written", async () => {
	const dir = await mkdtemp(join(root, "link-"));
	const workflows = join(dir, ".agent-workflow/workflows");
	await mkdir(workflows, { recursive: true });
	const outside = await mkdtemp(join(root, "outside-"));
	await symlink(outside, join(workflows, "linked"));
	const linked = await run(["new", "single", "linked"], { cwd: dir });
	assert.equal(linked.code, 2);
	assert.match(linked.err, /is a symlink/u);
	assert.deepEqual(await readdir(outside), []);

	await writeFile(join(workflows, "flat.json"), "{}");
	const flat = await run(["new", "single", "flat"], { cwd: dir });
	assert.equal(flat.code, 2);
	assert.match(flat.err, /flat\.json already exists/u);
	assert.equal(existsSync(join(workflows, "flat")), false);

	await mkdir(join(workflows, "sub/schemas"), { recursive: true });
	await rm(join(workflows, "sub/schemas"), { recursive: true });
	await symlink(outside, join(workflows, "sub/schemas"));
	const sub = await run(["new", "single", "sub"], { cwd: dir });
	assert.equal(sub.code, 2);
	assert.match(sub.err, /schemas is a symlink/u);
	assert.deepEqual(await readdir(outside), []);
	assert.equal(existsSync(join(workflows, "sub/spec.json")), false);

	await mkdir(join(workflows, "fileLink"), { recursive: true });
	await writeFile(join(outside, "target.json"), "keep");
	await symlink(
		join(outside, "target.json"),
		join(workflows, "fileLink/spec.json"),
	);
	const fileLink = await run(["new", "single", "fileLink", "--force"], {
		cwd: dir,
	});
	assert.equal(fileLink.code, 2);
	assert.equal(await readFile(join(outside, "target.json"), "utf8"), "keep");
});

test("usage errors exit 2 and write nothing", async () => {
	const dir = await mkdtemp(join(root, "usage-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	for (const argv of [
		["new"],
		["new", "single"],
		["new", "nope", "x"],
		["new", "single", "bad/name"],
		["new", "single", ".hidden"],
		["new", "single", "x", "y"],
		["new", "single", "x", "--scope", "everywhere"],
		["new", "single", "x", "--force", "--force"],
		["new", "single", "x", "--bogus"],
	]) {
		const result = await run(argv, { cwd: dir });
		assert.equal(
			result.code,
			2,
			`${argv.join(" ")}: ${result.out}${result.err}`,
		);
	}
	assert.equal(existsSync(join(dir, ".agent-workflow/workflows")), false);
	assert.equal(existsSync(join(dir, "workflows")), false);
	const help = await run(["new", "--help"], { cwd: dir });
	assert.equal(help.code, 0);
	assert.match(help.out, /agent-workflow new <pattern> <name>/u);
	assert.match(
		(await run(["help"], { cwd: dir })).out,
		/new <pattern> <name>/u,
	);
});

test("the real bin lists patterns and creates a bundle", async () => {
	const dir = await mkdtemp(join(root, "bin-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	const env = { ...process.env, AGENT_WORKFLOW_HOME: home };
	const listed = spawnSync(process.execPath, [BIN, "new", "--list"], {
		cwd: dir,
		env,
		encoding: "utf8",
	});
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /classify-count/u);
	const made = spawnSync(
		process.execPath,
		[BIN, "new", "loop-refine", "bin-loop"],
		{ cwd: dir, env, encoding: "utf8" },
	);
	assert.equal(made.status, 0, made.stderr);
	assert.ok(
		existsSync(join(dir, ".agent-workflow/workflows/bin-loop/spec.json")),
	);
	const again = spawnSync(
		process.execPath,
		[BIN, "new", "loop-refine", "bin-loop"],
		{ cwd: dir, env, encoding: "utf8" },
	);
	assert.equal(again.status, 2);
});

test("the generated contract and example come from the schema and refuse a value the schema rejects", () => {
	const schema = {
		type: "object",
		required: ["schema", "digest", "kind", "rows"],
		properties: {
			schema: { const: "demo-v1" },
			digest: { type: "string", minLength: 1, maxLength: 50 },
			kind: { enum: ["a", "b"] },
			rows: {
				type: "array",
				items: { type: "string", maxLength: 20 },
				maxItems: 3,
			},
		},
		additionalProperties: false,
	};
	const contract = controlContract(schema, { kind: "b", rows: ["x"] });
	assert.match(
		contract,
		/no top-level keys other than schema, digest, kind, rows/u,
	);
	assert.match(contract, /schema must be exactly "demo-v1"/u);
	assert.match(contract, /kind must be exactly one of: a, b\./u);
	assert.match(contract, /Array caps: rows<=3/u);
	assert.match(
		contract,
		/<control>\{"schema":"demo-v1","digest":"digest","kind":"b","rows":\["x"\]\}<\/control>/u,
	);
	assert.equal(controlContract(schema, { kind: "b", rows: ["x"] }), contract);
	assert.throws(
		() => exampleControl(schema, { kind: "zzz" }),
		/does not match its schema/u,
	);
});

// --- Review fixes (2026-11-22) ---

test("the count helper reports duplicate loaded ids and keeps classified + missing = total", async () => {
	const dir = await mkdtemp(join(root, "dup-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	assert.equal(
		(await run(["new", "classify-count", "d"], { cwd: dir })).code,
		0,
	);
	const helper = (
		await import(
			pathToFileURL(join(dir, ".agent-workflow/workflows/d/helpers/count.mjs"))
		)
	).default;
	const load = {
		items: [{ id: "A-1" }, { id: "A-2" }, { id: "A-1" }, { id: "A-3" }],
	};
	const status = (id, source) => ({
		stageId: "classify",
		itemIdentity: id,
		source,
		status: "completed",
	});
	const context = {
		sourceStatuses: [
			status("A-1", "classify.a-1"),
			status("A-2", "classify.a-2"),
		],
	};
	const sources = {
		load,
		"classify.a-1": { label: "label-a" },
		"classify.a-2": { label: "label-b" },
	};
	const counted = await helper({ context, sources });
	assert.deepEqual(counted.duplicates, ["A-1"]);
	assert.equal(counted.total, 3);
	assert.equal(counted.classified, 2);
	assert.deepEqual(counted.missing, ["A-3"]);
	assert.equal(counted.classified + counted.missing.length, counted.total);
	assert.match(counted.digest, /1 duplicate id/u);
	const schema = JSON.parse(
		await readFile(
			join(dir, ".agent-workflow/workflows/d/schemas/class-counts.schema.json"),
			"utf8",
		),
	);
	assert.deepEqual(validateJsonSchema(counted, schema).issues, []);
	const clean = await helper({
		context,
		sources: { ...sources, load: { items: [{ id: "A-1" }, { id: "A-2" }] } },
	});
	assert.deepEqual(clean.duplicates, []);
});

test("Windows-reserved workflow names are a usage error, any case, with or without extension", async () => {
	const dir = await mkdtemp(join(root, "reserved-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	for (const name of [
		"CON",
		"con",
		"Prn",
		"AUX",
		"nul",
		"COM1",
		"com9",
		"LPT1",
		"lpt9",
		"con.txt",
		"NUL.v2",
	]) {
		const result = await run(["new", "single", name], { cwd: dir });
		assert.equal(result.code, 2, `${name}: ${result.out}${result.err}`);
		assert.match(result.err, /reserved/iu);
	}
	assert.equal(existsSync(join(dir, ".agent-workflow/workflows")), false);
	for (const name of [
		"console",
		"com0",
		"com10",
		"lpt",
		"auxiliary",
		"con-1",
	]) {
		assert.equal(
			(await run(["new", "single", name], { cwd: dir })).code,
			0,
			name,
		);
	}
});

const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

test("a write failing part-way leaves nothing behind (all-or-nothing)", {
	skip: !canChmod && "needs a non-root POSIX user",
}, async () => {
	const dir = await mkdtemp(join(root, "partial-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	const workflows = join(dir, ".agent-workflow/workflows");
	const target = join(workflows, "p");
	// classify-count writes spec.json, schemas/*, then helpers/count.mjs; make helpers/ unwritable.
	await mkdir(join(target, "helpers"), { recursive: true });
	chmodSync(join(target, "helpers"), 0o555);
	try {
		const failed = await run(["new", "classify-count", "p"], { cwd: dir });
		assert.notEqual(failed.code, 0, failed.out);
		assert.deepEqual(await listFiles(target), []);
		assert.deepEqual(
			(await readdir(target)).sort(),
			["helpers"],
			"no spec.json and no schemas/ directory left behind",
		);
		assert.deepEqual(
			(await readdir(workflows)).sort(),
			["p"],
			"no staging directory left behind",
		);
	} finally {
		chmodSync(join(target, "helpers"), 0o755);
	}
	const ok = await run(["new", "classify-count", "p"], { cwd: dir });
	assert.equal(ok.code, 0, ok.err);
	assert.deepEqual((await readdir(workflows)).sort(), ["p"]);
});

test("a failing --force restores the files it had already replaced", {
	skip: !canChmod && "needs a non-root POSIX user",
}, async () => {
	const dir = await mkdtemp(join(root, "partial-force-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	const target = join(dir, ".agent-workflow/workflows/q");
	assert.equal(
		(await run(["new", "classify-count", "q"], { cwd: dir })).code,
		0,
	);
	await writeFile(join(target, "spec.json"), "edited by the author\n");
	await writeFile(join(target, "notes.md"), "mine\n");
	const before = await readTree(target);
	chmodSync(join(target, "helpers"), 0o555);
	try {
		const failed = await run(["new", "classify-count", "q", "--force"], {
			cwd: dir,
		});
		assert.notEqual(failed.code, 0, failed.out);
	} finally {
		chmodSync(join(target, "helpers"), 0o755);
	}
	assert.deepEqual(await readTree(target), before);
	assert.deepEqual(
		(await readdir(join(dir, ".agent-workflow/workflows"))).sort(),
		["q"],
	);
});
