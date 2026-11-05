#!/usr/bin/env node
//
//   node test/e2e/forbidden-term-scanner.mjs <installed-package-root>
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Pi-free entry points (compiled): only `dist/hosts/pi/` may touch Pi APIs (WP11b). */
export const PI_FREE_CODE_PREFIXES = Object.freeze([
	"dist/index.",
	"dist/core/",
	"dist/runtime/",
	"dist/sdk/",
	"dist/mcp/",
	"dist/executors/",
	"dist/hosts/cli/",
	"dist/hosts/api.",
	"dist/hosts/args.",
	"dist/hosts/catalog.",
	"dist/hosts/doctor.",
	"dist/hosts/help.",
	"dist/hosts/launch.",
	"dist/hosts/result-presentation.",
	"dist/hosts/runs.",
	"dist/hosts/test-executor.",
	"dist/hosts/types.",
	"dist/hosts/user-profiles.",
]);

/** Bundled assets (M4, docs/bundled-workflows.md). */
export const BUNDLED_ASSET_PREFIXES = Object.freeze([
	"workflows/",
	"skills/",
	"agents/",
]);

/**
 * Scan Pi-only names in code, skipping comments. The legacy binding environment
 * variable is allowed only where the runtime strips it from worker environments.
 */
export const PI_ONLY_CODE_RULES = Object.freeze([
	{ id: "pi-peer-import", pattern: /@earendil-works\//u },
	{
		id: "pi-extension-api",
		pattern:
			/\b(?:ExtensionAPI|ExtensionContext|registerTool\(|registerCommand\()/u,
	},
	{
		id: "pi-env-name",
		pattern: /["'`]PI_(?:WORKFLOW|SUBAGENT)_[A-Z0-9_]+["'`]/u,
		allow: [
			{
				path: "dist/runtime/orchestrate/request.js",
				text: '"PI_SUBAGENT_DURABLE_WORKER_BINDING_JSON"',
			},
		],
	},
]);

/** Pi-only names that the bundled workflows, skills and agents must not use (M4/M5). */
export const BUNDLED_ASSET_RULES = Object.freeze([
	{ id: "pi-workflow-web-tool", pattern: /\bworkflow_web_[a-z_]+/u },
	{ id: "pi-run-store-path", pattern: /\.pi\/workflows/u },
	{ id: "pi-env-name", pattern: /\bPI_WORKFLOW_[A-Z0-9_]+/u },
]);

/** Every packed text file. */
export const EVERYWHERE_RULES = Object.freeze([
	{ id: "local-home-path", pattern: /\/Users\/[A-Za-z0-9._-]+\//u },
	{ id: "local-home-path", pattern: /\/home\/[a-z][a-z0-9._-]*\//u },
	{ id: "local-home-path", pattern: /[A-Z]:\\\\?Users\\\\?[A-Za-z0-9._-]+/u },
	{ id: "local-temp-path", pattern: /\/var\/folders\/[A-Za-z0-9_+-]{2}\//u },
	{
		id: "secret-openai-anthropic-key",
		pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/u,
	},
	{ id: "secret-github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/u },
	{ id: "secret-github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/u },
	{ id: "secret-npm-token", pattern: /\bnpm_[A-Za-z0-9]{30,}/u },
	{ id: "secret-slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/u },
	{ id: "secret-aws-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
	{ id: "secret-google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/u },
	{
		id: "secret-private-key",
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
	},
	{
		id: "secret-jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
	},
]);

/** Paths that are never product files. */
export const FORBIDDEN_PACKED_PATHS = Object.freeze([
	/^\.agent-workflow\//u,
	/^\.pi\//u,
	/^\.tmp\//u,
	/^\.github\//u,
	/^internal\//u,
	/^test\//u,
	/^tools\//u,
	/^docs\/(?:maintenance|releases)\//u,
	/^node_modules\//u,
	/(?:^|\/)\.env(?:\.|$)/u,
	/(?:^|\/)\.npmrc$/u,
	/^AGENTS\.md$/u,
	/^CHANGELOG\.md$/u,
]);

const TEXT_EXTENSIONS = new Set([
	".cjs",
	".js",
	".json",
	".md",
	".mjs",
	".ts",
	".txt",
	".yaml",
	".yml",
	".c",
]);

const EXIT_CODES = Object.freeze({
	clean: 0,
	"forbidden-match": 2,
	"read/setup-error": 3,
});

export function scanPackedPackage(packageRoot) {
	const root = resolve(packageRoot);
	const files = [];
	const errors = [];
	try {
		collectFiles(root, root, files);
	} catch (error) {
		errors.push(`${error.code ?? "E_SCAN"}: ${error.message}`);
	}
	if (errors.length > 0) return { status: "read/setup-error", errors };

	const matches = [];
	const add = (path, source, index, rule) => {
		const before = source.slice(0, index);
		const line = before.split("\n").length;
		matches.push({
			path,
			line,
			column: index - (before.lastIndexOf("\n") + 1) + 1,
			rule: rule.id,
		});
	};
	let manifest;
	for (const file of files.toSorted()) {
		const path = relative(root, file).split(sep).join("/");
		if (FORBIDDEN_PACKED_PATHS.some((pattern) => pattern.test(path)))
			matches.push({ path, line: 0, column: 0, rule: "non-product-file" });
		if (!isText(path)) continue;
		let source;
		try {
			source = readFileSync(file, "utf8");
		} catch (error) {
			errors.push(`${error.code ?? "E_READ"}: ${path}: ${error.message}`);
			continue;
		}
		if (path === "package.json") manifest = source;
		for (const rule of EVERYWHERE_RULES) {
			const match = rule.pattern.exec(source);
			if (match) add(path, source, match.index, rule);
		}
		if (BUNDLED_ASSET_PREFIXES.some((prefix) => path.startsWith(prefix)))
			for (const rule of BUNDLED_ASSET_RULES) {
				const match = rule.pattern.exec(source);
				if (match) add(path, source, match.index, rule);
			}
		if (
			path.endsWith(".js") &&
			PI_FREE_CODE_PREFIXES.some((prefix) => path.startsWith(prefix))
		)
			scanCodeLines(path, source, add);
	}
	if (manifest === undefined) errors.push("ENOENT: package.json not packed");
	else {
		const pkg = JSON.parse(manifest);
		for (const field of [
			"dependencies",
			"optionalDependencies",
			"bundleDependencies",
			"bundledDependencies",
		])
			if (Object.keys(pkg[field] ?? {}).length > 0)
				matches.push({
					path: "package.json",
					line: 0,
					column: 0,
					rule: `runtime-${field}`,
				});
		for (const [name, meta] of Object.entries(pkg.peerDependenciesMeta ?? {}))
			if (meta?.optional !== true)
				matches.push({
					path: "package.json",
					line: 0,
					column: 0,
					rule: `required-peer:${name}`,
				});
	}
	if (errors.length > 0) return { status: "read/setup-error", errors };
	if (matches.length > 0)
		return {
			status: "forbidden-match",
			scanned: files.length,
			matches: matches.toSorted(compareMatches),
		};
	return { status: "clean", scanned: files.length, matches: [] };
}

function scanCodeLines(path, source, add) {
	let offset = 0;
	let inBlockComment = false;
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		const comment =
			inBlockComment ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*");
		if (trimmed.startsWith("/*") && !trimmed.includes("*/"))
			inBlockComment = true;
		else if (inBlockComment && trimmed.includes("*/")) inBlockComment = false;
		if (!comment)
			for (const rule of PI_ONLY_CODE_RULES) {
				const match = rule.pattern.exec(line);
				if (!match) continue;
				if (
					rule.allow?.some(
						(allowed) => allowed.path === path && line.includes(allowed.text),
					)
				)
					continue;
				add(path, source, offset + match.index, rule);
			}
		offset += line.length + 1;
	}
}

function isText(path) {
	return (
		TEXT_EXTENSIONS.has(extname(path)) ||
		["LICENSE", "NOTICE"].includes(path) ||
		path === "src/hosts/cli/cli.mjs"
	);
}

function collectFiles(path, root, files) {
	const relativePath = relative(root, path).split(sep).join("/");
	if (relativePath === ".." || relativePath.startsWith("../"))
		throw new Error(`scan path escapes root: ${relativePath}`);
	const entry = lstatSync(path);
	if (entry.isSymbolicLink())
		throw new Error(
			`symbolic links are not supported by the scanner: ${relativePath}`,
		);
	if (entry.isFile()) {
		files.push(path);
		return;
	}
	if (!entry.isDirectory()) return;
	for (const child of readdirSync(path).toSorted())
		collectFiles(resolve(path, child), root, files);
}

function compareMatches(left, right) {
	return `${left.path}\0${left.line}\0${left.column}\0${left.rule}`.localeCompare(
		`${right.path}\0${right.line}\0${right.column}\0${right.rule}`,
	);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const [packageRoot] = process.argv.slice(2);
	const result = packageRoot
		? scanPackedPackage(packageRoot)
		: {
				status: "read/setup-error",
				errors: ["usage: forbidden-term-scanner.mjs <installed-package-root>"],
			};
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exitCode = EXIT_CODES[result.status];
}
