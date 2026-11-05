#!/usr/bin/env node
//
//   node test/e2e/cases/packed-install.mjs <installed-package-root> <consumer-project>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRootArg, consumerArg] = process.argv.slice(2);
if (!packageRootArg || !consumerArg)
	throw new Error(
		"usage: packed-install.mjs <installed-package-root> <consumer-project>",
	);
const packageRoot = await realpath(packageRootArg);
const consumer = resolve(consumerArg);
const consumerRequire = createRequire(join(consumer, "package.json"));
const PI_SCOPE = ["@earendil", "works"].join("-");

// The consumer resolves the package to the unpacked tarball, and nothing Pi is resolvable.
assert.equal(
	await realpath(consumerRequire.resolve("@agwab/agent-workflow/package.json")),
	join(packageRoot, "package.json"),
);
for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"])
	assert.throws(
		() => consumerRequire.resolve(`${PI_SCOPE}/${name}`),
		{ code: "MODULE_NOT_FOUND" },
		`${PI_SCOPE}/${name} must not be resolvable from the consumer`,
	);
const manifest = JSON.parse(
	await readFile(join(packageRoot, "package.json"), "utf8"),
);
assert.deepEqual(manifest.dependencies ?? {}, {}, "no runtime dependencies");

// Every Pi-free entry point loads in a process without Pi.
const piFreeEntries = Object.keys(manifest.exports)
	.filter((key) => key !== "./package.json" && key !== "./hosts/pi")
	.map((key) => `@agwab/agent-workflow${key.slice(1)}`);
for (const specifier of piFreeEntries) {
	const loaded = await import(
		pathToFileURL(consumerRequire.resolve(specifier)).href
	);
	assert.ok(Object.keys(loaded).length > 0, `${specifier} exports nothing`);
}
const sdk = await import(
	pathToFileURL(consumerRequire.resolve("@agwab/agent-workflow/sdk")).href
);
assert.equal(sdk.EXECUTOR_CONTRACT_VERSION, "0.1.0");
assert.equal(sdk.ENGINE_DEFAULT_PERMISSION_MODE, "free");
assert.equal(sdk.SDK_DEFAULT_PERMISSION_MODE, "safe");

// The Pi host refuses to load without Pi, with its named error.
await assert.rejects(
	import(
		pathToFileURL(consumerRequire.resolve("@agwab/agent-workflow/hosts/pi"))
			.href
	),
	(error) =>
		/Pi extension and needs the Pi coding agent/u.test(String(error?.message)),
);

// The bin.
const bin = join(consumer, "node_modules", ".bin", "agent-workflow");
const aw = (args) =>
	execFileSync(bin, args, {
		cwd: consumer,
		encoding: "utf8",
		env: process.env,
		maxBuffer: 16 * 1024 * 1024,
	});
assert.match(aw(["--help"]), /Usage: agent-workflow <command>/u);
assert.equal(aw(["--version"]).trim(), manifest.version);

// Bundled workflows: listed from the package root, resolvable, valid, compilable.
const officialNames = [
	"deep-research",
	"deep-review",
	"impact-review",
	"spec-review",
];
const listed = JSON.parse(aw(["list", "--json"])).data.workflows;
for (const name of officialNames) {
	const row = listed.find((item) => item.name === name);
	assert.ok(row, `bundled ${name} is listed`);
	assert.equal(
		await realpath(row.specPath),
		join(packageRoot, "workflows", name, "spec.json"),
	);
	assert.match(aw(["validate", name]), /^Workflow spec valid: /u);
}

const api = await import(
	pathToFileURL(consumerRequire.resolve("@agwab/agent-workflow")).href
);
// The compiler is not a public export; load it from the installed dist.
const { compileWorkflow } = await import(
	pathToFileURL(join(packageRoot, "dist", "core", "compiler.js")).href
);
for (const name of officialNames) {
	const resolvedRef = await api.resolveWorkflowRef(name, consumer);
	assert.equal(
		await realpath(resolvedRef.specPath),
		join(packageRoot, "workflows", name, "spec.json"),
	);
	const loaded = await api.loadWorkflowSpec(name, consumer);
	const compiled = await compileWorkflow(loaded.spec, {
		cwd: consumer,
		task: `Packed ${name} contract check`,
		specPath: loaded.specPath,
	});
	assert.ok(
		compiled.artifactGraph?.enabled,
		`${name} did not compile as artifact graph`,
	);
	assert.ok(compiled.tasks.length > 0, `${name} compiled without tasks`);
	for (const relativeRef of localFileRefs(loaded.spec))
		await access(resolve(dirname(loaded.specPath), relativeRef));
	for (const task of compiled.tasks) {
		const agent = task.runtime?.agent;
		if (typeof agent !== "string" || !agent) continue;
		await access(join(packageRoot, "agents", `${agent}.md`));
	}
}

// The docs the README links to ship with the package.
const readme = await readFile(join(packageRoot, "README.md"), "utf8");
for (const [, target] of readme.matchAll(/\]\(((?:docs|workflows)\/[^)#]+)/gu))
	await access(join(packageRoot, target));

function localFileRefs(value) {
	const refs = [];
	visit(value);
	return [...new Set(refs)];

	function visit(candidate) {
		if (typeof candidate === "string") {
			if (/^\.\/.+\.(?:json|mjs|js)$/u.test(candidate)) refs.push(candidate);
			return;
		}
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		if (!candidate || typeof candidate !== "object") return;
		for (const item of Object.values(candidate)) visit(item);
	}
}

console.log(
	`packed install: ${piFreeEntries.length} Pi-free entry points, Pi host refused without Pi, bin ok, bundled workflows valid: ${officialNames.join(", ")}`,
);
