// test-tier: integration
// `agent-workflow new <pattern> <name>`: every generated pattern validates with no warnings and rehearses
// with no findings (N2), the same arguments give byte-identical files (N3), nothing is overwritten without
// --force, scopes, usage errors, and the structural rules each generated spec must keep. No model, no network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

/** A project directory; write-verify needs a git repository with a commit (a writer gets a worktree). */
async function projectFor(pattern, prefix = "p-") {
	const dir = await mkdtemp(join(root, prefix));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	if (pattern === "write-verify") {
		const git = (...args) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
		git("init", "-q");
		git(
			"-c",
			"user.email=t@example.test",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		);
	}
	return dir;
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
		const dir = await projectFor(pattern);
		const here = (argv) => run(argv, { cwd: dir });
		const created = await here(["new", pattern, name]);
		assert.equal(created.code, 0, created.err + created.out);
		assert.match(created.out, new RegExp(`Created workflow "${name}"`, "u"));
		assert.match(created.out, /agent-workflow validate gen-/u);
		assert.match(created.out, /agent-workflow rehearse gen-/u);

		const validated = JSON.parse(
			(await here(["validate", name, "--json"])).out,
		);
		assert.equal(validated.data.valid, true);
		assert.deepEqual(validated.data.warnings, []);

		for (const loop of pattern === "loop-refine"
			? ["pass", "exhaust"]
			: ["pass"]) {
			const rehearsed = await here([
				"rehearse",
				name,
				"--json",
				"--loop",
				loop,
			]);
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
			generatePatternFiles(pattern, "shape")
				.filter((file) => file.location !== "agents")
				.map((file) => [file.path, file.content]),
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
		// collect-render is the one deterministic-only pattern: no model stage at all.
		if (pattern === "collect-render") assert.equal(stages.length, 0);
		else assert.ok(stages.length > 0);
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
		const a = await projectFor(pattern, "a-");
		const b = await projectFor(pattern, "b-");
		for (const dir of [a, b]) {
			const result = await run(["new", pattern, "same"], { cwd: dir });
			assert.equal(result.code, 0, result.err);
		}
		const treeA = await readTree(join(a, ".agent-workflow/workflows/same"));
		const treeB = await readTree(join(b, ".agent-workflow/workflows/same"));
		assert.deepEqual(treeA, treeB);
		const inBundle = first.filter((file) => file.location !== "agents");
		assert.deepEqual(
			Object.keys(treeA),
			inBundle.map((file) => file.path).sort(),
		);
		for (const file of inBundle) assert.equal(treeA[file.path], file.content);
		// Agent definitions go to the agents directory, byte-identical too.
		const agentsDir = (dir) => join(dir, ".agent-workflow/agents");
		const agentsA = existsSync(agentsDir(a))
			? await readTree(agentsDir(a))
			: {};
		assert.deepEqual(
			agentsA,
			existsSync(agentsDir(b)) ? await readTree(agentsDir(b)) : {},
		);
		const agents = first.filter((file) => file.location === "agents");
		assert.deepEqual(
			Object.keys(agentsA),
			agents.map((file) => file.path).sort(),
		);
		for (const file of agents) assert.equal(agentsA[file.path], file.content);
		// A different name changes only the name (spec.json), nothing else.
		const other = generatePatternFiles(pattern, "other");
		for (const [index, file] of other.entries())
			if (file.path !== "spec.json" && file.location !== "agents")
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

// ---------------------------------------------------------------- write-verify

const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.test",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.test",
};
function git(dir, ...args) {
	return execFileSync("git", ["-C", dir, ...args], {
		env: GIT_ENV,
		encoding: "utf8",
	});
}

async function withHelper(pattern, name, helperFile) {
	const dir = await projectFor(pattern, `${pattern}-`);
	assert.equal((await run(["new", pattern, name], { cwd: dir })).code, 0);
	const bundle = join(dir, ".agent-workflow/workflows", name);
	const module = await import(
		`${pathToFileURL(join(bundle, "helpers", helperFile)).href}?${Math.random()}`
	);
	return { dir, bundle, helper: module.default };
}

test("write-verify: the writer is write-capable in a worktree, has a bundle-local agent, and nothing merges", async () => {
	const dir = await projectFor("write-verify", "wv-shape-");
	const created = await run(["new", "write-verify", "wv.shape"], { cwd: dir });
	assert.equal(created.code, 0, created.err);
	const spec = JSON.parse(
		await readFile(
			join(dir, ".agent-workflow/workflows/wv.shape/spec.json"),
			"utf8",
		),
	);
	const [write, verify] = spec.artifactGraph.stages;
	assert.equal(write.readOnly, false);
	assert.equal(write.worktreePolicy, "on");
	assert.equal(write.agent, "wv-shape-writer");
	assert.ok(write.tools.includes("write") && write.tools.includes("edit"));
	assert.equal(write.tools.includes("bash"), false);
	assert.deepEqual(verify.from, ["write"]);
	assert.equal(verify.sourcePolicy, "require-success");
	assert.deepEqual(verify.support.options.files, [
		{ path: "OUTPUT.md", markers: ["# Output"] },
	]);
	// The agent lands in the project's agents directory and allows write tools.
	const agent = await readFile(
		join(dir, ".agent-workflow/agents/wv-shape-writer.md"),
		"utf8",
	);
	assert.match(agent, /^tools: read, grep, find, ls, edit, write$/mu);
	assert.match(agent, /^readOnly: false$/mu);
	assert.match(created.out, /agents\/wv-shape-writer\.md \(agent\)/u);
	assert.equal(existsSync(join(dir, "workflows")), false);
	// No merge, no commit instruction anywhere.
	assert.match(agent, /Never commit, stage, push/u);
	assert.equal(JSON.stringify(spec).includes("merge"), false);
	const listed = await run(["agents", "--json"], { cwd: dir });
	assert.match(listed.out, /wv-shape-writer/u);
});

test("write-verify: the agent follows the scope and is never overwritten without --force", async () => {
	const dir = await projectFor("write-verify", "wv-scope-");
	const agentFile = join(dir, ".agent-workflow/agents/wv-writer.md");
	const globalAgent = join(home, "agents/wvg-writer.md");
	const shared = await run(["new", "write-verify", "wv", "--scope", "shared"], {
		cwd: dir,
	});
	assert.equal(shared.code, 0, shared.err);
	assert.ok(existsSync(join(dir, "workflows/wv/spec.json")));
	assert.ok(existsSync(agentFile));
	assert.match(shared.out, /the writer agent is project-private/u);
	const mine = "my edited agent\n";
	await writeFile(agentFile, mine);
	const refused = await run(
		["new", "write-verify", "wv", "--scope", "shared"],
		{
			cwd: dir,
		},
	);
	assert.equal(refused.code, 2);
	assert.match(refused.err, /agents\/wv-writer\.md/u);
	assert.equal(await readFile(agentFile, "utf8"), mine);
	// A foreign agent alone blocks the whole call: nothing else is written for a new name.
	await mkdir(join(dir, ".agent-workflow/agents"), { recursive: true });
	await writeFile(join(dir, ".agent-workflow/agents/z-writer.md"), mine);
	const blocked = await run(["new", "write-verify", "z"], { cwd: dir });
	assert.equal(blocked.code, 2);
	assert.equal(
		existsSync(join(dir, ".agent-workflow/workflows/z")),
		false,
		"nothing written when the agent file is refused",
	);
	const forced = await run(
		["new", "write-verify", "wv", "--scope", "shared", "--force"],
		{ cwd: dir },
	);
	assert.equal(forced.code, 0, forced.err);
	assert.notEqual(await readFile(agentFile, "utf8"), mine);
	assert.match(forced.out, /\(agent, overwritten\)/u);
	// Global scope: the user's agents directory.
	const global = await run(
		["new", "write-verify", "wvg", "--scope", "global"],
		{
			cwd: dir,
		},
	);
	assert.equal(global.code, 0, global.err);
	assert.ok(existsSync(globalAgent));
	assert.equal(
		JSON.parse(
			(await run(["new", "write-verify", "wvj", "--json"], { cwd: dir })).out,
		).data.agentFiles[0],
		join(dir, ".agent-workflow/agents/wvj-writer.md"),
	);
});

test("write-verify: the verify helper checks existence, content and markers in the writer worktree", async () => {
	const { dir, bundle, helper } = await withHelper(
		"write-verify",
		"wvh",
		"verify-files.mjs",
	);
	const schema = JSON.parse(
		await readFile(join(bundle, "schemas/write-check.schema.json"), "utf8"),
	);
	const branch = "agent-workflow/run1-task-1";
	const tree = join(dir, "wt");
	git(dir, "worktree", "add", "-q", "-b", branch, tree);
	const context = {
		runId: "run1",
		cwd: dir,
		sourceStatuses: [
			{
				stageId: "write",
				taskId: "task-1",
				source: "write",
				status: "completed",
			},
		],
	};
	const options = {
		writer: "write",
		files: [
			{ path: "OUTPUT.md", markers: ["# Output", "done"] },
			{ path: "docs/more.md", markers: [] },
		],
	};
	const check = async (opts = options, ctx = context) => {
		const value = await helper({ options: opts, context: ctx });
		assert.deepEqual(validateJsonSchema(value, schema).issues, []);
		assert.equal(value.gates.passed, value.status === "passed");
		return value;
	};
	// Nothing written: failed, and the worktree is named.
	let value = await check();
	assert.equal(value.status, "failed");
	assert.equal(value.branch, branch);
	assert.match(value.digest, /OUTPUT\.md missing/u);
	assert.equal(await realpath(value.worktree), await realpath(tree));
	// Empty and whitespace-only files fail.
	await writeFile(join(tree, "OUTPUT.md"), "");
	await mkdir(join(tree, "docs"));
	await writeFile(join(tree, "docs/more.md"), "x\n");
	value = await check();
	assert.match(value.files[0].problem, /empty/u);
	assert.equal(value.files[1].ok, true);
	await writeFile(join(tree, "OUTPUT.md"), "  \n\t\n");
	assert.match((await check()).files[0].problem, /only whitespace/u);
	// A missing marker fails and is named; all markers present passes.
	await writeFile(join(tree, "OUTPUT.md"), "# Output\nnot yet\n");
	value = await check();
	assert.equal(value.status, "failed");
	assert.deepEqual(value.files[0].missingMarkers, ["done"]);
	await writeFile(join(tree, "OUTPUT.md"), "# Output\nall done\n");
	value = await check();
	assert.equal(value.status, "passed");
	assert.equal(value.gates.passed, true);
	assert.match(value.markdown, /kept/u);
	// The main checkout does not count: a file only there fails.
	await rm(join(tree, "docs/more.md"));
	await writeFile(join(dir, "docs-more.md"), "elsewhere\n");
	assert.equal((await check()).status, "failed");
	// A symlink out of the worktree is refused.
	await writeFile(join(dir, "outside.md"), "# Output\ndone\n");
	await rm(join(tree, "OUTPUT.md"));
	await symlink(join(dir, "outside.md"), join(tree, "OUTPUT.md"));
	await writeFile(join(tree, "docs-ok.md"), "x");
	value = await check();
	assert.match(value.files[0].problem, /symlink/u);
	// No worktree for that run/task, or no writer row: failed, not thrown.
	value = await check(options, { ...context, runId: "other" });
	assert.equal(value.status, "failed");
	assert.match(value.digest, /no managed worktree/u);
	value = await check(options, { ...context, sourceStatuses: [] });
	assert.equal(value.status, "failed");
	// Rehearsal: the worktree is still required, the files are not read.
	process.env.AGENT_WORKFLOW_REHEARSAL = "1";
	try {
		await rm(join(tree, "OUTPUT.md"));
		assert.equal((await check()).status, "passed");
		assert.equal(
			(await check(options, { ...context, runId: "other" })).status,
			"failed",
		);
	} finally {
		delete process.env.AGENT_WORKFLOW_REHEARSAL;
	}
	// Bad options are an authoring error and throw.
	for (const bad of [
		{},
		{ files: [] },
		{ files: [{ path: "../x" }] },
		{ files: [{ path: "/etc/passwd" }] },
		{ files: [{ path: "a\\b" }] },
		{ files: [{ path: "a", markers: [""] }] },
		{ files: [{ path: "a", markers: "x" }] },
	])
		await assert.rejects(helper({ options: bad, context }), /verify:/u);
});

test("rehearse sets AGENT_WORKFLOW_REHEARSAL only while it runs", async () => {
	const dir = await projectFor("write-verify", "wv-env-");
	delete process.env.AGENT_WORKFLOW_REHEARSAL;
	assert.equal((await run(["new", "write-verify", "e"], { cwd: dir })).code, 0);
	assert.equal((await run(["rehearse", "e"], { cwd: dir })).code, 0);
	assert.equal(process.env.AGENT_WORKFLOW_REHEARSAL, undefined);
});

// -------------------------------------------------------------- collect-render

async function historyRepo(commits) {
	const dir = await mkdtemp(join(root, "history-"));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	git(dir, "init", "-q");
	let n = 0;
	for (const message of commits)
		git(
			dir,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			message,
			"--no-gpg-sign",
			`--date=2026-01-01T00:00:0${n++}`,
		);
	return dir;
}

test("collect-render: collect lists non-merge commits newest first, flags breaking ones, honours range and limit", async () => {
	const { helper, bundle } = await withHelper(
		"collect-render",
		"cr",
		"collect-history.mjs",
	);
	const schema = JSON.parse(
		await readFile(join(bundle, "schemas/history.schema.json"), "utf8"),
	);
	const repo = await historyRepo([
		"feat: first",
		"fix(core): second",
		"chore: third\n\nBREAKING CHANGE: gone",
	]);
	git(repo, "tag", "v0", "HEAD~2");
	git(repo, "checkout", "-q", "-b", "side");
	git(repo, "commit", "-q", "--allow-empty", "-m", "feat: side");
	git(repo, "checkout", "-q", "-");
	git(repo, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
	const collect = async (options = {}) => {
		const value = await helper({ options, context: { cwd: repo } });
		assert.deepEqual(validateJsonSchema(value, schema).issues, []);
		return value;
	};
	let value = await collect();
	// Git's own order (newest first, merge commit left out).
	assert.deepEqual(
		value.commits.map((commit) => commit.subject),
		git(repo, "log", "--no-merges", "--format=%s").trim().split("\n"),
	);
	assert.deepEqual(
		value.commits.filter((commit) => commit.breaking).map((c) => c.subject),
		["chore: third"],
	);
	assert.equal(value.total, 4);
	assert.equal(value.truncated, false);
	value = await collect({ range: "v0..HEAD" });
	assert.equal(value.total, 3);
	value = await collect({ maxCommits: 2 });
	assert.equal(value.total, 2);
	assert.equal(value.truncated, true);
	for (const bad of [
		{ maxCommits: 0 },
		{ maxCommits: 501 },
		{ maxCommits: "5" },
		{ range: "--output=/tmp/x" },
		{ range: "a b" },
		{ range: 5 },
	])
		await assert.rejects(
			helper({ options: bad, context: { cwd: repo } }),
			/collect:/u,
			JSON.stringify(bad),
		);
	// An empty repository is an empty list; a non-git directory throws, except under rehearse.
	const empty = await mkdtemp(join(root, "empty-"));
	git(empty, "init", "-q");
	assert.equal(
		(await helper({ options: {}, context: { cwd: empty } })).total,
		0,
	);
	const plain = await mkdtemp(join(root, "plain-"));
	await assert.rejects(
		helper({ options: {}, context: { cwd: plain } }),
		/collect: git log failed/u,
	);
	process.env.AGENT_WORKFLOW_REHEARSAL = "1";
	try {
		assert.equal(
			(await helper({ options: {}, context: { cwd: plain } })).total,
			0,
		);
	} finally {
		delete process.env.AGENT_WORKFLOW_REHEARSAL;
	}
});

test("collect-render: render groups by type, escapes untrusted text and is deterministic", async () => {
	const { helper, bundle } = await withHelper(
		"collect-render",
		"cr2",
		"render-changelog.mjs",
	);
	const schema = JSON.parse(
		await readFile(join(bundle, "schemas/changelog.schema.json"), "utf8"),
	);
	const commit = (sha, subject, breaking = false) => ({
		sha,
		subject,
		breaking,
	});
	const history = {
		total: 7,
		truncated: true,
		commits: [
			commit("a".repeat(40), "feat(ui)!: drop old API"),
			commit("b".repeat(40), "fix: crash on `empty` input"),
			commit("c".repeat(40), "feat: add *bold* [link](x) <b>"),
			commit("d".repeat(40), "docs: readme"),
			commit("e".repeat(40), "Merge-ish free text\n# Injected heading"),
			commit("f".repeat(40), "chore: cleanup", true),
			commit("1".repeat(40), "FIX(Core): upper type"),
		],
	};
	const render = () => helper({ sources: { collect: history } });
	const value = await render();
	assert.deepEqual(validateJsonSchema(value, schema).issues, []);
	assert.deepEqual(value.counts, {
		total: 7,
		Breaking: 2,
		Features: 1,
		Fixes: 2,
		Other: 2,
	});
	assert.equal(value.truncated, true);
	const sections = value.markdown.split(/^## /mu).slice(1);
	assert.deepEqual(
		sections.map((section) => section.split("\n")[0]),
		["Breaking", "Features", "Fixes", "Other"],
	);
	assert.match(sections[0], /\*\*ui:\*\* drop old API \(`aaaaaaa`\)/u);
	assert.match(sections[0], /- cleanup \(`fffffff`\)/u);
	assert.match(sections[3], /- \*\*docs:\*\* readme \(`ddddddd`\)/u);
	assert.match(sections[2], /- \*\*Core:\*\* upper type/u);
	assert.match(value.markdown, /crash on \\`empty\\` input/u);
	assert.ok(value.markdown.includes("add \\*bold\\* \\[link\\](x) \\<b\\>"));
	// A heading smuggled in a subject stays inside one list line.
	assert.equal(/^# Injected/mu.test(value.markdown), false);
	assert.match(value.markdown, /Older commits beyond/u);
	assert.deepEqual(await render(), value);
	// An empty history still renders every section.
	const none = await helper({
		sources: { collect: { total: 0, truncated: false, commits: [] } },
	});
	assert.equal(none.counts.total, 0);
	assert.equal((none.markdown.match(/_None\._/gu) ?? []).length, 4);
	await assert.rejects(helper({ sources: {} }), /no commit list/u);
});

test("collect-render: rehearses clean in a repository with history", async () => {
	const repo = await historyRepo(["feat: alpha", "fix: beta"]);
	assert.equal(
		(await run(["new", "collect-render", "cl"], { cwd: repo })).code,
		0,
	);
	const rehearsed = JSON.parse(
		(await run(["rehearse", "cl", "--json"], { cwd: repo })).out,
	).data;
	assert.deepEqual(rehearsed.findings, []);
});
