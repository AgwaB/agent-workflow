#!/usr/bin/env node
// WP14/WP15: generator of the Claude Code and Codex plugin (`plugins/agent-workflow/`) and of the
// repo marketplaces (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`).
// Sources of truth: package.json (version), skills/ (agent-workflow, workflow-guide,
// execution-router), docs/usage.md and the bundled workflow specs. docs/plugins.md explains the
// layout. WP33: also the Pi package skills `plugins/pi/skills/aw-*` (renamed copies, owner
// decision Q10) and their package.json `pi.skills` entry.
//
//   node tools/release/plugins.mjs build             regenerate the committed plugin + marketplaces
//   node tools/release/plugins.mjs check             exit 1 when the committed files drift
//   node tools/release/plugins.mjs dev <outDir> [--force]
//        write a local marketplace root whose plugin runs this checkout's server
//        (`node <checkout>/src/mcp/host-server/bin.mjs --host …`; needs `npm run build`)
//
// One plugin directory serves both hosts. Each host reads its own manifest, which registers the
// host MCP server with that host's `--host` value:
// - Claude Code: `.claude-plugin/plugin.json` (inline `mcpServers`, `--host claude-code`).
// - Codex: `.codex-plugin/plugin.json` (inline `mcpServers`, `--host codex`). Codex prefers a root
//   Agent Plugins `plugin.json`/`mcp.json`, but Codex 0.159.2 starts portable stdio servers in the
//   plugin root, while the server takes its project from its working directory; the compatibility
//   manifest starts the server in the session directory. So no root portable manifest is written.
// Neither manifest set uses a `.mcp.json` file (Claude Code would load it as a second server).
import { existsSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
export const PACKAGE_NAME = "@agwab/agent-workflow";
export const PLUGIN_NAME = "agent-workflow";
export const MARKETPLACE_NAME = "agent-workflow";
export const MCP_SERVER_NAME = "agent-workflow";
export const PLUGIN_DIR = "plugins/agent-workflow";
export const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
export const CODEX_MARKETPLACE_FILE = ".agents/plugins/marketplace.json";
export const HOST_IDS = Object.freeze({
	claude: "claude-code",
	codex: "codex",
});
/** Codex: first `npx` start downloads the package; tool calls stay well below (wait cap 45 s). */
export const CODEX_STARTUP_TIMEOUT_SEC = 120;
export const CODEX_TOOL_TIMEOUT_SEC = 120;
export const PLUGIN_SKILLS = Object.freeze([
	"agent-workflow",
	"execution-router",
	"workflow-guide",
]);
/**
 * WP33 (parity row 59, owner decision Q10): the Pi package skills. pi-workflow ships `workflow-guide`
 * and `execution-router`, and Pi keeps the first skill of a name (frontmatter `name`; the directory
 * name does not count), so the Pi copies carry the `aw-` prefix. `agent-workflow` (the MCP tool
 * protocol) is not exposed: in Pi the `aw_*` tools carry their own guidelines.
 */
export const PI_SKILLS_DIR = "plugins/pi/skills";
export const PI_SKILLS = Object.freeze({
	"workflow-guide": "aw-workflow-guide",
	"execution-router": "aw-execution-router",
});
/** pi-workflow 0.16.4 (b83cc4f) `pi.skills` names; the Pi copies must never use one. */
export const PI_WORKFLOW_SKILL_NAMES = Object.freeze([
	"workflow-guide",
	"execution-router",
]);
/** package.json `pi.skills` (paths relative to the package root). */
export const PI_PACKAGE_SKILL_PATHS = Object.freeze(
	Object.values(PI_SKILLS).map((name) => `./${PI_SKILLS_DIR}/${name}`),
);

/** Bundled specs the workflow-guide skill names as quality references. */
export const REFERENCE_WORKFLOWS = Object.freeze([
	"deep-research",
	"deep-review",
	"impact-review",
	"spec-review",
]);

const REPOSITORY = "https://github.com/AgwaB/agent-workflow";
const AUTHOR = Object.freeze({
	name: "AgwaB",
	url: "https://github.com/AgwaB",
});
const DESCRIPTION =
	"Run agent-workflow multi-agent workflows (deep-review, deep-research, spec-review, impact-review, dynamic) from the conversation: launch, wait, inspect and stop runs through the agent-workflow MCP server.";
const KEYWORDS = Object.freeze([
	"workflow",
	"agents",
	"mcp",
	"review",
	"research",
]);

/** Released plugin: the server comes from npm, pinned to the package version. */
export function npxLaunch(version, host) {
	return {
		command: "npx",
		args: [
			"-y",
			`--package=${PACKAGE_NAME}@${version}`,
			"agent-workflow-mcp",
			"--host",
			host,
		],
	};
}

/** Dev plugin: the server of a local checkout (absolute paths, current Node binary). */
export function devLaunch(checkoutRoot, host) {
	return {
		command: process.execPath,
		args: [
			join(resolve(checkoutRoot), "src/mcp/host-server/bin.mjs"),
			"--host",
			host,
		],
	};
}

export async function readPackageVersion(root = REPO_ROOT) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	if (pkg.name !== PACKAGE_NAME)
		throw new Error(
			`package.json name is ${pkg.name}, expected ${PACKAGE_NAME}`,
		);
	return pkg.version;
}

function json(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function claudePluginManifest(version, launch) {
	return {
		$schema: "https://anthropic.com/claude-code/plugin.schema.json",
		name: PLUGIN_NAME,
		version,
		description: DESCRIPTION,
		author: { ...AUTHOR },
		homepage: `${REPOSITORY}#readme`,
		repository: REPOSITORY,
		license: "MIT",
		keywords: [...KEYWORDS],
		mcpServers: { [MCP_SERVER_NAME]: launch(HOST_IDS.claude) },
	};
}

export function codexPluginManifest(version, launch) {
	return {
		name: PLUGIN_NAME,
		version,
		description: DESCRIPTION,
		author: { ...AUTHOR },
		homepage: `${REPOSITORY}#readme`,
		repository: REPOSITORY,
		license: "MIT",
		keywords: [...KEYWORDS],
		skills: "./skills/",
		mcpServers: {
			[MCP_SERVER_NAME]: {
				...launch(HOST_IDS.codex),
				startup_timeout_sec: CODEX_STARTUP_TIMEOUT_SEC,
				tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
			},
		},
		interface: {
			displayName: "agent-workflow",
			shortDescription:
				"Run multi-agent workflows (review, research) and report their results",
			developerName: AUTHOR.name,
			category: "Coding",
			websiteURL: REPOSITORY,
		},
	};
}

export function claudeMarketplace() {
	return {
		$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
		name: MARKETPLACE_NAME,
		owner: { ...AUTHOR },
		metadata: {
			description: "agent-workflow plugin for Claude Code",
		},
		plugins: [
			{
				name: PLUGIN_NAME,
				source: `./${PLUGIN_DIR}`,
				description: DESCRIPTION,
				category: "development",
				homepage: `${REPOSITORY}#readme`,
				license: "MIT",
			},
		],
	};
}

export function codexMarketplace() {
	return {
		name: MARKETPLACE_NAME,
		interface: { displayName: "agent-workflow" },
		plugins: [
			{
				name: PLUGIN_NAME,
				source: { source: "local", path: `./${PLUGIN_DIR}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Coding",
			},
		],
	};
}

function replaceAll(text, file, replacements) {
	let out = text;
	for (const [from, to] of replacements) {
		if (!out.includes(from))
			throw new Error(
				`${file}: expected source text not found (update tools/release/plugins.mjs): ${from.slice(0, 100)}`,
			);
		out = out.split(from).join(to);
	}
	return out;
}

/** Pi-only names that must not survive in the plugin copies of the skills. */
export const PI_ONLY_SKILL_TEXT = /\baw_[a-z]+\b|\/aw\b|\bin Pi\b|\(Pi:/u;

function npxCli(version) {
	return `npx -y --package=${PACKAGE_NAME}@${version} agent-workflow`;
}

function pluginNote(version) {
	return `> Plugin copy for Claude Code and Codex, generated from \`skills/workflow-guide/\` of \`${PACKAGE_NAME}@${version}\`. The bundled docs and specs it names are under \`../../reference/\`. Run \`agent-workflow …\` commands with the installed CLI, or as \`${npxCli(version)} …\` from the project directory. The MCP tools are described in the \`agent-workflow\` skill.\n\n`;
}

export function adaptWorkflowGuide(text, version) {
	const file = "skills/workflow-guide/SKILL.md";
	return replaceAll(text, file, [
		["# Workflow Guide\n\n", `# Workflow Guide\n\n${pluginNote(version)}`],
		["`../../docs/usage.md`", "`../../reference/docs/usage.md`"],
		["`../../workflows/", "`../../reference/workflows/"],
		[
			"check the result with `agent-workflow roles <workflow>` (Pi: `/aw roles <workflow>`).",
			"check the result with `agent-workflow roles <workflow>`.",
		],
		[
			"prefer the host's workflow list/run tools (in Pi: `aw_list`, `aw_run`, then `aw_wait`) when they are available; use the `agent-workflow` CLI (or `/aw ...` in Pi) as the deterministic manual fallback.",
			"prefer the agent-workflow MCP tools (`workflow_list`, `workflow_run`, then `workflow_wait`; see the `agent-workflow` skill) when they are available; use the `agent-workflow` CLI as the deterministic manual fallback.",
		],
		[
			"Always validate the workflow (`agent-workflow validate <workflow-or-file>`, or `/aw validate <workflow-or-file>` in Pi) before handing off or running a reusable workflow. There is no validate tool, so from an agent/tool context run the CLI non-interactively from the project directory; it prints the summary and `Warnings:` list and exits non-zero on an invalid spec.",
			"Always validate the workflow (the `workflow_validate` tool with the workflow name or spec path, or `agent-workflow validate <workflow-or-file>` run non-interactively from the project directory) before handing off or running a reusable workflow. Both report the summary and `Warnings:` list; an invalid spec is a tool error or a non-zero CLI exit.",
		],
		[
			"(for example Pi's `question` tool)",
			"(for example Claude Code's `AskUserQuestion` tool)",
		],
		[
			"Example `question` tool shape:",
			"Example option set (written as a Pi `question` tool call; map it onto your host's question tool):",
		],
		[
			"(or `/aw validate <workflow-or-file>` in Pi), run from the project directory.",
			"(or the `workflow_validate` tool), run from the project directory.",
		],
		[
			"Use `agent-workflow inspect <run-id> --results` (Pi: `/aw inspect <run-id> --results`)",
			"Use `workflow_inspect {runId, results: true}` or `agent-workflow inspect <run-id> --results`",
		],
	]);
}

export function adaptScaffoldReadme(text) {
	return replaceAll(text, "skills/workflow-guide/scaffolds/README.md", [
		[
			"Then run `agent-workflow validate` (or `/aw validate` in Pi) before use.",
			"Then run `agent-workflow validate` (or the `workflow_validate` tool) before use.",
		],
	]);
}

export function adaptExecutionRouter(text) {
	return replaceAll(text, "skills/execution-router/SKILL.md", [
		[
			"(in Pi: `/aw run <name>` or `/aw dynamic`) is authoritative",
			"(or a request to launch through the `workflow_run`/`workflow_dynamic` tools) is authoritative",
		],
		[
			"such as the host's workflow list tool (for example `aw_list` in Pi) or `agent-workflow list`",
			"such as the `workflow_list` tool or `agent-workflow list`",
		],
		[
			"Never invoke `aw_run`, `aw_dynamic`, `/aw run`, `/aw dynamic`, `/aw resume`, `/aw approve`, or the matching `agent-workflow` CLI commands",
			"Never invoke `workflow_run`, `workflow_dynamic`, `workflow_wait`, `workflow_stop`, `workflow_validate`, `workflow_resume`, `workflow_supervise`, `workflow_prune`, `workflow_profile`, `workflow_notices`, `workflow_approve`, `agent-workflow resume`, `agent-workflow approve`, or the matching `agent-workflow` CLI commands",
		],
		[
			'an existing workflow (`agent-workflow run <name> "<task>"`), a direct dynamic run (`agent-workflow dynamic "<task>"`)',
			'an existing workflow (`workflow_run {workflow, task}` or `agent-workflow run <name> "<task>"`), a direct dynamic run (`workflow_dynamic {task}` or `agent-workflow dynamic "<task>"`)',
		],
		[
			"use the compact guidance in `docs/usage.md` when it is available.",
			"use the compact guidance in `../../reference/docs/usage.md` (relative to this skill directory).",
		],
	]);
}

function pluginReadme(version) {
	return `# agent-workflow plugin (Claude Code and Codex)

Runs [agent-workflow](${REPOSITORY}) multi-agent workflows from a Claude Code or Codex
conversation. Ask for a workflow ("run deep-review on the last commit") and the agent launches it
through the \`agent-workflow\` MCP server, waits for it in calls of at most 45 seconds, and quotes the
result and report paths when the run finishes.

Contents:

- MCP server \`agent-workflow\`: \`npx ${npxLaunch(version, "<claude-code|codex>").args.join(" ")}\`
  (Node.js 22 or later; the first start downloads the package). Claude Code reads
  \`.claude-plugin/plugin.json\`, Codex reads \`.codex-plugin/plugin.json\`; each passes its own \`--host\`.
- Skills: \`agent-workflow\` (tool call protocol), \`workflow-guide\` (authoring workflows),
  \`execution-router\` (choosing a route without running anything).
- \`reference/\`: copies of the agent-workflow usage guide and bundled workflow specs used by
  \`workflow-guide\`.

Install:

- Claude Code: \`claude plugin marketplace add AgwaB/agent-workflow\`, then
  \`claude plugin install agent-workflow@agent-workflow\` (in a session:
  \`/plugin install agent-workflow --marketplace AgwaB/agent-workflow\`).
- Codex: \`codex plugin marketplace add AgwaB/agent-workflow\`, then
  \`codex plugin add agent-workflow@agent-workflow\`.

Alternatives (\`mcp add\`), local development and troubleshooting: [docs/plugins.md](${REPOSITORY}/blob/main/docs/plugins.md).
This directory is generated by \`node tools/release/plugins.mjs build\`; do not edit it by hand.
`;
}

async function listFiles(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(path, base)));
		else if (entry.isFile())
			out.push(relative(base, path).split(sep).join("/"));
		else
			throw new Error(`unsupported entry (not a file or directory): ${path}`);
	}
	return out.sort();
}

/**
 * Every file of the plugin directory, keyed by plugin-relative POSIX path.
 * `launch(host)` returns `{command, args}` for the MCP server entry.
 */
export async function renderPluginFiles({ root = REPO_ROOT, version, launch }) {
	const files = new Map();
	files.set(
		".claude-plugin/plugin.json",
		json(claudePluginManifest(version, launch)),
	);
	files.set(
		".codex-plugin/plugin.json",
		json(codexPluginManifest(version, launch)),
	);
	files.set("README.md", pluginReadme(version));

	const read = (path) => readFile(join(root, path), "utf8");
	files.set(
		"skills/agent-workflow/SKILL.md",
		await read("skills/agent-workflow/SKILL.md"),
	);
	files.set(
		"skills/execution-router/SKILL.md",
		adaptExecutionRouter(await read("skills/execution-router/SKILL.md")),
	);
	files.set(
		"skills/workflow-guide/SKILL.md",
		adaptWorkflowGuide(await read("skills/workflow-guide/SKILL.md"), version),
	);
	const scaffolds = "skills/workflow-guide/scaffolds";
	for (const rel of await listFiles(join(root, scaffolds))) {
		const path = `${scaffolds}/${rel}`;
		const bytes = await readFile(join(root, path));
		files.set(
			path,
			rel === "README.md" ? adaptScaffoldReadme(bytes.toString("utf8")) : bytes,
		);
	}
	files.set("reference/docs/usage.md", await read("docs/usage.md"));
	files.set("reference/workflows/README.md", await read("workflows/README.md"));
	for (const name of REFERENCE_WORKFLOWS)
		files.set(
			`reference/workflows/${name}/spec.json`,
			await read(`workflows/${name}/spec.json`),
		);

	for (const [path, content] of files) {
		if (!path.endsWith(".md") || !path.startsWith("skills/")) continue;
		const match = String(content).match(PI_ONLY_SKILL_TEXT);
		if (match)
			throw new Error(
				`${path}: Pi-only text left in a plugin skill: ${match[0]}`,
			);
	}
	return files;
}

/** The source skill's frontmatter `name: <source>` becomes `name: <target>` (exactly once). */
function renameSkill(text, file, source, target) {
	const from = `---\nname: ${source}\n`;
	if (!text.startsWith(from))
		throw new Error(
			`${file}: expected frontmatter "name: ${source}" (update tools/release/plugins.mjs)`,
		);
	return `---\nname: ${target}\n${text.slice(from.length)}`;
}

/** From `plugins/pi/skills/<name>/` back to the package root. */
const PI_SKILL_TO_ROOT = "../../../../";

/** WP33: the Pi copy of skills/workflow-guide/SKILL.md (relative paths point into the package). */
export function adaptPiWorkflowGuide(text) {
	const file = "skills/workflow-guide/SKILL.md";
	return replaceAll(
		renameSkill(text, file, "workflow-guide", PI_SKILLS["workflow-guide"]),
		file,
		[
			["`../../docs/", `\`${PI_SKILL_TO_ROOT}docs/`],
			["`../../workflows/", `\`${PI_SKILL_TO_ROOT}workflows/`],
			["./scaffolds/", `${PI_SKILL_TO_ROOT}skills/workflow-guide/scaffolds/`],
		],
	);
}

/** WP33: the Pi copy of skills/execution-router/SKILL.md. */
export function adaptPiExecutionRouter(text) {
	const file = "skills/execution-router/SKILL.md";
	return replaceAll(
		renameSkill(text, file, "execution-router", PI_SKILLS["execution-router"]),
		file,
		[
			[
				"Consult `workflow-guide` only after",
				`Consult \`${PI_SKILLS["workflow-guide"]}\` only after`,
			],
		],
	);
}

/** WP33: the Pi package skills, keyed by path relative to PI_SKILLS_DIR. */
export async function renderPiSkillFiles({ root = REPO_ROOT } = {}) {
	const read = (path) => readFile(join(root, path), "utf8");
	const files = new Map([
		[
			`${PI_SKILLS["workflow-guide"]}/SKILL.md`,
			adaptPiWorkflowGuide(await read("skills/workflow-guide/SKILL.md")),
		],
		[
			`${PI_SKILLS["execution-router"]}/SKILL.md`,
			adaptPiExecutionRouter(await read("skills/execution-router/SKILL.md")),
		],
	]);
	for (const [path, content] of files) {
		const name = /^---\nname: ([^\n]+)\n/.exec(String(content))?.[1];
		if (!name?.startsWith("aw-") || PI_WORKFLOW_SKILL_NAMES.includes(name))
			throw new Error(
				`${path}: Pi skill name must use the aw- prefix: ${name}`,
			);
	}
	return files;
}

/** WP33: package.json `pi.skills` must list exactly the generated Pi skills. */
async function piManifestProblems(root) {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const actual = JSON.stringify(pkg.pi?.skills ?? []);
	const expected = JSON.stringify(PI_PACKAGE_SKILL_PATHS);
	const problems = [];
	if (actual !== expected)
		problems.push(
			`package.json pi.skills: expected ${expected}, got ${actual}`,
		);
	if (!(pkg.files ?? []).includes("plugins/pi"))
		problems.push('package.json files: "plugins/pi" missing');
	return problems;
}

/** Repo-root marketplace files, keyed by root-relative path. */
export function renderMarketplaceFiles() {
	return new Map([
		[CLAUDE_MARKETPLACE_FILE, json(claudeMarketplace())],
		[CODEX_MARKETPLACE_FILE, json(codexMarketplace())],
	]);
}

async function writeTree(baseDir, files) {
	for (const [path, content] of files) {
		const target = join(baseDir, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

export async function buildCommitted(root = REPO_ROOT) {
	const version = await readPackageVersion(root);
	const files = await renderPluginFiles({
		root,
		version,
		launch: (host) => npxLaunch(version, host),
	});
	await rm(join(root, PLUGIN_DIR), { recursive: true, force: true });
	await writeTree(join(root, PLUGIN_DIR), files);
	await writeTree(root, renderMarketplaceFiles());
	// WP33: the Pi package skills (aw- names).
	const piSkills = await renderPiSkillFiles({ root });
	await rm(join(root, PI_SKILLS_DIR), { recursive: true, force: true });
	await writeTree(join(root, PI_SKILLS_DIR), piSkills);
	const problems = await piManifestProblems(root);
	if (problems.length) throw new Error(problems.join("\n"));
	return { version, count: files.size, piSkills: piSkills.size };
}

/** Differences between the committed files and the generator output (empty = in sync). */
export async function checkCommitted(root = REPO_ROOT) {
	const version = await readPackageVersion(root);
	const expected = await renderPluginFiles({
		root,
		version,
		launch: (host) => npxLaunch(version, host),
	});
	const problems = [];
	const pluginRoot = join(root, PLUGIN_DIR);
	const actual = existsSync(pluginRoot) ? await listFiles(pluginRoot) : [];
	for (const path of actual)
		if (!expected.has(path))
			problems.push(`${PLUGIN_DIR}/${path}: not generated`);
	const compare = async (path, content) => {
		let bytes;
		try {
			bytes = await readFile(join(root, path));
		} catch {
			problems.push(`${path}: missing`);
			return;
		}
		if (!bytes.equals(Buffer.from(content))) problems.push(`${path}: differs`);
	};
	for (const [path, content] of expected)
		await compare(`${PLUGIN_DIR}/${path}`, content);
	for (const [path, content] of renderMarketplaceFiles())
		await compare(path, content);
	// WP33: the Pi package skills and their manifest entry.
	const piExpected = await renderPiSkillFiles({ root });
	const piRoot = join(root, PI_SKILLS_DIR);
	for (const path of existsSync(piRoot) ? await listFiles(piRoot) : [])
		if (!piExpected.has(path))
			problems.push(`${PI_SKILLS_DIR}/${path}: not generated`);
	for (const [path, content] of piExpected)
		await compare(`${PI_SKILLS_DIR}/${path}`, content);
	problems.push(...(await piManifestProblems(root)));
	return problems;
}

/** Local dev marketplace root (plugin + both marketplaces) running `checkoutRoot`'s server. */
export async function buildDev(
	outDir,
	{ root = REPO_ROOT, force = false } = {},
) {
	const out = resolve(outDir);
	if (existsSync(out)) {
		const info = await stat(out);
		if (!info.isDirectory()) throw new Error(`${out} is not a directory`);
		const entries = await readdir(out);
		if (entries.length > 0 && !force)
			throw new Error(
				`${out} is not empty (pass --force to replace the plugin files)`,
			);
	}
	if (force) {
		await rm(join(out, PLUGIN_DIR), { recursive: true, force: true });
		for (const path of renderMarketplaceFiles().keys())
			await rm(join(out, path), { force: true });
	}
	const version = await readPackageVersion(root);
	const files = await renderPluginFiles({
		root,
		version,
		launch: (host) => devLaunch(root, host),
	});
	await writeTree(join(out, PLUGIN_DIR), files);
	await writeTree(out, renderMarketplaceFiles());
	const built = existsSync(join(root, "dist/mcp/host-server/server.js"));
	return { out, pluginDir: join(out, PLUGIN_DIR), version, built };
}

async function main(argv) {
	const [command, ...rest] = argv;
	if (command === "build") {
		const { version, count, piSkills } = await buildCommitted();
		console.log(
			`wrote ${PLUGIN_DIR}/ (${count} files, version ${version}), ${CLAUDE_MARKETPLACE_FILE}, ${CODEX_MARKETPLACE_FILE}, ${PI_SKILLS_DIR}/ (${piSkills} files)`,
		);
		return 0;
	}
	if (command === "check") {
		const problems = await checkCommitted();
		if (problems.length === 0) {
			console.log(
				`${PLUGIN_DIR}/, ${PI_SKILLS_DIR}/ and the marketplaces match the generator.`,
			);
			return 0;
		}
		console.error(
			`Plugin files drifted (run \`node tools/release/plugins.mjs build\`):\n${problems.map((p) => `- ${p}`).join("\n")}`,
		);
		return 1;
	}
	if (command === "dev") {
		const force = rest.includes("--force");
		const positional = rest.filter((arg) => arg !== "--force");
		if (positional.length !== 1 || positional[0].startsWith("-")) {
			console.error(
				"usage: node tools/release/plugins.mjs dev <outDir> [--force]",
			);
			return 2;
		}
		const result = await buildDev(positional[0], { force });
		console.log(
			`wrote dev plugin ${result.pluginDir} (version ${result.version})`,
		);
		console.log(`Claude Code: claude --plugin-dir ${result.pluginDir}`);
		console.log(
			`Codex: codex plugin marketplace add ${result.out}  (see docs/plugins.md)`,
		);
		if (!result.built)
			console.error(
				"warning: dist/ is missing; run `npm run build` before starting the server",
			);
		return 0;
	}
	console.error(
		"usage: node tools/release/plugins.mjs build | check | dev <outDir> [--force]",
	);
	return 2;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
