// Pi host packages are optional peers loaded lazily; builds and tests do not require them.
// Unused Pi packages must not appear as dependencies or bundles.
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
