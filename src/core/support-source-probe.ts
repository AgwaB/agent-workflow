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
 * Wraps the helper's `sources` so a lookup (`sources.x`, `sources["x"]`, `"x" in sources`) of a name that is
 * neither present nor declared is recorded. The entries stay own properties of a plain object (keys,
 * spread, JSON and structuredClone behave as before); only misses fall through to a prototype that records.
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
	const recorder = new Proxy(
		{},
		{
			get(target, name, receiver) {
				if (!Reflect.has(target, name)) note(name);
				return Reflect.get(target, name, receiver);
			},
			has(target, name) {
				if (!Reflect.has(target, name)) note(name);
				return Reflect.has(target, name);
			},
		},
	);
	const wrapped = Object.create(recorder) as Record<string, unknown>;
	for (const key of Object.keys(sources)) wrapped[key] = sources[key];
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
