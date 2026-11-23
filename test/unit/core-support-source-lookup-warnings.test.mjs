import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../dist/core/compiler.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";

// Static check (validate/compile) for support helpers that look up a source their stage cannot receive.
// It reads the helper text for literal lookups only; the helper itself runs exactly as in the engine.

const DEFAULTS = { agent: "scout", readOnly: true, tools: ["read"] };

async function warningsFor(body, stagesFor, file = "lookup.mjs") {
	const cwd = await mkdtemp(join(tmpdir(), "aw-support-lookup-"));
	try {
		await mkdir(join(cwd, "helpers"), { recursive: true });
		await writeFile(join(cwd, "helpers", file), body);
		const specPath = join(cwd, "spec.json");
		await writeFile(
			specPath,
			JSON.stringify({
				schemaVersion: 1,
				defaults: DEFAULTS,
				artifactGraph: {
					stages: stagesFor ?? [
						{ id: "a", type: "single", prompt: "Do a." },
						{ id: "g", from: "a", support: { uses: `./helpers/${file}` } },
						{ id: "c", type: "reduce", from: ["g"], prompt: "Do c." },
					],
				},
			}),
		);
		const loaded = await loadWorkflowSpec(specPath, cwd);
		const compiled = await compileWorkflow(loaded.spec, {
			cwd,
			specPath: loaded.specPath,
		});
		return compiled.warnings.filter((w) => /looks up source/u.test(w));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const wrap = (code) =>
	`export default async function ({ sources }) { ${code} return { schema: "g-v1", status: "passed", digest: "ok" }; }\n`;

test("a literal lookup of a name the stage cannot receive warns, naming stage, name and sources", async () => {
	const found = await warningsFor(wrap("const row = sources.wrongName;"));
	assert.equal(found.length, 1, found.join("\n"));
	assert.match(found[0], /stage "g"/u);
	assert.match(found[0], /"wrongName"/u);
	assert.match(found[0], /\(a\)/u);
});

test("bracket, hasOwn, in and destructuring lookups are all recognised", async () => {
	for (const code of [
		'const row = sources["wrongName"];',
		"const row = sources['wrongName'];",
		'if (!Object.hasOwn(sources, "wrongName")) return { status: "blocked" };',
		'if (!("wrongName" in sources)) return { status: "blocked" };',
		"const { wrongName } = sources;",
		"const { wrongName: row } = sources;",
	]) {
		const found = await warningsFor(wrap(code));
		assert.equal(found.length, 1, `${code}: ${found.join("\n")}`);
		assert.match(found[0], /"wrongName"/u);
	}
});

test("an argument destructuring of a sources property is recognised", async () => {
	const found = await warningsFor(
		"export default async function ({ sources: { wrongName } }) { return { schema: 'g-v1', status: 'passed', digest: String(wrongName) }; }\n",
	);
	assert.equal(found.length, 1, found.join("\n"));
});

test("declared sources, writes, structuredClone and own-property methods do not warn", async () => {
	const found = await warningsFor(
		wrap(
			'const copy = structuredClone(sources); sources.derived = {}; const d = sources.derived; const row = sources.a; const copy2 = { ...sources }; if (Object.keys(sources).length > 1 || sources.hasOwnProperty("a") || String(sources)) copy.x = 1; const {a} = sources; // sources.commented\n /* sources["blockCommented"] */ const s = "sources.inString";',
		),
	);
	assert.deepEqual(found, []);
});

test("computed and template keys are skipped", async () => {
	const found = await warningsFor(
		wrap(
			"const key = process.argv[2]; const x = sources[key]; const y = sources[`t${key}`]; const z = Object.hasOwn(sources, key);",
		),
	);
	assert.deepEqual(found, []);
});

test("a helper that rebinds its own `sources` is not judged", async () => {
	const found = await warningsFor(
		"export default async function () { const sources = [1]; return { schema: 'g-v1', status: 'passed', digest: String(sources.length) + sources.wrongName }; }\n",
	);
	assert.deepEqual(found, []);
});

test("foreach item keys, nested stage names and `after` sources are not false warnings", async () => {
	const stages = [
		{ id: "plan", type: "single", prompt: "Plan." },
		{
			id: "each",
			type: "foreach",
			from: { source: "plan", path: "$.items" },
			each: { prompt: "Do ${item}." },
		},
		{
			id: "g",
			from: "each",
			after: "plan",
			support: { uses: "./helpers/lookup.mjs" },
		},
	];
	const found = await warningsFor(
		wrap(
			'const first = sources.each; const item = sources["each.one"]; const item2 = sources["each.item"]; const p = sources.plan;',
		),
		stages,
	).catch((error) => {
		// the foreach spec needs a control schema for its path; keep the fixture honest
		throw error;
	});
	assert.deepEqual(found, []);
});

test("an implicitly chained support stage receives the previous stage", async () => {
	const stages = [
		{ id: "a", type: "single", prompt: "Do a." },
		{ id: "g", support: { uses: "./helpers/lookup.mjs" } },
	];
	assert.deepEqual(await warningsFor(wrap("const r = sources.a;"), stages), []);
	assert.equal(
		(await warningsFor(wrap("const r = sources.b;"), stages)).length,
		1,
	);
});

test("a missing or unreadable helper file adds no warning", async () => {
	const found = await warningsFor(wrap("const r = sources.zzz;"), [
		{ id: "a", type: "single", prompt: "Do a." },
		{ id: "g", from: "a", support: { uses: "./helpers/absent.mjs" } },
	]);
	assert.deepEqual(found, []);
});

// ---- round 4 (R4-1, R4-2): precise, advisory; decline when unsure ----

test("R4-1: a field check on a declared source is not a lookup", async () => {
	for (const code of [
		'if (!("digest" in sources.a)) throw new Error("missing digest");',
		'if (!("digest" in sources?.a)) throw new Error("missing digest");',
		'if (!("digest" in sources["a"])) throw new Error("missing digest");',
		'if (!Object.hasOwn(sources.a, "digest")) throw new Error("missing digest");',
	])
		assert.deepEqual(await warningsFor(wrap(code)), [], code);
	// the real lookups stay red
	for (const code of [
		'if (!("wrongName" in sources)) throw new Error("x");',
		'if (!Object.hasOwn(sources, "wrongName")) throw new Error("x");',
		"const row = sources.wrongName;",
	])
		assert.equal((await warningsFor(wrap(code))).length, 1, code);
});

test("R4-1: an object literal that builds { sources: { … } } is construction, not destructuring", async () => {
	for (const code of [
		"const options = { sources: { mode: 'local' } };",
		"const call = [{ sources: { mode: 'local' }, task: 1 }];",
		"const nested = JSON.stringify({ sources: { mode: 'local' } });",
	])
		assert.deepEqual(await warningsFor(wrap(code)), [], code);
});

test("R4-1: regular-expression literals, strings and comments are not code", async () => {
	for (const code of [
		"const re = /sources.foo/u; const ok = re.test('x');",
		"const parts = 'a/b'.split(/sources\\.foo|sources[\"bar\"]/);",
		"const n = 10 / 2; const m = n / 5; // sources.afterDivision",
		"const text = 'sources.inString'; /* sources.block */",
		"const t = `sources.inTemplateText`;",
	])
		assert.deepEqual(await warningsFor(wrap(code)), [], code);
});

test("R4-2: a parameter default on the destructured `sources` is not a rebinding", async () => {
	for (const [signature, body] of [
		["{ sources = {} }", "const row = sources.wrongName;"],
		[
			"{ sources = {}, task }",
			'const has = Object.hasOwn(sources, "wrongName");',
		],
		["{ task, sources = {} }", 'const has = "wrongName" in sources;'],
	]) {
		const found = await warningsFor(
			`export default async function (${signature}) { ${body} return { schema: 'g-v1', status: 'passed', digest: 'ok' }; }\n`,
		);
		assert.equal(found.length, 1, `${signature}: ${found.join("\n")}`);
		assert.match(found[0], /"wrongName"/u);
	}
	// a real reassignment is still not judged
	assert.deepEqual(
		await warningsFor(
			wrap("sources = { other: 1 }; const row = sources.wrongName;"),
		),
		[],
	);
});

test("R4-2: expressions inside a template literal are scanned, its text is not", async () => {
	const found = await warningsFor(
		wrap("const message = `missing: ${sources.wrongName} sources.textOnly`;"),
	);
	assert.equal(found.length, 1, found.join("\n"));
	assert.match(found[0], /"wrongName"/u);
	assert.deepEqual(
		await warningsFor(wrap("const m = `fine: ${sources.a} and ${1 + 2}`;")),
		[],
	);
	assert.equal(
		(
			await warningsFor(
				wrap("const m = `outer ${`inner ${sources.wrongName}`}`;"),
			)
		).length,
		1,
	);
});

test("R4-1: parameter and declaration patterns naming a wrong source are still recognised", async () => {
	for (const body of [
		"export default async ({ sources: { wrongName } }) => ({ schema: 'g-v1', status: 'passed', digest: String(wrongName) });\n",
		"export default async function ({ task, sources: { wrongName } = {} }) { return { schema: 'g-v1', status: 'passed', digest: String(wrongName) }; }\n",
		"export default async function (input) { const { sources: { wrongName } } = input; return { schema: 'g-v1', status: 'passed', digest: String(wrongName) }; }\n",
	]) {
		const found = await warningsFor(body);
		assert.equal(found.length, 1, `${body}: ${found.join("\n")}`);
	}
});
