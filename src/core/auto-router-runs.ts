// New in agent-workflow (WP42, WP39b review findings 3/5): the identity of the auto classifier's
// one-shot runtime runs (`.agent-workflow/workflows/auto-router-runs/run_*`), shared by the router
// that launches them and the retention sweep that deletes them. Retention deletes a directory there
// only when its record is positively identified as the router's comparison call.
import { PROJECT_STATE_DIRECTORY } from "./home-dir.js";

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
