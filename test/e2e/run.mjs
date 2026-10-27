#!/usr/bin/env node
// Ported from @agwab/pi-workflow 0.16.4 (b83cc4f) test/e2e/run.mjs. MIT, same author. Changes: env
// PI_WORKFLOW_E2E_*→AGENT_WORKFLOW_E2E_*; shims and the guard also block the codex and claude CLIs;
// the isolated environment adds AGENT_WORKFLOW_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR; the package is
// built, packed once and unpacked into an isolated consumer without npm install and without any Pi
// package, and every case runs against that packed artifact (pi-workflow ran most checks against
// its compiled test build). Cases: forbidden-term scan of the packed files (plus a scanner
// self-test), packed install, a bundled-style workflow through the packed CLI against the E2E test
// executor, the durable launch barrier v2 through the packed runtime, and the no-external-actions
// audit. Dropped: packed-web-loader (pi-workflow's workflow web-source tools and pi-web-access
// wrappers do not exist in agent-workflow: deep-research uses each executor's own web tools, C2),
// the Pi-session registry/parse/run-boundary evals (covered by the unit suite) and the legacy
// recipe/flow term scan.
//
// `npm run e2e` — offline; evidence in .tmp/test-results/e2e/run-*/ (report.md).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const e2eDir = join(root, "test", "e2e");
const resultRoot = join(root, ".tmp", "test-results", "e2e");
const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
const resultDir = join(resultRoot, `run-${stamp}-${randomUUID().slice(0, 8)}`);
mkdirSync(resultDir, { recursive: true });

// The consumer lives outside the checkout, so module resolution can never fall back to the
// repository's node_modules.
const work = realpathSync(mkdtempSync(join(tmpdir(), "agent-workflow-e2e-")));
const packDir = join(work, "pack");
const consumer = join(work, "consumer");
const packageRoot = join(consumer, "node_modules", "@agwab", "agent-workflow");
const isolatedRoot = join(work, "isolated-roots");

const processLog = join(resultDir, "process-tree.jsonl");
const guardModule = join(e2eDir, "no-external-actions-guard.mjs");
const commandShimDir = join(resultDir, "command-shims");
const realNpm = findExecutable("npm", process.env.PATH);
mkdirSync(commandShimDir, { recursive: true });
copyFileSync(
	guardModule,
	join(commandShimDir, "no-external-actions-guard.mjs"),
);
for (const command of [
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"curl",
	"wget",
	"pi",
	"codex",
	"claude",
]) {
	const shim = join(commandShimDir, command);
	copyFileSync(join(e2eDir, "no-external-actions-command-shim.mjs"), shim);
	chmodSync(shim, 0o700);
}
const isolatedEnvironment = {
	HOME: join(isolatedRoot, "home"),
	AGENT_WORKFLOW_HOME: join(isolatedRoot, "agent-workflow-home"),
	PI_CODING_AGENT_DIR: join(isolatedRoot, "pi-agent"),
	CODEX_HOME: join(isolatedRoot, "codex-home"),
	CLAUDE_CONFIG_DIR: join(isolatedRoot, "claude-config"),
	XDG_CONFIG_HOME: join(isolatedRoot, "xdg-config"),
	XDG_CACHE_HOME: join(isolatedRoot, "xdg-cache"),
	XDG_DATA_HOME: join(isolatedRoot, "xdg-data"),
	XDG_STATE_HOME: join(isolatedRoot, "xdg-state"),
};
for (const path of [...Object.values(isolatedEnvironment), packDir, consumer])
	mkdirSync(path, { recursive: true });
for (const name of Object.keys(process.env))
	if (name.startsWith("AGENT_WORKFLOW_")) delete process.env[name];
Object.assign(process.env, isolatedEnvironment, {
	PATH: `${commandShimDir}${delimiter}${process.env.PATH ?? ""}`,
	AGENT_WORKFLOW_E2E_NO_EXTERNAL_ACTIONS: "1",
	AGENT_WORKFLOW_E2E_PROCESS_LOG: processLog,
	AGENT_WORKFLOW_E2E_REAL_NPM: realNpm,
	npm_config_offline: "true",
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
	npm_config_userconfig: join(isolatedRoot, "npmrc"),
	NODE_OPTIONS: [
		process.env.NODE_OPTIONS,
		`--import=${pathToFileURL(guardModule).href}`,
	]
		.filter(Boolean)
		.join(" "),
});
await import(pathToFileURL(guardModule).href);

const rows = [];
let failed = false;

function record(label, command, result, options) {
	const expectedExitCodes = options.expectedExitCodes ?? [0];
	const statusMatches =
		result.status !== null && expectedExitCodes.includes(result.status);
	const outputMatches =
		!options.stdoutPattern || options.stdoutPattern.test(result.stdout ?? "");
	const pass = statusMatches && outputMatches && !result.error;
	const excerptSource = (
		(pass ? result.stdout : result.stderr || result.stdout) ||
		result.error?.message ||
		""
	)
		.trim()
		.replace(/\s+/gu, " ");
	rows.push({
		label,
		command: command.map((part) => relativeToKnownRoots(part)).join(" "),
		status: result.status,
		signal: result.signal,
		error: result.error?.code ?? "",
		durationMs: options.durationMs,
		expected: expectedExitCodes.join(" or "),
		stdout: relative(root, options.stdoutPath),
		stderr: relative(root, options.stderrPath),
		excerpt: excerptSource.slice(-240),
		result: pass ? "PASS" : "FAIL",
	});
	if (!pass) failed = true;
	console.log(`${pass ? "PASS" : "FAIL"} ${label} (${options.durationMs} ms)`);
}

function skip(label, command, reason) {
	const out = join(resultDir, `${label}.out`);
	const err = join(resultDir, `${label}.err`);
	writeFileSync(out, "");
	writeFileSync(err, `${reason}\n`);
	rows.push({
		label,
		command: command.join(" "),
		status: null,
		signal: null,
		error: "",
		durationMs: 0,
		expected: "skipped",
		stdout: relative(root, out),
		stderr: relative(root, err),
		excerpt: reason,
		result: "SKIP",
	});
	console.log(`SKIP ${label}: ${reason}`);
}

function insideGitWorktree() {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: root,
		encoding: "utf8",
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

function run(label, command, args = [], options = {}) {
	const out = join(resultDir, `${label}.out`);
	const err = join(resultDir, `${label}.err`);
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
		killSignal: "SIGTERM",
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, ...(options.env ?? {}) },
	});
	writeFileSync(out, result.stdout ?? "");
	writeFileSync(err, result.stderr ?? "");
	record(label, [command, ...args], result, {
		...options,
		durationMs: Date.now() - startedAt,
		stdoutPath: out,
		stderrPath: err,
	});
	return result;
}

function nodeScript(label, script, args = [], options = {}) {
	return run(label, process.execPath, [script, ...args], options);
}

function packAndUnpack() {
	// `prepack` would rebuild; the build already ran, so pack with --ignore-scripts.
	const packed = run(
		"pack",
		"npm",
		["pack", "--pack-destination", packDir, "--ignore-scripts", "--json"],
		{ timeoutMs: 180_000 },
	);
	if (packed.status !== 0) return false;
	const [{ filename }] = JSON.parse(packed.stdout);
	const unpacked = run("unpack", "tar", [
		"-xzf",
		join(packDir, filename),
		"-C",
		packDir,
	]);
	if (unpacked.status !== 0) return false;
	// What `npm install <tarball>` would do for a package without dependencies, without npm
	// install (blocked by the guard): place the package and link its bin.
	mkdirSync(dirname(packageRoot), { recursive: true });
	renameSync(join(packDir, "package"), packageRoot);
	const binDir = join(consumer, "node_modules", ".bin");
	mkdirSync(binDir, { recursive: true });
	const binTarget = join(packageRoot, "src", "hosts", "cli", "cli.mjs");
	chmodSync(binTarget, 0o755);
	symlinkSync(
		relative(binDir, binTarget),
		join(binDir, "agent-workflow"),
		"file",
	);
	writeFileSync(
		join(consumer, "package.json"),
		`${JSON.stringify({ name: "agent-workflow-e2e-consumer", private: true, type: "module" }, null, 2)}\n`,
	);
	return true;
}

function scannerSelfTest() {
	// The scanner must report a forbidden match (exit 2), not pass vacuously.
	const bad = join(work, "scanner-self-test");
	mkdirSync(join(bad, "dist", "core"), { recursive: true });
	mkdirSync(join(bad, "workflows", "x"), { recursive: true });
	writeFileSync(
		join(bad, "package.json"),
		JSON.stringify({ name: "bad", dependencies: { left: "1" } }),
	);
	writeFileSync(
		join(bad, "dist", "core", "x.js"),
		`import "${["@earendil", "works"].join("-")}/pi-ai";\nconst home = "/${"Users"}/someone/project";\n`,
	);
	writeFileSync(
		join(bad, "workflows", "x", "spec.json"),
		'{"tools":["workflow_web_search"]}',
	);
	return nodeScript(
		"forbidden-term-scanner-self-test",
		join(e2eDir, "forbidden-term-scanner.mjs"),
		[bad],
		{
			expectedExitCodes: [2],
			stdoutPattern:
				/pi-peer-import[\s\S]*local-home-path|local-home-path[\s\S]*pi-peer-import/u,
		},
	);
}

function auditProcessLog() {
	return run("no-external-actions", process.execPath, [
		"--input-type=module",
		"-e",
		`
    import { readFileSync } from 'node:fs';
    const events = readFileSync(${JSON.stringify(processLog)}, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
    if (!events.some((event) => event.type === 'process-start')) throw new Error('missing process-tree startup instrumentation');
    if (!events.some((event) => event.type === 'child-process')) throw new Error('missing child-process instrumentation');
    if (!events.some((event) => event.type === 'command-shim' && event.command === 'npm' && event.classification === 'allowed')) throw new Error('npm pack/run shim was not exercised');
    const forbidden = events.filter((event) => ['blocked-command', 'network-attempt'].includes(event.type));
    if (forbidden.length > 0) throw new Error('forbidden E2E process activity: ' + JSON.stringify(forbidden));
    const agentClis = events.filter((event) => event.type === 'child-process' && ['pi', 'codex', 'claude'].includes(event.command));
    if (agentClis.length > 0) throw new Error('an agent CLI was started: ' + JSON.stringify(agentClis));
    console.log(JSON.stringify({ processEvents: events.length, processes: events.filter((event) => event.type === 'process-start').length, forbiddenEvents: forbidden.length }));
  `,
	]);
}

function main() {
	console.log(`Writing E2E evidence to ${relative(root, resultDir)}`);
	try {
		run("build", "npm", ["run", "build"], { timeoutMs: 300_000 });
		// `git diff --check` only has meaning inside a Git worktree.
		if (insideGitWorktree()) run("diff-check", "git", ["diff", "--check"]);
		else
			skip(
				"diff-check",
				["git", "diff", "--check"],
				"skipped: source root is not inside a Git worktree",
			);
		if (!failed && packAndUnpack()) {
			nodeScript(
				"forbidden-term-scan",
				join(e2eDir, "forbidden-term-scanner.mjs"),
				[packageRoot],
			);
			scannerSelfTest();
			nodeScript(
				"packed-install",
				join(e2eDir, "cases", "packed-install.mjs"),
				[packageRoot, consumer],
				{ cwd: consumer },
			);
			nodeScript(
				"packed-cli-run",
				join(e2eDir, "cases", "packed-cli-run.mjs"),
				[packageRoot, consumer],
				{ cwd: consumer, timeoutMs: 600_000 },
			);
			nodeScript(
				"packed-durable-barrier-v2",
				join(e2eDir, "cases", "packed-durable-barrier-v2.mjs"),
				[packageRoot, consumer],
				{ cwd: consumer, timeoutMs: 300_000 },
			);
		}
		auditProcessLog();
	} finally {
		keepConsumerEvidence();
		rmSync(work, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	}
	writeReport();
	console.log(
		`E2E ${failed ? "FAIL" : "PASS"}: ${relative(root, join(resultDir, "report.md"))}`,
	);
	if (failed) process.exitCode = 1;
}

/** Copy the consumer's run records and effect log into the evidence directory. */
function keepConsumerEvidence() {
	const target = join(resultDir, "consumer");
	for (const name of [".agent-workflow", "e2e-effects.jsonl"]) {
		try {
			cpSync(join(consumer, name), join(target, name), {
				recursive: true,
				dereference: false,
				filter: (source) => !source.includes("node_modules"),
			});
		} catch {}
	}
	try {
		writeFileSync(
			join(resultDir, "packed-files.txt"),
			`${listFiles(packageRoot).join("\n")}\n`,
		);
	} catch {}
}

function listFiles(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			out.push(...listFiles(join(dir, entry.name), path));
		else out.push(path);
	}
	return out;
}

function relativeToKnownRoots(value) {
	return String(value)
		.replaceAll(work, "<work>")
		.replaceAll(root, ".")
		.replaceAll(process.execPath, "node");
}

function findExecutable(name, pathValue) {
	for (const directory of String(pathValue ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Continue searching PATH.
		}
	}
	throw new Error(`required executable not found on PATH: ${name}`);
}

function writeReport() {
	const lines = [
		"# agent-workflow E2E Report",
		"",
		`Result: ${failed ? "FAIL" : "PASS"}`,
		"",
		"| Check | Expected exit | Status | Signal/error | Duration | Result | Evidence | Excerpt |",
		"|---|---:|---:|---|---:|---|---|---|",
		...rows.map((row) => {
			const signalError =
				[row.signal, row.error].filter(Boolean).join("/") || "—";
			const evidence = `\`${row.stdout}\` / \`${row.stderr}\``;
			return `| ${reportCell(row.label)} | ${row.expected} | ${row.status ?? "null"} | ${reportCell(signalError)} | ${row.durationMs}ms | ${row.result} | ${evidence} | ${reportCell(relativeToKnownRoots(row.excerpt) || "—")} |`;
		}),
	];
	writeFileSync(join(resultDir, "report.md"), `${lines.join("\n")}\n`);
	writeFileSync(
		join(resultRoot, "..", "e2e-report.md"),
		`${lines.join("\n")}\n`,
	);
}

function reportCell(value) {
	return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

main();
