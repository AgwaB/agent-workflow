#!/usr/bin/env node
// WP1b replay driver: runs a recorded pi-workflow fixture's ORIGINAL workflow spec through the
// agent-workflow engine (engine → core task backend → runtime durable worker → replay executor)
// and returns the run directory to compare. See docs/replay.md.
//
// Library: replayFixture(name, options) → { fixture, project, roots, run, runDir, trace, ... }
// CLI:     node test/replay/replay-driver.mjs <fixture> [--keep]   (needs `npm run build`)
//
// Project setup follows the WP1a self-replay host pins (fixture.json): `replayRoot` (exact
// absolute project path), `rootPathLength` (padded project path), `projectIsPackageRoot` (the
// recording ran inside the pi-workflow checkout: <ROOT> == <PKG>, so the original workflow
// directory is placed at <project>/workflows/<name>), `executionProfile`, `inputOverrides`,
// `env` (PI_WORKFLOW_* names mapped to their AGENT_WORKFLOW_* renames, docs/core-port.md WP4c-1).
// Agents are installed where the recording had them, `<project>/.pi/agents/<agent>.md`; the
// engine reads that legacy location (docs/core-port.md WP4b "Legacy read (F5)").
// The original bundled spec directory is the fixture's `run/bundle/` (the frozen copy the recorded
// engine wrote; byte-identical to pi-workflow b83cc4f `workflows/<name>/`, checked by
// `verifyBundleAgainstSource` when PI_WORKFLOW_SOURCE points at a pi-workflow git checkout).
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonLines, replayExecutorDescriptor } from "./replay-executor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, "..", "..");
export const FIXTURES_ROOT = join(HERE, "fixtures");
const dist = (path) => pathToFileURL(join(PKG_ROOT, "dist", path)).href;

export function loadFixture(name) {
	const fixtureDir = join(FIXTURES_ROOT, name);
	const fixture = JSON.parse(
		readFileSync(join(fixtureDir, "fixture.json"), "utf8"),
	);
	return { name, fixtureDir, fixture };
}

/** Why a fixture cannot replay on this host (WP1a rule), or false. */
export function fixtureSkipReason({ fixture }) {
	return fixture.replayRoot &&
		process.platform !== (fixture.replayRootPlatform ?? process.platform)
		? `fixture pins replay root ${fixture.replayRoot} on ${fixture.replayRootPlatform}`
		: false;
}

/** `PI_WORKFLOW_*` host pins under their agent-workflow names (docs/core-port.md renames). */
export function renamedEnvPins(env = {}) {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [
			key.replace(/^PI_WORKFLOW_/u, "AGENT_WORKFLOW_"),
			value,
		]),
	);
}

function files(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(root, full).split(sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}

/** Byte check of a fixture's run/bundle against pi-workflow `<rev>:workflows/<name>/`. */
export function verifyBundleAgainstSource(
	loaded,
	source = process.env.PI_WORKFLOW_SOURCE,
	rev = "b83cc4f",
) {
	const { fixture, fixtureDir } = loaded;
	if (!fixture.bundledWorkflow || !source) return undefined;
	const bundle = join(fixtureDir, "run", "bundle");
	const mismatches = [];
	for (const file of files(bundle)) {
		let original;
		try {
			original = execFileSync(
				"git",
				[
					"-C",
					source,
					"show",
					`${rev}:workflows/${fixture.bundledWorkflow}/${file}`,
				],
				{ maxBuffer: 64 * 1024 * 1024 },
			);
		} catch {
			mismatches.push(`${file}: missing at ${rev}`);
			continue;
		}
		if (!original.equals(readFileSync(join(bundle, file))))
			mismatches.push(`${file}: differs from ${rev}`);
	}
	return mismatches;
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Exclusive use of a pinned replay root (`<replayRoot>.lock`, a sibling directory holding the
 * owner pid): concurrent unit runs (other worktrees, a second validate) replay the same fixture at
 * the same absolute path. A lock whose owner process is gone is taken over.
 */
export function lockReplayRoot(root, timeoutMs = 15 * 60_000) {
	const lock = `${root}.lock`;
	mkdirSync(dirname(lock), { recursive: true });
	for (const deadline = Date.now() + timeoutMs; ; ) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "owner"), String(process.pid));
			return () => rmSync(lock, { recursive: true, force: true });
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			let owner;
			try {
				owner = Number(readFileSync(join(lock, "owner"), "utf8"));
			} catch {
				owner = undefined;
			}
			if (owner !== undefined && owner > 0 && !processAlive(owner)) {
				rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline)
				throw new Error(`replay root ${root} is locked by pid ${owner}`);
			sleepSync(200);
		}
	}
}

function projectDir(loaded, work) {
	const { fixture, name } = loaded;
	if (fixture.replayRoot) {
		const release = lockReplayRoot(fixture.replayRoot);
		rmSync(fixture.replayRoot, {
			recursive: true,
			force: true,
			maxRetries: 20,
			retryDelay: 100,
		});
		mkdirSync(fixture.replayRoot, { recursive: true });
		return {
			project: fixture.replayRoot,
			cleanup: [fixture.replayRoot],
			release,
		};
	}
	if (!fixture.rootPathLength) {
		const project = join(work, "project");
		mkdirSync(project, { recursive: true });
		return { project, cleanup: [] };
	}
	// Short base so the absolute path can be padded to the recorded length.
	const short = mkdtempSync(
		join(process.platform === "win32" ? tmpdir() : "/tmp", "awr-"),
	);
	const prefix = join(short, `${name}-`);
	const pad = fixture.rootPathLength - prefix.length;
	if (pad < 1)
		throw new Error(
			`cannot pad replay project path to ${fixture.rootPathLength} characters (base ${prefix})`,
		);
	const project = `${prefix}${"p".repeat(pad)}`;
	mkdirSync(project, { recursive: true });
	return { project, cleanup: [short] };
}

/**
 * Variant `state-path-migrated` (docs/replay.md): rewrite the one form in which original bundled
 * helpers read engine state, the template literal `` `.pi/workflows/${runId}/… ``, to the renamed
 * state path (docs/core-port.md WP4b change log 1). The comparison's literal renames map the
 * rewritten text back, so the bundle still compares equal; sidecar writes built with
 * `join(cwd, ".pi", "workflows", …)` are left alone. Returns [{file, count}].
 */
export const LEGACY_STATE_PATH_LITERAL = "`.pi/workflows/";
export const MIGRATED_STATE_PATH_LITERAL = "`.agent-workflow/workflows/";

export function migrateHelperStatePaths(workflowDir) {
	const out = [];
	for (const file of files(workflowDir).filter((name) =>
		name.endsWith(".mjs"),
	)) {
		const path = join(workflowDir, file);
		const text = readFileSync(path, "utf8");
		const parts = text.split(LEGACY_STATE_PATH_LITERAL);
		if (parts.length === 1) continue;
		writeFileSync(path, parts.join(MIGRATED_STATE_PATH_LITERAL));
		out.push({ file, count: parts.length - 1 });
	}
	return out;
}

/** Recreate the recorded project and the original workflow spec location. */
export function prepareReplayProject(loaded, work, options = {}) {
	const { fixture, fixtureDir } = loaded;
	const { project, cleanup, release } = projectDir(loaded, work);
	mkdirSync(join(project, ".pi", "agents"), { recursive: true });
	for (const [agent, file] of Object.entries(fixture.projectAgents ?? {}))
		copyFileSync(
			join(fixtureDir, file),
			join(project, ".pi", "agents", `${agent}.md`),
		);
	for (const file of fixture.projectFiles ??
		(fixture.bundledWorkflow ? [] : ["NOTES.md"])) {
		mkdirSync(dirname(join(project, file)), { recursive: true });
		copyFileSync(join(fixtureDir, "project", file), join(project, file));
	}
	const pkgRoots = [PKG_ROOT];
	let specPath;
	let migratedHelpers = [];
	if (fixture.bundledWorkflow) {
		// <PKG>/workflows/<name>/spec.json in the recording; for projectIsPackageRoot <ROOT> == <PKG>.
		const specPkg = fixture.projectIsPackageRoot
			? project
			: join(work, "pi-workflow-package");
		const workflowDir = join(specPkg, "workflows", fixture.bundledWorkflow);
		mkdirSync(workflowDir, { recursive: true });
		cpSync(join(fixtureDir, "run", "bundle"), workflowDir, {
			recursive: true,
		});
		specPath = join(workflowDir, "spec.json");
		if (options.migrateStatePaths === true)
			migratedHelpers = migrateHelperStatePaths(workflowDir);
		if (!fixture.projectIsPackageRoot) pkgRoots.push(specPkg);
	} else {
		specPath = join(project, "workflow.json");
		copyFileSync(join(fixtureDir, fixture.spec), specPath);
	}
	const roots = {
		ROOT: project,
		PKG: pkgRoots,
		HOME: homedir(),
		TMP: tmpdir(),
	};
	return { project, specPath, roots, cleanup, release, migratedHelpers };
}

export function replayRunOptions(fixture) {
	return {
		task: fixture.task,
		runId: fixture.workflowRunId,
		...(fixture.executionProfile
			? { executionProfile: fixture.executionProfile }
			: {}),
		...(fixture.inputOverrides && Object.keys(fixture.inputOverrides).length > 0
			? { inputOverrides: fixture.inputOverrides }
			: {}),
	};
}

function setEnv(values, saved) {
	for (const [key, value] of Object.entries(values)) {
		if (!(key in saved)) saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

async function waitForSupervisorRelease(runDir, timeoutMs = 15_000) {
	const lock = join(runDir, "supervisor.lock");
	for (
		const deadline = Date.now() + timeoutMs;
		existsSync(lock) && Date.now() < deadline;
	)
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}

/**
 * Replay one fixture. Returns the final run record (or the refusal), the run directory and the
 * replay executor trace. `options.work` is a scratch directory (created when absent).
 */
export async function replayFixture(name, options = {}) {
	const loaded = loadFixture(name);
	const work = options.work ?? mkdtempSync(join(tmpdir(), `awr-${name}-`));
	mkdirSync(work, { recursive: true });
	const { project, specPath, roots, cleanup, release, migratedHelpers } =
		prepareReplayProject(loaded, work, options);
	const traceLog = join(work, "replay-trace.jsonl");
	const engine = await import(dist("core/engine.js"));
	const store = await import(dist("core/store.js"));
	const registry = await import(dist("core/executor-registry.js"));
	const descriptor = replayExecutorDescriptor({
		fixtureDir: loaded.fixtureDir,
		roots,
		traceLog,
		...(options.outputLimit === undefined
			? {}
			: { outputLimit: options.outputLimit }),
		...(options.adapterChecks === undefined
			? {}
			: { adapterChecks: options.adapterChecks }),
	});
	const saved = {};
	setEnv(
		{
			...renamedEnvPins(loaded.fixture.env),
			AGENT_WORKFLOW_ROLE: undefined,
			AGENT_WORKFLOW_HOST_CONTEXT: undefined,
		},
		saved,
	);
	// Explicit registration for this run: the replay stands in for the default executor `pi`.
	const unregister = registry.registerWorkflowExecutor(descriptor);
	let run;
	let refusal;
	try {
		try {
			run = await engine.runWorkflowSpec(
				specPath,
				project,
				replayRunOptions(loaded.fixture),
			);
		} catch (error) {
			refusal = {
				name: error?.name ?? "Error",
				message: String(error?.message ?? error),
				...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
			};
		}
		if (run !== undefined) {
			const deadline = Date.now() + (options.timeoutMs ?? 600_000);
			while (run.status === "running" && Date.now() < deadline) {
				try {
					run = await engine.waitForRun(project, run.runId, 30_000);
				} catch (error) {
					if (!/still running/u.test(String(error?.message))) throw error;
					run = await store.readRunRecord(project, run.runId);
				}
			}
			await store.flushPendingIndexUpdatesForTests?.();
			await waitForSupervisorRelease(store.workflowRunDir(project, run.runId));
		}
	} finally {
		unregister();
		setEnv(saved, {});
	}
	return {
		...loaded,
		work,
		project,
		specPath,
		roots,
		cleanup,
		migratedHelpers,
		release,
		run,
		refusal,
		runDir:
			run === undefined ? undefined : store.workflowRunDir(project, run.runId),
		trace: readJsonLines(traceLog),
	};
}

/** Remove the replay directories (unless `keep`) and release the replay root lock. */
export function cleanupReplay(result, { keep = false } = {}) {
	try {
		// A runtime terminal finalizer may still be draining when the run is terminal; retry.
		if (!keep)
			for (const path of [...(result.cleanup ?? []), result.work])
				if (path)
					rmSync(path, {
						recursive: true,
						force: true,
						maxRetries: 20,
						retryDelay: 100,
					});
	} finally {
		result.release?.();
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [name, ...rest] = process.argv.slice(2);
	const result = await replayFixture(name);
	console.log(
		JSON.stringify(
			{
				status: result.run?.status,
				refusal: result.refusal,
				runDir: result.runDir,
				tasks: result.run?.tasks?.map((task) => [
					task.taskId,
					task.status,
					task.statusDetail,
					task.lastMessage?.slice(0, 300),
				]),
				trace: result.trace.filter((entry) => entry.type !== "consume"),
			},
			null,
			2,
		),
	);
	cleanupReplay(result, { keep: rest.includes("--keep") });
	process.exit(0);
}
