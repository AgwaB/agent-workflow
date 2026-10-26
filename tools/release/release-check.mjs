#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { isRegistryFreeValidationOnly } from "./release-policy.mjs";

// Bundled workflow/scaffold specs are added by WP10.
const BUNDLE_SPEC_FILES = [];

const REQUIRED_FILES = [
	"README.md",
	"LICENSE",
	"NOTICE",
	"package.json",
	...BUNDLE_SPEC_FILES,
	"src/index.ts",
	"src/hosts/cli/cli.mjs",
	"dist/index.js",
	"dist/sdk/index.js",
	"dist/runtime/index.js",
	"dist/executors/pi/index.js",
	"dist/executors/codex/index.js",
	"dist/executors/claude/index.js",
	"dist/hosts/cli/index.js",
	"dist/hosts/pi/index.js",
];

const FORBIDDEN_PACKAGE_PREFIXES = [
	".git/",
	".github/",
	".harness/",
	".pi/",
	".tmp/",
	".worktrees/",
	".agent-workflow/",
	"cache/",
	"dist/.tmp/",
	"docker/",
	"internal/",
	"test/",
];

const SECRET_PATTERN =
	/\/Users\/toby|\/var\/folders|Desktop|clipboard|Screenshot|API[_-]?KEY|SECRET|PASSWORD|PRIVATE KEY|BEGIN [A-Z ]*PRIVATE KEY|npm_[A-Za-z0-9]{20,}|(^|[^a-zA-Z])sk-[A-Za-z0-9]{20,}/;

const NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_DIST_TAG = "latest";
const npmConfigDir = mkdtempSync(
	join(tmpdir(), "agent-workflow-release-check-"),
);
const npmEnv = {
	...process.env,
	NPM_CONFIG_USERCONFIG: join(npmConfigDir, "user.npmrc"),
	NPM_CONFIG_GLOBALCONFIG: join(npmConfigDir, "global.npmrc"),
	NPM_CONFIG_REGISTRY: NPM_REGISTRY,
	NPM_CONFIG_TAG: NPM_DIST_TAG,
};
writeFileSync(
	npmEnv.NPM_CONFIG_USERCONFIG,
	`registry=${NPM_REGISTRY}/\ntag=${NPM_DIST_TAG}\n`,
	{ mode: 0o600 },
);
writeFileSync(npmEnv.NPM_CONFIG_GLOBALCONFIG, `registry=${NPM_REGISTRY}/\n`, {
	mode: 0o600,
});
process.on("exit", () =>
	rmSync(npmConfigDir, { recursive: true, force: true }),
);

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: false,
		env: { ...npmEnv, ...(options.env ?? {}) },
		...options,
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args, options = {}) {
	return spawnSync(command, args, {
		encoding: "utf8",
		shell: false,
		env: { ...npmEnv, ...(options.env ?? {}) },
		...options,
	});
}

const pkg = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

if (pkg.private === true) {
	console.error("package.json has private:true; refusing release check.");
	process.exit(1);
}
if (pkg.name !== "@agwab/agent-workflow") {
	console.error(`unexpected package name: ${pkg.name}`);
	process.exit(1);
}
if (JSON.stringify(pkg.publishConfig) !== '{"access":"public"}') {
	console.error(
		'package.json publishConfig must be exactly {"access":"public"} with no registry or tag.',
	);
	process.exit(1);
}
const trackedFiles = capture("git", ["ls-files", "-z"]);
if (trackedFiles.status !== 0) {
	console.error("unable to inspect tracked files for npm configuration");
	process.exit(trackedFiles.status ?? 1);
}
const trackedNpmrc = trackedFiles.stdout
	.split("\0")
	.filter((path) => path && path.split("/").at(-1) === ".npmrc");
if (trackedNpmrc.length > 0) {
	console.error(`tracked .npmrc is forbidden: ${trackedNpmrc.join(", ")}`);
	process.exit(1);
}
const allowPublishedVersion =
	process.env.AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION === "1";
const registryFreeValidationOnly = isRegistryFreeValidationOnly(process.env);

if (registryFreeValidationOnly) {
	console.log(
		"Skipping npm whoami in the GitHub Actions validation-only environment.",
	);
} else if (process.env.GITHUB_ACTIONS === "true") {
	console.log(
		"Skipping npm whoami in GitHub Actions; publish authentication is handled by trusted publishing/OIDC.",
	);
} else {
	const npmWhoami = capture("npm", ["whoami", "--registry", NPM_REGISTRY]);
	if (npmWhoami.status !== 0) {
		console.error(
			"npm whoami failed. Run npm login first or use the GitHub Actions release workflow.",
		);
		process.exit(npmWhoami.status ?? 1);
	}
	console.log(`npm user: ${npmWhoami.stdout.trim()}`);
}

let versionAlreadyPublished = false;
if (registryFreeValidationOnly) {
	console.log(
		"Skipping npm view in the GitHub Actions validation-only environment.",
	);
} else {
	const versionView = capture("npm", [
		"view",
		`${pkg.name}@${pkg.version}`,
		"version",
		"--registry",
		NPM_REGISTRY,
		"--tag",
		NPM_DIST_TAG,
	]);
	if (versionView.status !== 0) {
		if (
			!/npm (ERR!|error) code E404/i.test(
				`${versionView.stdout}\n${versionView.stderr}`,
			)
		) {
			console.error(
				"npm view failed; refusing to reinterpret an unavailable registry response as a new version.",
			);
			process.exit(versionView.status ?? 1);
		}
	} else if (versionView.stdout.trim() === pkg.version) {
		versionAlreadyPublished = true;
		if (!allowPublishedVersion) {
			console.error(
				`${pkg.name}@${pkg.version} already exists on npm. Bump version before publishing, or set AGENT_WORKFLOW_ALLOW_PUBLISHED_VERSION=1 for validation-only reruns.`,
			);
			process.exit(1);
		}
		console.log(
			`${pkg.name}@${pkg.version} already exists on npm; running validation-only checks.`,
		);
	} else {
		console.error(
			"npm view returned an unexpected version; refusing to continue.",
		);
		process.exit(1);
	}
}

run("npm", ["run", "check:scripts"]);
run("npm", ["run", "check:release-workflow"]);
run("npm", ["run", "check:public-surface"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "test:unit"]);
run("npm", ["run", "e2e"]);
run("npm", ["run", "build"]);

const NPM_PACK_JSON_MAX_BUFFER = 8 * 1024 * 1024;

console.log("\n$ npm pack --dry-run --json --ignore-scripts");
const pack = execFileSync(
	"npm",
	[
		"pack",
		"--dry-run",
		"--json",
		"--ignore-scripts",
		"--registry",
		NPM_REGISTRY,
		"--tag",
		NPM_DIST_TAG,
	],
	{
		encoding: "utf8",
		maxBuffer: NPM_PACK_JSON_MAX_BUFFER,
		env: npmEnv,
	},
);
const [summary] = JSON.parse(pack);
const files = summary.files.map((file) => file.path);

const missing = REQUIRED_FILES.filter((path) => !files.includes(path));
if (missing.length > 0) {
	console.error(`Package is missing required files: ${missing.join(", ")}`);
	process.exit(1);
}

const missingBundleAssets = [];
for (const specPath of BUNDLE_SPEC_FILES) {
	const spec = JSON.parse(readFileSync(specPath, "utf8"));
	for (const relativeRef of localFileRefs(spec)) {
		const assetPath = posix.normalize(
			posix.join(posix.dirname(specPath), relativeRef),
		);
		if (!files.includes(assetPath)) missingBundleAssets.push(assetPath);
	}
}
if (missingBundleAssets.length > 0) {
	console.error(
		`Package is missing referenced workflow/scaffold assets: ${[...new Set(missingBundleAssets)].join(", ")}`,
	);
	process.exit(1);
}

const forbidden = files.filter((path) =>
	FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => path.startsWith(prefix)),
);
if (forbidden.length > 0) {
	console.error(
		`Package includes local/internal files:\n${forbidden.join("\n")}`,
	);
	process.exit(1);
}

const ownTextFiles = files.filter(
	(path) =>
		!path.startsWith("node_modules/") &&
		!path.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i) &&
		existsSync(path),
);
for (const path of ownTextFiles) {
	const text = readFileSync(path, "utf8");
	if (SECRET_PATTERN.test(text)) {
		console.error(
			`Package file contains local path or secret-like text: ${path}`,
		);
		process.exit(1);
	}
}

console.log(
	JSON.stringify(
		{
			name: summary.name,
			version: summary.version,
			filename: summary.filename,
			entryCount: summary.entryCount,
			packageSize: summary.size,
			unpackedSize: summary.unpackedSize,
		},
		null,
		2,
	),
);

if (registryFreeValidationOnly) {
	console.log(
		"\nSkipping npm publish --dry-run in the GitHub Actions validation-only environment.",
	);
} else if (versionAlreadyPublished) {
	console.log(
		"\nSkipping npm publish --dry-run because this version already exists on npm.",
	);
} else {
	run("npm", [
		"publish",
		"--dry-run",
		"--access",
		"public",
		"--registry",
		NPM_REGISTRY,
		"--tag",
		NPM_DIST_TAG,
	]);
}
console.log(
	"\nRelease check passed. Prefer the GitHub Actions Publish workflow for real releases.",
);

function localFileRefs(value) {
	const refs = [];
	visit(value);
	return refs;

	function visit(candidate) {
		if (typeof candidate === "string") {
			if (/^\.\/.+\.(?:json|mjs|js)$/.test(candidate)) refs.push(candidate);
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
