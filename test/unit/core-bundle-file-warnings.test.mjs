import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileWorkflow } from "../../dist/core/compiler.js";
import { loadWorkflowSpec } from "../../dist/core/schema.js";

const spec = (stages) => ({
	schemaVersion: 1,
	defaults: { agent: "scout" },
	artifactGraph: { stages },
});
const dump = JSON.stringify;

test("only bundle specs report unreachable assets, following alternate specs and transitive imports", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "aw-bundle-orphans-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const stage = {
		id: "main",
		output: { controlSchema: "./schemas/main.json" },
		support: { uses: "./helpers/main.mjs" },
	};
	const schema = '{"type":"object"}';
	for (const [name, text] of Object.entries({
		"spec.json": dump(spec([stage])),
		"flat.json": dump(spec([stage])),
		"alternate.spec.json": dump(
			spec([{ ...stage, support: { uses: "./helpers/alternate.mjs" } }]),
		),
		"helpers/main.mjs": `import { read } from './reader.mjs'; // import './orphan.mjs'\nconst s = "import './orphan.mjs'";\nconst f = () => import('./literal.mjs');\nconst g = () => import('./orphan.mjs' + s);\nexport default read;`,
		"helpers/reader.mjs": `export { read } from '../lib/transitive.mjs';`,
		"lib/transitive.mjs": `import '../helpers/main.mjs';\nimport data from '../schemas/imported.json' with { type: 'json' };\nexport const read = () => data;`,
		"helpers/alternate.mjs": "export default () => ({});",
		"helpers/literal.mjs": "export default () => ({});",
		"helpers/orphan.mjs": "export default () => ({});",
		"schemas/main.json": schema,
		"schemas/imported.json": schema,
		"schemas/orphan.json": schema,
	})) {
		const path = join(cwd, "bundle", name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	}
	const warnings = async (name) => {
		const { spec, specPath } = await loadWorkflowSpec(
			join(cwd, "bundle", name),
			cwd,
		);
		return (await compileWorkflow(spec, { cwd, specPath })).warnings.filter(
			(warning) => warning.includes("orphaned bundle"),
		);
	};
	const [warning, ...others] = await warnings("spec.json");
	assert.deepEqual(others, []);
	assert.match(
		warning,
		/"helpers\/orphan.mjs", "schemas\/orphan.json"\. No spec reference/,
	);
	assert.match(warning, /computed import\(\) paths and fs reads are invisible/);
	assert.deepEqual(await warnings("flat.json"), []);
});
