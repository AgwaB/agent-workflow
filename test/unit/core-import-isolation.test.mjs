// New in agent-workflow (WP4a acceptance, extended in WP4b and WP4c): every compiled core module imports
// with plain node from a temp copy of dist/ that has no node_modules anywhere on
// its resolution path, so src/core carries no hidden runtime dependency.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const distCore = join(root, "dist", "core");
const PI_SCOPE = ["@earendil", "works"].join("-");

function coreModules() {
	return readdirSync(distCore)
		.filter((name) => name.endsWith(".js"))
		.sort();
}

test("dist/core has exactly one module per src/core/*.ts and no type bridge", () => {
	// WP4b: the WP4a hard-coded count became the src/core listing, so the
	// isolation checks below cover every ported and replacement module.
	const expected = readdirSync(join(root, "src", "core"))
		.filter((name) => name.endsWith(".ts"))
		.map((name) => name.replace(/\.ts$/, ".js"))
		.sort();
	const modules = coreModules();
	assert.deepEqual(modules, expected);
	assert.ok(modules.includes("index.js"));
	assert.ok(modules.includes("dynamic-runtime-bundle.js"));
	assert.equal(modules.includes("types-bridge.js"), false);
	assert.equal(existsSync(join(root, "src", "core", "types-bridge.ts")), false);
});

test("dist/core modules import only node builtins and sibling core modules", () => {
	for (const name of coreModules()) {
		const text = readFileSync(join(distCore, name), "utf8");
		assert.equal(
			text.includes(PI_SCOPE),
			false,
			`${name} mentions ${PI_SCOPE}`,
		);
		for (const match of text.matchAll(
			/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
		)) {
			const specifier = match[1] ?? match[2];
			// WP4c: core also imports the in-repo SDK and runtime (both Pi-free and
			// part of the same dist/ tree; the temp-copy import below covers them).
			assert.ok(
				specifier.startsWith("node:") ||
					/^\.\/[a-z0-9-]+\.js$/.test(specifier) ||
					/^\.\.\/(sdk|runtime)\/[a-z0-9/-]+\.js$/.test(specifier) ||
					// Built-in executor identity only (never the adapter itself).
					/^\.\.\/executors\/[a-z0-9-]+\/version\.js$/.test(specifier),
				`${name} imports ${specifier}`,
			);
		}
	}
});

test("every dist/core/*.js imports in a child process from a temp dist/ copy without node_modules", async () => {
	const modules = coreModules();
	const temp = await realpath(
		await mkdtemp(join(tmpdir(), "agent-workflow-core-isolation-")),
	);
	try {
		await cp(join(root, "dist"), join(temp, "dist"), { recursive: true });
		// Only marks the copy as ESM; declares no dependencies.
		await writeFile(
			join(temp, "package.json"),
			`${JSON.stringify({ name: "core-isolation", private: true, type: "module" })}\n`,
		);
		for (let dir = temp; ; dir = dirname(dir)) {
			assert.equal(
				existsSync(join(dir, "node_modules")),
				false,
				`unexpected node_modules at ${dir}`,
			);
			if (dirname(dir) === dir) break;
		}
		const script = [
			`const names = ${JSON.stringify(modules)};`,
			"const loaded = [];",
			"for (const name of names) {",
			"  const mod = await import(`./dist/core/${name}`);",
			"  loaded.push([name, Object.keys(mod).length]);",
			"}",
			"process.stdout.write(JSON.stringify(loaded));",
		].join("\n");
		const env = { ...process.env, NODE_PATH: "" };
		delete env.NODE_OPTIONS;
		const { stdout } = await execFileAsync(
			process.execPath,
			["--input-type=module", "-e", script],
			{ cwd: temp, env, encoding: "utf8" },
		);
		const loaded = JSON.parse(stdout);
		assert.deepEqual(
			loaded.map(([name]) => name),
			modules,
		);
		// Type-only modules compile to empty ES modules.
		const typeOnly = new Set(["dynamic-loop-types.js"]);
		for (const [name, exportCount] of loaded) {
			if (typeOnly.has(name)) assert.equal(exportCount, 0, name);
			else assert.ok(exportCount > 0, `${name} has no runtime exports`);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
