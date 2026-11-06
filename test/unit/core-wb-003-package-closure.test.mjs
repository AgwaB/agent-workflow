import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRegistryFreeValidationOnly } from "../../tools/release/release-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
