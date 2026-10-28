// New in agent-workflow (WP42, WP39b review findings 3/5): the identity of the auto classifier's
// one-shot runtime runs (`.agent-workflow/workflows/auto-router-runs/run_*`), shared by the router
// that launches them and the retention sweep that deletes them. Retention deletes a directory there
// only when its record is positively identified as the router's comparison call and no live
// per-request pin covers it.
import { randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";
import { physicalDirectoryChain } from "./physical-paths.js";

/** The runtime correlation id the router's comparison call carries (workflow-router). */
export const WORKFLOW_AUTO_COMPARE_CORRELATION_ID = "workflow-auto-compare-v1";
/** Directory name below `.agent-workflow/workflows/`. */
export const AUTO_ROUTER_RUNS_DIR_NAME = "auto-router-runs";
/** The router's runs directory, relative to the project (as the runtime records `runsDir`). */
export const AUTO_ROUTER_RUNS_DIR = `${PROJECT_STATE_DIRECTORY}/workflows/${AUTO_ROUTER_RUNS_DIR_NAME}`;
/** Run ids the runtime generates (`createRunId`: `run_<base36 ms>_<6 hex>`). */
export const AUTO_ROUTER_RUN_ID_PATTERN = /^run_[0-9a-z]+_[0-9a-f]{6}$/u;
/** The runtime's run record schema version. */
const RUNTIME_RUN_RECORD_SCHEMA_VERSION = 2;

/**
 * Why a directory `name` with record `record` is NOT an identified classifier request, or
 * `undefined` when it is: a runtime-generated run id equal to the directory name, the runtime's run
 * record schema, the router's correlation id, the router's runs directory, single mode and an
 * attempts list.
 */
export function unidentifiedClassifierReason(
	record: unknown,
	name: string,
): string | undefined {
	if (!AUTO_ROUTER_RUN_ID_PATTERN.test(name)) return "not a runtime run id";
	if (typeof record !== "object" || record === null || Array.isArray(record))
		return "run record is not an object";
	const value = record as Record<string, unknown>;
	if (value.schemaVersion !== RUNTIME_RUN_RECORD_SCHEMA_VERSION)
		return "not a runtime run record";
	if (value.runId !== name) return "run id does not match its directory";
	if (value.correlationId !== WORKFLOW_AUTO_COMPARE_CORRELATION_ID)
		return "not the router's comparison call";
	if (value.runsDir !== AUTO_ROUTER_RUNS_DIR)
		return "recorded for another runs directory";
	if (value.mode !== "single" || !Array.isArray(value.attempts))
		return "not a one-shot runtime run";
	return undefined;
}

/** WP42 (finding 5): per-request pins below the router's runs directory (hidden: never a run). */
export const AUTO_ROUTER_PINS_DIR = ".pins";
const AUTO_ROUTER_PIN_SCHEMA = "agent-workflow-auto-router-pin-v1";
/** A pin protects classifier records updated from this long before it was taken. */
const AUTO_ROUTER_PIN_SKEW_MS = 2_000;

export interface AutoRouterPin {
	release(): Promise<void>;
}

/**
 * WP42 (WP39b review, finding 5): pin the classifier requests of this process from before the
 * comparison call is launched until its output has been consumed. Retention keeps every classifier
 * record updated after a live pin was taken. The pin is a file `<pid>-<random>.json` in
 * `auto-router-runs/.pins/`, created only through a chain of real directories inside the project;
 * when that is impossible (for example a symlinked state directory, which retention never deletes
 * through either) the call runs unpinned and `undefined` is returned.
 */
export async function acquireAutoRouterPin(
	cwd: string,
): Promise<AutoRouterPin | undefined> {
	try {
		const base = await realpath(resolve(cwd));
		const segments = [
			PROJECT_STATE_DIRECTORY,
			"workflows",
			AUTO_ROUTER_RUNS_DIR_NAME,
			AUTO_ROUTER_PINS_DIR,
		];
		let pins = "";
		for (let index = 1; index <= segments.length; index += 1) {
			const chain = await physicalDirectoryChain(
				base,
				segments.slice(0, index),
			);
			if (!chain.exists)
				await mkdir(chain.path).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				});
			const checked = await physicalDirectoryChain(
				base,
				segments.slice(0, index),
			);
			if (!checked.exists) return undefined;
			pins = checked.path;
		}
		const name = `${process.pid}-${randomBytes(6).toString("hex")}.json`;
		const staged = join(pins, `.${name}.tmp`);
		await writeFile(
			staged,
			`${JSON.stringify({
				schema: AUTO_ROUTER_PIN_SCHEMA,
				pid: process.pid,
				createdAt: new Date().toISOString(),
			})}\n`,
			{ flag: "wx" },
		);
		await rename(staged, join(pins, name));
		let released = false;
		return {
			async release() {
				if (released) return;
				released = true;
				await rm(join(pins, name), { force: true }).catch(() => undefined);
			},
		};
	} catch {
		return undefined;
	}
}

export interface AutoRouterPinState {
	/**
	 * Classifier records updated at or after this time (ms) are pinned; `-Infinity` pins all
	 * (an unreadable pin); undefined: nothing is pinned.
	 */
	pinnedSince?: number;
}

/**
 * The live pins in `<root>/.pins` (`root`: the physical auto-router-runs directory). A pin whose
 * process is gone is stale (removed when `removeStale`); a malformed pin or an unsafe pins
 * directory pins everything (when in doubt, keep).
 */
export async function readAutoRouterPins(
	root: string,
	removeStale = false,
): Promise<AutoRouterPinState> {
	const pins = join(root, AUTO_ROUTER_PINS_DIR);
	let chain;
	try {
		chain = await physicalDirectoryChain(root, [AUTO_ROUTER_PINS_DIR]);
	} catch {
		return { pinnedSince: Number.NEGATIVE_INFINITY };
	}
	if (!chain.exists) return {};
	let pinnedSince: number | undefined;
	const pin = (since: number) => {
		pinnedSince =
			pinnedSince === undefined ? since : Math.min(pinnedSince, since);
	};
	let names: string[];
	try {
		names = await readdir(pins);
	} catch {
		return { pinnedSince: Number.NEGATIVE_INFINITY };
	}
	for (const name of names) {
		// A pin being staged is taken before its request launches: nothing to protect yet.
		if (name.startsWith(".")) continue;
		const file = join(pins, name);
		try {
			const info = await lstat(file);
			if (!info.isFile() || info.isSymbolicLink()) {
				pin(Number.NEGATIVE_INFINITY);
				continue;
			}
			const value = JSON.parse(await readFile(file, "utf8")) as {
				schema?: unknown;
				pid?: unknown;
				createdAt?: unknown;
			};
			const createdAt =
				typeof value.createdAt === "string"
					? Date.parse(value.createdAt)
					: Number.NaN;
			if (
				value.schema !== AUTO_ROUTER_PIN_SCHEMA ||
				typeof value.pid !== "number" ||
				!Number.isInteger(value.pid) ||
				value.pid <= 0 ||
				!Number.isFinite(createdAt)
			) {
				pin(Number.NEGATIVE_INFINITY);
				continue;
			}
			if (processAlive(value.pid)) pin(createdAt - AUTO_ROUTER_PIN_SKEW_MS);
			else if (removeStale) await rm(file, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			pin(Number.NEGATIVE_INFINITY);
		}
	}
	return pinnedSince === undefined ? {} : { pinnedSince };
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
