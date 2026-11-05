// The launching host supplies the host context.
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, resolve } from "node:path";

import { agentWorkflowHome } from "./home-dir.js";

/**
 * Identity of the host (CLI, MCP server, Pi extension, …) that launched a run.
 * It is recorded once in the run record and inherited by child runs. It holds
 * references only: never persist resolved MCP configuration or credentials.
 *
 * Whether worker sessions inherit the host's own tools (Pi codemode, `mcp__*`,
 * …) is not part of this record. It is the separate, explicit
 * `inheritHostTools` compile/run option (see tool-policy.ts), honored only by
 * executors that support it (Pi, WP6).
 */
export interface HostContext {
	version: 1;
	cwd: string;
	homeDir: string;
	projectTrusted: boolean;
}

/** Immutable process-start transport for headless children (JSON HostContext). */
export const HOST_CONTEXT_ENV = "AGENT_WORKFLOW_HOST_CONTEXT";

const HOST_CONTEXT_KEYS = ["version", "cwd", "homeDir", "projectTrusted"];
const activeHostContext = new AsyncLocalStorage<HostContext | null>();

export function assertHostContext(
	value: unknown,
): asserts value is HostContext {
	if (
		value === null ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("cwd" in value) ||
		typeof value.cwd !== "string" ||
		!isAbsolute(value.cwd) ||
		!("homeDir" in value) ||
		typeof value.homeDir !== "string" ||
		!isAbsolute(value.homeDir) ||
		!("projectTrusted" in value) ||
		typeof value.projectTrusted !== "boolean" ||
		Object.keys(value).some((key) => !HOST_CONTEXT_KEYS.includes(key))
	)
		throw new Error("Invalid workflow host context");
}

/** Build the context a host records for a run it launches from `cwd`. */
export function createHostContext(options: {
	cwd: string;
	projectTrusted: boolean;
	env?: NodeJS.ProcessEnv;
}): HostContext {
	const context: HostContext = {
		version: 1,
		cwd: resolve(options.cwd),
		homeDir: resolve(agentWorkflowHome(options.env)),
		projectTrusted: options.projectTrusted,
	};
	assertHostContext(context);
	return context;
}

export function sameHostContext(
	left: HostContext,
	right: HostContext,
): boolean {
	return (
		left.version === right.version &&
		left.cwd === right.cwd &&
		left.homeDir === right.homeDir &&
		left.projectTrusted === right.projectTrusted
	);
}

/**
 * Run one launch boundary with an explicit host decision. `null` freezes
 * "no host context" across async work so the env fallback is not consulted.
 */
export function withHostContext<T>(
	context: HostContext | null,
	operation: () => T,
): T {
	if (context !== null) assertHostContext(context);
	return activeHostContext.run(
		context === null ? null : { ...context },
		operation,
	);
}

/** The host context of the current launch boundary, if any. */
export function resolveHostContext(
	env: NodeJS.ProcessEnv = process.env,
): HostContext | undefined {
	const active = activeHostContext.getStore();
	if (active !== undefined) return active === null ? undefined : { ...active };
	const inherited = env[HOST_CONTEXT_ENV];
	if (inherited === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(inherited);
	} catch {
		throw new Error("Invalid workflow host context");
	}
	assertHostContext(value);
	return { ...value };
}
