import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const dist = join(root, "dist");
// Built from parts so this test file itself does not match a repository-wide grep for the scope.
const PI_SCOPE = ["@earendil", "works"].join("-");

const entries = [
	["dist/index.js", "src"],
	["dist/core/index.js", "src/core"],
	["dist/sdk/index.js", "src/sdk"],
	["dist/runtime/index.js", "src/runtime"],
	["dist/executors/pi/index.js", "src/executors/pi"],
	["dist/executors/codex/index.js", "src/executors/codex"],
	["dist/executors/claude/index.js", "src/executors/claude"],
	["dist/executors/acp/index.js", "src/executors/acp"],
	["dist/mcp/artifact-server/index.js", "src/mcp/artifact-server"],
	["dist/hosts/cli/index.js", "src/hosts/cli"],
	["dist/hosts/pi/index.js", "src/hosts/pi"],
];

// WP11b: `./hosts/pi` is a Pi extension; without the optional Pi peer its import fails with
// PiHostUnavailableError by design (covered in host-pi-extension.test.mjs).
const piAvailable = await import(
	["@earendil-works", "pi-coding-agent"].join("/")
).then(
	() => true,
	() => false,
);
const needsPi = (path) => path.includes("hosts/pi/");

for (const [path, expected] of entries) {
	test(`${path} exports MODULE = ${expected}`, async () => {
		if (needsPi(path) && !piAvailable) {
			await assert.rejects(
				import(new URL(`../../${path}`, import.meta.url).href),
				{ name: "PiHostUnavailableError" },
			);
			return;
		}
		const mod = await import(new URL(`../../${path}`, import.meta.url).href);
		assert.equal(mod.MODULE, expected);
	});
}

test("package exports resolve to built entry points", async () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const subpaths = [
		".",
		"./sdk",
		"./runtime",
		"./executors/pi",
		"./executors/codex",
		"./executors/claude",
		"./executors/acp",
		"./hosts/cli",
		"./hosts/pi",
	];
	for (const subpath of subpaths) {
		const target = pkg.exports[subpath]?.default;
		assert.ok(target, `missing export ${subpath}`);
		if (needsPi(target) && !piAvailable) continue;
		const mod = await import(
			new URL(`../../${target.replace(/^\.\//, "")}`, import.meta.url).href
		);
		assert.equal(typeof mod.MODULE, "string", subpath);
	}
});

test("built Pi-free entry points do not reference the Pi package scope", () => {
	const piScoped = [
		join(dist, "executors", "pi") + sep,
		join(dist, "hosts", "pi") + sep,
	];
	const offenders = listFiles(dist)
		.filter((file) => !piScoped.some((prefix) => file.startsWith(prefix)))
		.filter((file) => readFileSync(file, "utf8").includes(PI_SCOPE))
		.map((file) => relative(root, file));
	assert.deepEqual(offenders, []);
});

function listFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}
