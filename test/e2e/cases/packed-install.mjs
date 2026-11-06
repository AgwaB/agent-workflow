#!/usr/bin/env node
//
//   node test/e2e/cases/packed-install.mjs <installed-package-root> <consumer-project>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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

// Compiled code/assets live in dist; only the two bin launchers need source paths.
const sourceFiles = (
	await readdir(join(packageRoot, "src"), {
		recursive: true,
		withFileTypes: true,
	})
)
	.filter((entry) => entry.isFile())
	.map((entry) =>
		relative(packageRoot, join(entry.parentPath, entry.name)).replaceAll(
			"\\",
			"/",
		),
	)
	.sort();
assert.deepEqual(sourceFiles, [
	"src/hosts/cli/cli.mjs",
	"src/mcp/host-server/bin.mjs",
]);
for (const entry of Object.values(manifest.exports)) {
	if (typeof entry === "string") await access(join(packageRoot, entry));
	else {
		await access(join(packageRoot, entry.default));
		await access(join(packageRoot, entry.types));
	}
}
for (const entry of Object.values(manifest.bin))
	assert.notEqual(
		(await stat(join(packageRoot, entry))).mode & 0o111,
		0,
		`${entry} must stay executable in the tarball`,
	);

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

async function checkDashboardAssets() {
	const ui = join(packageRoot, "dist", "hosts", "dashboard", "ui");
	for (const name of ["index.html", "app.js", "app.css"]) {
		assert.ok((await readFile(join(ui, name))).length > 0, name);
		assert.equal((await stat(join(ui, name))).mode & 0o777, 0o644, name);
	}
	const vendor = join(ui, "vendor", "shiki");
	const assets = JSON.parse(
		await readFile(join(vendor, "manifest.json"), "utf8"),
	);
	assert.ok(assets.files.length > 0);
	for (const file of assets.files) {
		const bytes = await readFile(join(vendor, file.name));
		assert.equal(bytes.length, file.bytes, file.name);
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			file.sha256,
			file.name,
		);
	}
	assert.ok(
		(await readFile(join(vendor, "THIRD-PARTY-NOTICES.txt"))).length > 0,
	);
	const { tokens } = await import(
		pathToFileURL(join(vendor, "highlight.js")).href
	);
	// Exercise the lazy grammar/theme chunks without a browser or any network.
	const code = "const answer = 42;";
	assert.ok(assets.languages.includes("typescript"));
	for (const language of assets.languages) {
		const lines = await tokens(code, language);
		assert.equal(
			lines
				.map((line) => line.map((token) => token.content).join(""))
				.join("\n"),
			code,
			language,
		);
	}
	const highlighted = (await tokens(code, "typescript")).flat();
	assert.ok(
		highlighted.some(
			(token) =>
				token.htmlStyle?.["--shiki-light"] && token.htmlStyle?.["--shiki-dark"],
		),
		"packed highlighter must produce both theme colours",
	);
	assert.equal(await tokens(code, "unknown-language"), null);
	console.log(
		`packed dashboard: UI, vendor hashes, ${assets.languages.length} languages and both themes ok`,
	);
}

async function checkProcessIdentityHelper() {
	const native = join(packageRoot, "dist", "runtime", "native");
	const helper = join(native, "darwin-process-identity");
	const metadata = JSON.parse(
		await readFile(`${helper}.manifest.json`, "utf8"),
	);
	assert.equal(
		createHash("sha256")
			.update(await readFile(helper))
			.digest("hex"),
		metadata.binarySha256,
		"packed Darwin process-identity helper hash",
	);
	assert.equal((await stat(helper)).mode & 0o777, 0o755);
	if (process.platform === "darwin" || process.platform === "linux") {
		const { captureProcessIdentity } = await import(
			pathToFileURL(join(packageRoot, "dist", "runtime", "process-identity.js"))
				.href
		);
		const identity = await captureProcessIdentity(process.pid);
		assert.equal(identity.pid, process.pid);
		assert.ok(identity.processGroupId > 0);
		assert.ok(identity.birthIdentity.startsWith(`${process.platform}:`));
		console.log(
			`packed process identity: ${process.platform} ok; native hash/mode ok`,
		);
	} else {
		console.log(
			`packed process identity: runtime unsupported on ${process.platform}; native hash/mode ok`,
		);
	}
}

await checkDashboardAssets();
await checkProcessIdentityHelper();
console.log(
	`packed install: ${piFreeEntries.length} Pi-free entry points, Pi host refused without Pi, bin ok, bundled workflows valid: ${officialNames.join(", ")}`,
);
