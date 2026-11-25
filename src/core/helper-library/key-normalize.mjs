// key-normalize.mjs: shared key operations for keyed-join, coverage-gate and bundle-local code.
export const NORMALIZERS = {
	trim: (text) => text.trim(),
	lower: (text) => text.toLowerCase(),
	upper: (text) => text.toUpperCase(),
	"collapse-space": (text) => text.replace(/\s+/g, " "),
	"strip-query": (text) => text.replace(/[?#].*$/s, ""),
	"trailing-slash": (text) =>
		text.length > 1 ? text.replace(/\/+$/, "") || "/" : text,
	"leading-slash": (text) => (text.startsWith("/") ? text : `/${text}`),
	"path-params": (text) =>
		text
			.replace(/\$\{[^}/]*\}/g, "{}")
			.replace(/\{[^}/]*\}/g, "{}")
			.replace(/<[^>/]*>/g, "{}")
			.replace(/\[[^\]/]*\]/g, "{}")
			.replace(/(^|\/):[A-Za-z_][\w-]*/g, "$1{}"),
};

export function applyOps(text, ops, hooks, where) {
	let out = text;
	for (const op of ops) {
		const fn =
			typeof op === "function"
				? op
				: ((hooks && Object.hasOwn(hooks, op) ? hooks[op] : undefined) ??
					(Object.hasOwn(NORMALIZERS, op) ? NORMALIZERS[op] : undefined));
		if (typeof fn !== "function")
			throw new Error(`keyed-join: unknown normalize op "${op}" for ${where}`);
		out = fn(out);
	}
	return out;
}

/** The normalised text of one key value, or undefined when the row has none (missing, blank, object). */
export function normalizeValue(value, ops, hooks, where = "key") {
	if (typeof value === "number" || typeof value === "boolean")
		value = String(value);
	if (typeof value !== "string") return undefined;
	const out = applyOps(value, ops ?? ["trim"], hooks, where);
	return out === "" ? undefined : out;
}
