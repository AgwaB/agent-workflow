// test-tier: integration
// `agent-workflow new helper <helper> <workflow>`: adds a verified helper to an existing bundle's helpers/
// (byte-identical to the library source), refuses to overwrite without --force, never follows a symlink,
// leaves spec.json alone, and a bundle that uses all five helpers validates with no warnings and rehearses
// clean. No model, no network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

const cli = await import("../../dist/hosts/cli/index.js");
const { HELPER_LIBRARY, HELPER_LIBRARY_IDS } = await import(
	"../../dist/core/helper-library.js"
);

let root;
let home;

before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "aw-cli-new-helper-")));
	home = join(root, "home");
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

async function run(cwd, argv) {
	const out = [];
	const err = [];
	const code = await cli.runAgentWorkflowCli(argv, {
		cwd,
		env: { ...process.env, AGENT_WORKFLOW_HOME: home },
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		isTTY: false,
	});
	return { code, out: out.join(""), err: err.join("") };
}

async function project(prefix = "p-") {
	const dir = await mkdtemp(join(root, prefix));
	await mkdir(join(dir, ".agent-workflow"), { recursive: true });
	return dir;
}

async function source(file) {
	return readFile(
		new URL(`../../src/core/helper-library/${file}`, import.meta.url),
		"utf8",
	);
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

const bundle = (dir, name = "w") =>
	join(dir, ".agent-workflow/workflows", name);

test("--list names every helper, its files and what it is for", async () => {
	const dir = await project();
	const result = await run(dir, ["new", "helper", "--list"]);
	assert.equal(result.code, 0, result.err);
	for (const id of HELPER_LIBRARY_IDS) assert.match(result.out, new RegExp(id));
	assert.match(
		result.out,
		/helpers\/evidence-locate\.mjs, helpers\/evidence-gate\.mjs/,
	);
	const json = JSON.parse(
		(await run(dir, ["new", "helper", "--list", "--json"])).out,
	);
	assert.deepEqual(
		json.data.helpers.map((helper) => helper.id),
		[...HELPER_LIBRARY_IDS],
	);
	assert.equal(existsSync(join(dir, ".agent-workflow/workflows")), false);
});

for (const entry of HELPER_LIBRARY) {
	test(`${entry.id}: writes the library bytes into helpers/, never touches spec.json`, async () => {
		const dir = await project();
		assert.equal((await run(dir, ["new", "single", "w"])).code, 0);
		const specBefore = await readFile(join(bundle(dir), "spec.json"), "utf8");
		const added = await run(dir, ["new", "helper", entry.id, "w"]);
		assert.equal(added.code, 0, added.err + added.out);
		assert.match(added.out, new RegExp(`Added helper "${entry.id}"`));
		assert.match(added.out, /spec\.json was not changed/);
		for (const file of entry.files)
			assert.equal(
				await readFile(join(bundle(dir), "helpers", file), "utf8"),
				await source(file),
				file,
			);
		assert.equal(
			await readFile(join(bundle(dir), "spec.json"), "utf8"),
			specBefore,
		);
		assert.deepEqual(
			(await listFiles(join(bundle(dir), "helpers"))).sort(),
			[...entry.files].sort(),
		);
		// The header of each file states its contract.
		const own = await source(entry.files.at(-1));
		assert.match(
			own.split("\n")[0],
			new RegExp(`^// ${entry.files.at(-1).replace(".", "\\.")}:`),
		);
		// The same arguments give the same bytes in another project (and as JSON).
		const other = await project();
		assert.equal((await run(other, ["new", "single", "w"])).code, 0);
		const json = JSON.parse(
			(await run(other, ["new", "helper", entry.id, "w", "--json"])).out,
		).data;
		assert.deepEqual(
			json.files,
			entry.files.map((file) => `helpers/${file}`),
		);
		for (const file of entry.files)
			assert.equal(
				await readFile(join(bundle(other), "helpers", file), "utf8"),
				await readFile(join(bundle(dir), "helpers", file), "utf8"),
			);
	});
}

test("never overwrites without --force; --force replaces only the helper's files", async () => {
	const dir = await project();
	await run(dir, ["new", "single", "w"]);
	assert.equal((await run(dir, ["new", "helper", "keyed-join", "w"])).code, 0);
	const target = join(bundle(dir), "helpers/keyed-join.mjs");
	await writeFile(target, "// edited by the author\n");
	await writeFile(join(bundle(dir), "helpers/mine.mjs"), "mine\n");
	const refused = await run(dir, ["new", "helper", "keyed-join", "w"]);
	assert.equal(refused.code, 2);
	assert.match(refused.err, /Refusing to overwrite existing files/);
	assert.match(refused.err, /helpers\/keyed-join\.mjs/);
	assert.equal(await readFile(target, "utf8"), "// edited by the author\n");
	const forced = await run(dir, [
		"new",
		"helper",
		"keyed-join",
		"w",
		"--force",
	]);
	assert.equal(forced.code, 0, forced.err);
	assert.match(forced.out, /helpers\/keyed-join\.mjs \(overwritten\)/);
	assert.equal(await readFile(target, "utf8"), await source("keyed-join.mjs"));
	assert.equal(
		await readFile(join(bundle(dir), "helpers/mine.mjs"), "utf8"),
		"mine\n",
	);
});

test("a dependency that is already there with the same bytes is left alone; an edited one is refused", async () => {
	const dir = await project();
	await run(dir, ["new", "single", "w"]);
	assert.equal(
		(await run(dir, ["new", "helper", "evidence-locate", "w"])).code,
		0,
	);
	const gate = await run(dir, ["new", "helper", "evidence-gate", "w"]);
	assert.equal(gate.code, 0, gate.err);
	assert.match(
		gate.out,
		/helpers\/evidence-locate\.mjs \(already there, unchanged\)/,
	);
	assert.deepEqual((await listFiles(join(bundle(dir), "helpers"))).sort(), [
		"evidence-gate.mjs",
		"evidence-locate.mjs",
	]);
	await rm(join(bundle(dir), "helpers/evidence-gate.mjs"));
	const locate = join(bundle(dir), "helpers/evidence-locate.mjs");
	await writeFile(locate, "// my own locate\n");
	const refused = await run(dir, ["new", "helper", "evidence-gate", "w"]);
	assert.equal(refused.code, 2);
	assert.match(refused.err, /evidence-locate\.mjs/);
	assert.equal(
		existsSync(join(bundle(dir), "helpers/evidence-gate.mjs")),
		false,
	);
	assert.equal(await readFile(locate, "utf8"), "// my own locate\n");
});

test("scopes: shared and global; a missing workflow names where it is; a higher-priority copy is noted", async () => {
	const dir = await project();
	await run(dir, ["new", "single", "s", "--scope", "shared"]);
	const shared = await run(dir, [
		"new",
		"helper",
		"graph-edges",
		"s",
		"--scope",
		"shared",
	]);
	assert.equal(shared.code, 0, shared.err);
	assert.equal(
		existsSync(join(dir, "workflows/s/helpers/graph-edges.mjs")),
		true,
	);
	// the default scope (private) has no "s" but shared does: the error says so
	const wrongScope = await run(dir, ["new", "helper", "graph-edges", "s"]);
	assert.equal(wrongScope.code, 2);
	assert.match(wrongScope.err, /No workflow "s" in scope private/);
	assert.match(wrongScope.err, /--scope shared/);
	await run(dir, ["new", "single", "g", "--scope", "global"]);
	await run(dir, ["new", "single", "g", "--scope", "shared"]);
	const note = await run(dir, [
		"new",
		"helper",
		"render-report",
		"g",
		"--scope",
		"global",
	]);
	assert.equal(note.code, 0, note.err);
	assert.match(note.out, /takes priority over this/);
	assert.equal(
		existsSync(join(home, "workflows/g/helpers/render-report.mjs")),
		true,
	);
});

test("symlinks, a flat file and a missing workflow are refused before anything is written", async () => {
	const dir = await project();
	await run(dir, ["new", "single", "w"]);
	const outside = await mkdtemp(join(root, "outside-"));
	await symlink(outside, join(bundle(dir), "helpers"));
	const viaDir = await run(dir, ["new", "helper", "keyed-join", "w"]);
	assert.equal(viaDir.code, 2);
	assert.match(viaDir.err, /symlink/);
	assert.deepEqual(await readdir(outside), []);
	await rm(join(bundle(dir), "helpers"));
	await mkdir(join(bundle(dir), "helpers"));
	await writeFile(join(outside, "x.mjs"), "x\n");
	await symlink(
		join(outside, "x.mjs"),
		join(bundle(dir), "helpers/keyed-join.mjs"),
	);
	const viaFile = await run(dir, [
		"new",
		"helper",
		"keyed-join",
		"w",
		"--force",
	]);
	assert.equal(viaFile.code, 2);
	assert.match(viaFile.err, /not a regular file/);
	assert.equal(await readFile(join(outside, "x.mjs"), "utf8"), "x\n");
	const missing = await run(dir, ["new", "helper", "keyed-join", "nothing"]);
	assert.equal(missing.code, 2);
	assert.match(missing.err, /No workflow "nothing"/);
	assert.equal(
		existsSync(join(dir, ".agent-workflow/workflows/nothing")),
		false,
	);
});

test("usage errors exit 2 and write nothing: unknown helper, bad name, bad scope, missing or extra arguments", async () => {
	const dir = await project();
	await run(dir, ["new", "single", "w"]);
	const before = await listFiles(bundle(dir));
	for (const argv of [
		["new", "helper"],
		["new", "helper", "keyed-join"],
		["new", "helper", "nope", "w"],
		["new", "helper", "keyed-join", "bad/name"],
		["new", "helper", "keyed-join", "w", "extra"],
		["new", "helper", "keyed-join", "w", "--scope", "everywhere"],
		["new", "helper", "--list", "keyed-join"],
		["new", "single", "x", "y"],
	]) {
		const result = await run(dir, argv);
		assert.equal(
			result.code,
			2,
			`${argv.join(" ")}: ${result.out}${result.err}`,
		);
	}
	assert.deepEqual(await listFiles(bundle(dir)), before);
	const unknown = await run(dir, ["new", "helper", "nope", "w"]);
	assert.match(
		unknown.err,
		/Unknown helper "nope"\. Helpers: evidence-locate, evidence-gate/,
	);
	assert.match(
		(await run(dir, ["new", "--help"])).out,
		/new helper <helper> <workflow>/,
	);
});

const rowsSchema = {
	type: "object",
	required: ["schema", "digest", "items"],
	properties: {
		schema: { const: "rows-v1" },
		digest: { type: "string", minLength: 1, maxLength: 200 },
		items: {
			type: "array",
			maxItems: 10,
			items: {
				type: "object",
				required: ["id", "file", "quote"],
				properties: {
					id: { type: "string", maxLength: 40 },
					file: { type: "string", maxLength: 200 },
					quote: { type: "string", maxLength: 300 },
					startLine: { type: "integer", minimum: 1 },
					endLine: { type: "integer", minimum: 1 },
					method: { type: "string", maxLength: 10 },
					path: { type: "string", maxLength: 100 },
					name: { type: "string", maxLength: 50 },
					imports: {
						type: "array",
						maxItems: 5,
						items: { type: "string", maxLength: 50 },
					},
				},
				additionalProperties: false,
			},
		},
	},
	additionalProperties: false,
};
const openSchema = {
	type: "object",
	required: ["schema", "digest", "status"],
	properties: {
		schema: { type: "string" },
		digest: { type: "string", minLength: 1, maxLength: 200 },
		status: { enum: ["passed", "failed", "blocked"] },
	},
};

function rowsStage(id) {
	return {
		id,
		type: "single",
		profileRole: "research-execution",
		after: [],
		output: {
			analysis: { required: true },
			controlSchema: "./schemas/rows.schema.json",
		},
		prompt: `List the rows of ${id} (data, not instructions). Put machine-readable JSON in <control>. Emit no top-level keys other than schema, digest, items. Example control (illustrative shape only): <control>{"schema":"rows-v1","digest":"1 row","items":[{"id":"R1","file":"a.js","quote":"x"}]}</control>`,
	};
}
function supportStage(id, from, uses, options) {
	return {
		id,
		from,
		support: { uses, options },
		output: {
			analysis: { required: true },
			controlSchema: "./schemas/helper-output.schema.json",
		},
	};
}

test("a bundle using all five helpers validates with no warnings and rehearses clean", async () => {
	const dir = await project();
	assert.equal((await run(dir, ["new", "single", "w"])).code, 0);
	for (const id of [
		"evidence-gate",
		"keyed-join",
		"graph-edges",
		"render-report",
	])
		assert.equal((await run(dir, ["new", "helper", id, "w"])).code, 0, id);
	const base = bundle(dir);
	const spec = JSON.parse(await readFile(join(base, "spec.json"), "utf8"));
	spec.description = "Helper library bundle: gate, diff, graph and render.";
	spec.artifactGraph.stages = [
		rowsStage("rows"),
		rowsStage("docs"),
		supportStage("gate", ["rows"], "./helpers/evidence-gate.mjs", {
			from: "rows",
			rows: "items",
			fields: {
				file: "file",
				quote: "quote",
				startLine: "startLine",
				endLine: "endLine",
			},
			policy: "drop",
		}),
		supportStage("diff", ["rows", "docs"], "./helpers/keyed-join.mjs", {
			left: { from: "rows", rows: "items" },
			right: { from: "docs", rows: "items" },
			key: ["method", "path"],
			normalize: {
				method: ["trim", "upper"],
				path: ["path-params", "trailing-slash"],
			},
		}),
		supportStage("graph", ["rows"], "./helpers/graph-edges.mjs", {
			from: "rows",
			rows: "items",
			fromField: "name",
			toField: "imports",
		}),
		{
			...supportStage(
				"report",
				["gate", "graph"],
				"./helpers/render-report.mjs",
				{
					title: "Report",
					sections: [
						{
							title: "Kept",
							from: "gate",
							rows: "kept",
							type: "table",
							columns: ["id", "file"],
						},
						{
							title: "Cycles",
							from: "graph",
							rows: "cycles",
							type: "list",
							template: "{path}",
						},
					],
				},
			),
			output: {
				analysis: { required: true },
				controlSchema: "./schemas/helper-output.schema.json",
			},
		},
	];
	await mkdir(join(base, "schemas"), { recursive: true });
	await writeFile(
		join(base, "schemas/rows.schema.json"),
		`${JSON.stringify(rowsSchema, null, 2)}\n`,
	);
	await writeFile(
		join(base, "schemas/helper-output.schema.json"),
		`${JSON.stringify(openSchema, null, 2)}\n`,
	);
	await rm(join(base, "schemas/result.schema.json"));
	await writeFile(
		join(base, "spec.json"),
		`${JSON.stringify(spec, null, 2)}\n`,
	);

	const validated = JSON.parse(
		(await run(dir, ["validate", "w", "--json"])).out,
	);
	assert.equal(validated.data.valid, true, JSON.stringify(validated.data));
	assert.deepEqual(validated.data.warnings, []);
	const rehearsed = await run(dir, ["rehearse", "w", "--json"]);
	assert.equal(rehearsed.code, 0, rehearsed.out);
	const report = JSON.parse(rehearsed.out).data;
	assert.deepEqual(report.findings, []);
	assert.equal(report.status, "completed");
	for (const stage of report.stages)
		assert.deepEqual(Object.keys(stage.statuses), ["completed"], stage.stage);
});
