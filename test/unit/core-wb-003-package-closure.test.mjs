import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRegistryFreeValidationOnly } from "../../tools/release/release-policy.mjs";
import { assertPackedTypeScriptClosure } from "../../tools/release/typescript-package-closure.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = join(root, "test", "fixtures", "core", "package-closure");
const completeFixtureFiles = [
	"cycle/a.ts",
	"cycle/b.ts",
	"extract.ts",
	"feature/index.ts",
	"index.ts",
	"required.ts",
	"storage.ts",
	"types.ts",
];
const completeJsBridgeFixtureFiles = [
	"bridge.cjs",
	"bridge.js",
	"bridge.json",
	"bridge.jsx",
	"bridge.mjs",
	"js-bridge.ts",
];

test("WB-003 TypeScript closure follows type imports, re-exports, dynamic imports, require, index resolution, and cycles", () => {
	const result = assertPackedTypeScriptClosure({
		packageRoot: join(fixtureRoot, "package"),
		entryPaths: ["index.ts", "storage.ts"],
		packedPaths: completeFixtureFiles,
	});
	assert.deepEqual(result.files, completeFixtureFiles);
	assert.deepEqual(
		new Set(result.edges.map((edge) => edge.kind)),
		new Set(["import", "export", "dynamic-import", "require"]),
	);
	assert.ok(
		result.edges.some(
			(edge) =>
				edge.specifier === "./feature" && edge.to === "feature/index.ts",
		),
	);
});

test("WB-003 package closure traverses complete JS, JSX, MJS, and CJS bridges", () => {
	const result = assertPackedTypeScriptClosure({
		packageRoot: join(fixtureRoot, "package"),
		entryPaths: ["js-bridge.ts"],
		packedPaths: completeJsBridgeFixtureFiles,
	});
	assert.deepEqual(result.files, completeJsBridgeFixtureFiles);
	assert.deepEqual(
		result.edges.map((edge) => `${edge.from} -> ${edge.to}`),
		[
			"bridge.cjs -> bridge.json",
			"bridge.js -> bridge.jsx",
			"bridge.jsx -> bridge.mjs",
			"bridge.mjs -> bridge.cjs",
			"js-bridge.ts -> bridge.js",
		],
	);
});

test("WB-003 package closure reports an omitted transitive JS bridge deterministically", () => {
	const packedPaths = JSON.parse(
		readFileSync(
			join(fixtureRoot, "packed-js-bridge-without-transitive.json"),
			"utf8",
		),
	);
	const invoke = () =>
		assertPackedTypeScriptClosure({
			packageRoot: join(fixtureRoot, "package"),
			entryPaths: ["js-bridge.ts"],
			packedPaths,
		});
	const expected =
		'Packed TypeScript closure is incomplete:\n- bridge.mjs -> "./bridge.cjs": packed target is missing (bridge.cjs)';
	assert.throws(invoke, (error) => error.message === expected);
	assert.throws(invoke, (error) => error.message === expected);
});

test("WB-003 TypeScript closure reports omitted dynamic extract target deterministically", () => {
	const packedPaths = JSON.parse(
		readFileSync(
			join(fixtureRoot, "packed-without-dynamic-extract.json"),
			"utf8",
		),
	);
	const invoke = () =>
		assertPackedTypeScriptClosure({
			packageRoot: join(fixtureRoot, "package"),
			entryPaths: ["index.ts", "storage.ts"],
			packedPaths,
		});
	const expected =
		'Packed TypeScript closure is incomplete:\n- index.ts -> "./extract.ts": packed target is missing (extract.ts)';
	assert.throws(invoke, (error) => error.message === expected);
	assert.throws(invoke, (error) => error.message === expected);
});

test("WB-003 TypeScript closure rejects package-root escapes", () => {
	assert.throws(
		() =>
			assertPackedTypeScriptClosure({
				packageRoot: join(fixtureRoot, "escape-package"),
				entryPaths: ["index.ts"],
				packedPaths: ["index.ts"],
			}),
		(error) =>
			error.message ===
			'Packed TypeScript closure is incomplete:\n- index.ts -> "../outside.ts": package root escape',
	);
});

test("WB-003 required E2E inventory is no-install, isolated, instrumented, and release-check retained", () => {
	const strip = (source) =>
		source
			.split("\n")
			.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
			.join("\n");
	const runner = readFileSync(join(root, "test", "e2e", "run.mjs"), "utf8");
	const packedInstall = readFileSync(
		join(root, "test", "e2e", "cases", "packed-install.mjs"),
		"utf8",
	);
	const releaseCheck = readFileSync(
		join(root, "tools", "release", "release-check.mjs"),
		"utf8",
	);
	const packageInstallPattern = new RegExp(
		`(?:npm\\s+(?:${["inst", "all"].join("")}|ci|add)|pnpm\\s+(?:${["inst", "all"].join("")}|add)|yarn\\s+(?:${["inst", "all"].join("")}|add))`,
		"i",
	);
	for (const [name, source] of [
		["E2E runner", runner],
		["packed install", packedInstall],
		["release check", releaseCheck],
	]) {
		assert.doesNotMatch(strip(source), packageInstallPattern, name);
	}
	assert.doesNotMatch(
		runner,
		new RegExp(["consumer", "install", "cli"].join("-")),
	);
	assert.match(runner, /packed-install/);
	assert.match(runner, /packed-cli-run/);
	assert.match(runner, /packed-durable-barrier-v2/);
	assert.match(runner, /AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS/);
	assert.match(runner, /PI_CODING_AGENT_DIR/);
	assert.match(runner, /XDG_CONFIG_HOME/);
	assert.match(runner, /blocked-command.*network-attempt/s);
	assert.match(runner, /an agent CLI was started/);
	assert.match(releaseCheck, /run\("npm", \["run", "e2e"\]\)/);
	assert.match(
		releaseCheck,
		/"publish",\s*"--dry-run",\s*"--access",\s*"public",\s*"--registry",\s*NPM_REGISTRY,\s*"--tag",\s*NPM_DIST_TAG,/,
	);
});

test("WB-003 registry-free validation mode is limited to the exact approved environment", () => {
	assert.equal(
		isRegistryFreeValidationOnly({
			AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1",
			GITHUB_ACTIONS: "true",
		}),
		true,
	);
	for (const env of [
		{},
		{ AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1" },
		{ GITHUB_ACTIONS: "true" },
		{
			AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION: "true",
			GITHUB_ACTIONS: "true",
		},
		{
			AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION: "1",
			GITHUB_ACTIONS: "1",
		},
	]) {
		assert.equal(isRegistryFreeValidationOnly(env), false);
	}
	const source = readFileSync(
		join(root, "tools", "release", "release-check.mjs"),
		"utf8",
	);
	assert.match(source, /registryFreeValidationOnly/);
	assert.match(source, /Skipping npm view/);
	assert.match(source, /Skipping npm publish --dry-run/);
	assert.match(source, /Skipping npm whoami/);
});
