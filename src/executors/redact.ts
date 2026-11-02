/**
 * Secret redaction shared by the executor adapters (WP12d-2 review #5). Values of
 * `SubmitRequest.env` and of injected MCP server env are replaced before anything is persisted
 * (raw transcripts, stderr logs, normalized events, error text). What the adapter sends to the CLI
 * is never redacted. `stream()` handles a value split across chunks of one byte stream (stderr):
 * a chunk tail that could start a value is held back until the next chunk or `flush()`.
 */
import { AGENT_WORKFLOW_ROLE_ENV } from "../core/process-role.js";
import type { SubmitRequest } from "../sdk/contract.js";
import type { JsonValue } from "../sdk/json.js";

// Request env the engine sets itself with a public value. Redacting it would rewrite ordinary words
// in worker output: `AGENT_WORKFLOW_ROLE=worker` (6 chars, Pi's minimum) turned every "worker" in
// Pi transcripts and answers into `[redacted]`, so deep-review quotes stopped matching the file
// (quality A/B 2026-11-02).
const PUBLIC_ENGINE_ENV_KEYS: ReadonlySet<string> = new Set([
	AGENT_WORKFLOW_ROLE_ENV,
]);

export interface StreamRedactor {
	/** Redacted text safe to persist now (a possible value prefix at the end is held back). */
	push(chunk: string): string;
	/** Whatever is held back, redacted (call at stream end). */
	flush(): string;
}

export interface SecretRedactor {
	readonly active: boolean;
	text(value: string): string;
	/** Deep copy of a JSON-like value with every string redacted (object keys are kept). */
	value<T>(value: T): T;
	stream(): StreamRedactor;
}

/**
 * `[value, label]` pairs: request env (`KEY`) and MCP server env (`server.KEY`), except the
 * engine's own public request env (`PUBLIC_ENGINE_ENV_KEYS`).
 */
export function requestSecrets(
	req: Pick<SubmitRequest, "env" | "mcpServers">,
): [string, string][] {
	const secrets: [string, string][] = [];
	for (const [key, value] of Object.entries(req.env ?? {}))
		if (typeof value === "string" && !PUBLIC_ENGINE_ENV_KEYS.has(key))
			secrets.push([value, key]);
	for (const server of req.mcpServers ?? [])
		for (const [key, value] of Object.entries(server.env ?? {}))
			if (typeof value === "string")
				secrets.push([value, `${server.name}.${key}`]);
	return secrets;
}

export function createSecretRedactor(
	pairs: readonly (readonly [string, string])[],
	options: {
		readonly minLength: number;
		readonly replacement: (label: string) => string;
	},
): SecretRedactor {
	const byValue = new Map<string, string>();
	for (const [value, label] of pairs)
		if (value.length >= options.minLength && !byValue.has(value))
			byValue.set(value, label);
	const secrets = [...byValue.entries()].sort(
		(a, b) => b[0].length - a[0].length,
	);
	const text = (input: string): string => {
		let out = input;
		for (const [value, label] of secrets)
			if (out.includes(value))
				out = out.split(value).join(options.replacement(label));
		return out;
	};
	const value = <T>(input: T): T => {
		if (secrets.length === 0) return input;
		const walk = (node: JsonValue): JsonValue => {
			if (typeof node === "string") return text(node);
			if (Array.isArray(node)) return node.map(walk);
			if (node !== null && typeof node === "object") {
				const out: Record<string, JsonValue> = {};
				for (const [key, entry] of Object.entries(node))
					if (entry !== undefined) out[key] = walk(entry);
				return out;
			}
			return node;
		};
		// Events and RPC messages are JSON-shaped (they are persisted as JSON).
		return walk(input as JsonValue) as T;
	};
	/** Length of the longest tail of `input` that is a proper prefix of some value. */
	const heldTail = (input: string): number => {
		let best = 0;
		for (const [secret] of secrets)
			for (
				let length = Math.min(secret.length - 1, input.length);
				length > best;
				length -= 1
			)
				if (input.endsWith(secret.slice(0, length))) {
					best = length;
					break;
				}
		return best;
	};
	return {
		active: secrets.length > 0,
		text: secrets.length === 0 ? (input) => input : text,
		value,
		stream(): StreamRedactor {
			let held = "";
			return {
				push(chunk) {
					if (secrets.length === 0) return chunk;
					const redacted = text(held + chunk);
					const keep = heldTail(redacted);
					held = redacted.slice(redacted.length - keep);
					return redacted.slice(0, redacted.length - keep);
				},
				flush() {
					const out = held;
					held = "";
					return out;
				},
			};
		},
	};
}
