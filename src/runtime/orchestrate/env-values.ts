// New in agent-workflow (WP2c): keeps SubmitRequest.env and mcpServers[].env values off disk
// (D1: the engine stores no credentials; callers may pass API keys through env).
//
// The durable launch payload (`worker.json`) persists only the env keys (`input.envKeys`,
// `input.mcpServers[i].envKeys`). The values travel to the detached durable worker in its spawn
// environment under `AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON`, which the worker removes from
// its own `process.env` before anything else runs, and the worker rebuilds the request from both.
// The worker fails closed (guard_failure, keys named, values never) when the channel is missing or
// does not carry exactly the persisted keys. A fresh-process reconcile never relaunches, so it
// never needs the values.
import { createHash } from "node:crypto";

/** Spawn-environment variable carrying the env values from the launcher to its durable worker. */
export const DURABLE_WORKER_REQUEST_ENV =
	"AGENT_WORKFLOW_DURABLE_WORKER_REQUEST_ENV_JSON";

/** The values that are not written to `worker.json`. */
export interface DurableWorkerEnvChannel {
	env?: Record<string, string>;
	/** Per `mcpServers` index; null when that server has no env. */
	mcpServers?: Array<Record<string, string> | null>;
}

export class DurableWorkerEnvError extends Error {
	readonly failureKind = "guard_failure" as const;

	constructor(message: string) {
		super(message);
		this.name = "DurableWorkerEnvError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
	return (
		isRecord(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/**
 * Split a run input into what may be persisted (env keys only) and the values channel. Returns
 * `channel: undefined` when the input carries no env at all.
 */
export function splitEnvValues<T extends Record<string, unknown>>(
	input: T,
): { persisted: T; channel: DurableWorkerEnvChannel | undefined } {
	const persisted: Record<string, unknown> = { ...input };
	const channel: DurableWorkerEnvChannel = {};
	let carried = false;
	if (input.env !== undefined) {
		if (!isStringMap(input.env))
			throw new DurableWorkerEnvError("env must map keys to strings");
		channel.env = { ...input.env };
		persisted.envKeys = Object.keys(input.env).sort();
		delete persisted.env;
		carried = true;
	}
	if (Array.isArray(input.mcpServers)) {
		const values: Array<Record<string, string> | null> = [];
		persisted.mcpServers = input.mcpServers.map((server: unknown, index) => {
			if (!isRecord(server) || server.env === undefined) {
				values.push(null);
				return server;
			}
			if (!isStringMap(server.env))
				throw new DurableWorkerEnvError(
					`mcpServers[${index}].env must map keys to strings`,
				);
			values.push({ ...server.env });
			const { env: _values, ...rest } = server;
			return { ...rest, envKeys: Object.keys(server.env).sort() };
		});
		if (values.some((entry) => entry !== null)) {
			channel.mcpServers = values;
			carried = true;
		}
	}
	return { persisted: persisted as T, channel: carried ? channel : undefined };
}

/** Read the values channel from (and remove it from) an environment object. */
export function takeEnvChannel(
	env: NodeJS.ProcessEnv,
): DurableWorkerEnvChannel | string | undefined {
	const raw = env[DURABLE_WORKER_REQUEST_ENV];
	delete env[DURABLE_WORKER_REQUEST_ENV];
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return "the env channel is not an object";
		return parsed as DurableWorkerEnvChannel;
	} catch {
		return "the env channel is not valid JSON";
	}
}

function keyList(keys: readonly string[]): string {
	return keys.length === 0 ? "none" : keys.join(", ");
}

function restoreMap(
	label: string,
	keys: unknown,
	values: unknown,
): Record<string, string> {
	if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string"))
		throw new DurableWorkerEnvError(
			`durable worker payload ${label}Keys must be a string array`,
		);
	if (values === undefined || values === null)
		throw new DurableWorkerEnvError(
			`durable worker env channel carries no ${label} values; the payload declares keys: ${keyList(keys)}`,
		);
	if (!isStringMap(values))
		throw new DurableWorkerEnvError(
			`durable worker env channel ${label} must map keys to strings`,
		);
	const expected = [...keys].sort();
	const received = Object.keys(values).sort();
	if (
		expected.length !== received.length ||
		expected.some((key, index) => key !== received[index])
	)
		throw new DurableWorkerEnvError(
			`durable worker env channel ${label} keys (${keyList(received)}) do not match the payload (${keyList(expected)})`,
		);
	return { ...values };
}

/**
 * Rebuild the run input inside the durable worker: `envKeys` + channel values → `env`, and the same
 * per MCP server. A payload that still carries inline `env` (written before WP2c) is accepted as is
 * when it has no `envKeys`; both at once is ambiguous and refused.
 */
export function restoreEnvValues<T extends Record<string, unknown>>(
	input: T,
	channel: DurableWorkerEnvChannel | string | undefined,
): T {
	if (typeof channel === "string") throw new DurableWorkerEnvError(channel);
	const restored: Record<string, unknown> = { ...input };
	let consumedEnv = false;
	let consumedMcp = false;
	if (input.envKeys !== undefined) {
		if (input.env !== undefined)
			throw new DurableWorkerEnvError(
				"durable worker payload declares both env and envKeys",
			);
		restored.env = restoreMap("env", input.envKeys, channel?.env);
		delete restored.envKeys;
		consumedEnv = true;
	}
	if (Array.isArray(input.mcpServers)) {
		restored.mcpServers = input.mcpServers.map((server: unknown, index) => {
			if (!isRecord(server) || server.envKeys === undefined) return server;
			if (server.env !== undefined)
				throw new DurableWorkerEnvError(
					`durable worker payload mcpServers[${index}] declares both env and envKeys`,
				);
			const { envKeys, ...rest } = server;
			consumedMcp = true;
			return {
				...rest,
				env: restoreMap(
					`mcpServers[${index}].env`,
					envKeys,
					channel?.mcpServers?.[index],
				),
			};
		});
	}
	// Values the payload did not declare are never passed through.
	if (
		channel !== undefined &&
		((!consumedEnv &&
			channel.env !== undefined &&
			Object.keys(channel.env).length > 0) ||
			(!consumedMcp &&
				Array.isArray(channel.mcpServers) &&
				channel.mcpServers.some((entry) => entry !== null)))
	)
		throw new DurableWorkerEnvError(
			"durable worker env channel carries values the payload does not declare",
		);
	return restored as T;
}

/** Plan-digest form of an env map: `sha256:<hex of the UTF-8 value>` per key (see buildExecutionPlan). */
export function digestEnvValues(
	env: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [
			key,
			`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
		]),
	);
}
