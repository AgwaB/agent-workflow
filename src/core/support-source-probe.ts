// Rehearsal evidence for support helpers (AGENT_WORKFLOW_REHEARSAL=1): which source names a helper asked
// `sources` for that are not among the sources its stage declares. A helper that looks up a wrong name
// and then declares failed/blocked is a wiring error, not a content gate, and the engine can tell without
// reading the helper's text: it saw the lookup.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SUPPORT_SOURCE_MISSES_FILE = "support-source-misses.json";

/** Names that runtime and serializers probe on any object; never a helper's source lookup. */
const PROBED_BY_RUNTIME = new Set(["toJSON", "then", "asymmetricMatch"]);

export interface SupportSourceProbe {
	/** The object the helper receives as `sources`: the real entries as own properties. */
	sources: Record<string, unknown>;
	/** Undeclared names requested so far, in first-request order. */
	misses: () => string[];
}

/**
 * Wraps the helper's `sources` so a lookup (`sources.x`, `sources["x"]`, `"x" in sources`, `Object.hasOwn`) of
 * a name that is neither present nor declared is recorded. The result is a Proxy over a plain object: its
 * prototype is `Object.prototype` (a helper's plain-object check passes, as with the engine's own object) and
 * keys, spread and JSON behave as before. A Proxy cannot be passed to `structuredClone` directly; clone a copy
 * (`structuredClone({ ...sources })`) or its entries.
 */
export function probeSupportSources(
	sources: Record<string, unknown>,
	declared: Iterable<string>,
): SupportSourceProbe {
	const known = new Set(declared);
	const missed = new Set<string>();
	const note = (name: string | symbol): void => {
		if (typeof name !== "string" || known.has(name)) return;
		if (PROBED_BY_RUNTIME.has(name)) return;
		missed.add(name);
	};
	const target: Record<string, unknown> = {};
	for (const key of Object.keys(sources)) target[key] = sources[key];
	const wrapped = new Proxy(target, {
		get(object, name, receiver) {
			if (!Reflect.has(object, name)) note(name);
			return Reflect.get(object, name, receiver);
		},
		has(object, name) {
			if (!Reflect.has(object, name)) note(name);
			return Reflect.has(object, name);
		},
		getOwnPropertyDescriptor(object, name) {
			if (!Reflect.has(object, name)) note(name);
			return Reflect.getOwnPropertyDescriptor(object, name);
		},
	});
	return { sources: wrapped, misses: () => [...missed] };
}

export async function writeSupportSourceMisses(
	taskDir: string,
	declared: readonly string[],
	misses: readonly string[],
): Promise<void> {
	if (misses.length === 0) return;
	await writeFile(
		join(taskDir, SUPPORT_SOURCE_MISSES_FILE),
		`${JSON.stringify({ declared, misses }, null, 2)}\n`,
		"utf8",
	);
}
