// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/unit/host-package-policy.test.mjs. MIT, same
// author. Changes: agent-workflow lists the Pi host packages it may import at runtime
// (@earendil-works/pi-ai, pi-coding-agent, pi-tui) as optional wildcard peers and does not need them
// to build or test (the Pi host and executor load them lazily from the user's Pi), so the
// "devDependency" half is replaced by "optional peer"; pi-agent-core and typebox are not used by
// agent-workflow and must not appear as dependencies or bundles either. The lockfile half also
// compares peerDependenciesMeta.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const lock = JSON.parse(
	readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);
const hostPackages = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];
const peerPackages = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

test("host-provided packages are wildcard peers, never runtime dependencies or bundles", () => {
	for (const name of hostPackages) {
		assert.equal(Object.hasOwn(manifest.dependencies ?? {}, name), false, name);
		assert.equal(
			Object.hasOwn(manifest.optionalDependencies ?? {}, name),
			false,
			name,
		);
		assert.equal(
			(
				manifest.bundleDependencies ??
				manifest.bundledDependencies ??
				[]
			).includes(name),
			false,
			name,
		);
	}
	for (const name of peerPackages) {
		assert.equal(manifest.peerDependencies?.[name], "*", name);
		assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, name);
	}
});

test("manifest and lockfile retain matching dependency declarations and version", () => {
	const root = lock.packages[""];
	assert.equal(lock.version, manifest.version);
	assert.equal(root.version, manifest.version);
	for (const key of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
	]) {
		assert.deepEqual(root[key] ?? {}, manifest[key] ?? {}, key);
	}
});
