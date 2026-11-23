// Static check for support helpers: a literal lookup of a source name the stage cannot receive.
// A helper that asks `sources` for a wrong name and then declares failed/blocked looks like a content gate
// but is a wiring error. The helper is not instrumented: the text is scanned (literal keys only, comments and
// strings blanked), so `validate`, `compile` and `rehearse` agree and the helper runs as it does in the engine.

/** Marks the warning text; `rehearse` reports warnings of this kind as wiring findings. */
export const SUPPORT_SOURCE_LOOKUP_WARNING =
	/\bsupport helper "[^"]*" looks up source "/u;

/** Names the runtime and serializers probe on any object; never a helper's source lookup. */
const PROBED_BY_RUNTIME = new Set(["toJSON", "then", "asymmetricMatch"]);

interface BlankedSource {
	code: string;
	strings: string[];
}

/**
 * Replaces comments with spaces and string literals with `"S<n>"` (n indexes `strings`; a literal with a
 * substitution or an escape becomes `"T"` and is never matched). Returns undefined for text it cannot tokenize.
 */
function blank(text: string): BlankedSource | undefined {
	const strings: string[] = [];
	let code = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index]!;
		const next = text[index + 1];
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = text.indexOf("*/", index + 2);
			if (end === -1) return undefined;
			code += " ";
			index = end + 2;
			continue;
		}
		if (char === '"' || char === "'") {
			let value = "";
			let dynamic = false;
			index += 1;
			for (;;) {
				const current = text[index];
				if (current === undefined || current === "\n") return undefined;
				if (current === char) break;
				if (current === "\\") {
					dynamic = true;
					index += 2;
					continue;
				}
				value += current;
				index += 1;
			}
			index += 1;
			if (dynamic) code += '"T"';
			else code += `"S${strings.push(value) - 1}"`;
			continue;
		}
		if (char === "`") {
			let value = "";
			let dynamic = false;
			index += 1;
			for (;;) {
				const current = text[index];
				if (current === undefined) return undefined;
				if (current === "`") break;
				if (current === "\\") {
					dynamic = true;
					index += 2;
					continue;
				}
				if (current === "$" && text[index + 1] === "{") {
					dynamic = true;
					let depth = 0;
					while (index < text.length) {
						if (text[index] === "{") depth += 1;
						else if (text[index] === "}" && (depth -= 1) === 0) break;
						index += 1;
					}
					index += 1;
					continue;
				}
				value += current;
				index += 1;
			}
			index += 1;
			if (dynamic) code += '"T"';
			else code += `"S${strings.push(value) - 1}"`;
			continue;
		}
		code += char;
		index += 1;
	}
	return { code, strings };
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const SRC = String.raw`(?<![\w$.])sources(?![\w$])`;
const WRITE = String.raw`\s*(?:\+\+|--|(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|\|\||&&)?=(?![=>]))`;
const SHADOWED = new RegExp(
	[
		String.raw`\b(?:const|let|var)\s+sources\b`,
		String.raw`\bfunction\s*[\w$]*\s*\(\s*sources\b`,
		String.raw`\(\s*(?:[^()]*,\s*)?sources\s*(?:=[^()]*)?\)\s*=>`,
		String.raw`${SRC}\s*=>`,
		String.raw`${SRC}\s*=(?![=>])`,
	].join("|"),
	"u",
);

function patternNames(
	code: string,
	strings: readonly string[],
	pattern: RegExp,
	group: number,
	kind: "name" | "string",
	written: Set<string>,
	names: string[],
): void {
	for (const match of code.matchAll(pattern)) {
		const raw = match[group];
		if (raw === undefined) continue;
		const name = kind === "string" ? strings[Number(raw)] : raw;
		if (name === undefined) continue;
		const rest = code.slice((match.index ?? 0) + match[0].length);
		const before = code.slice(0, match.index ?? 0);
		if (
			new RegExp(`^${WRITE}`, "u").test(rest) ||
			/\bdelete\s*$/u.test(before)
		) {
			written.add(name);
			continue;
		}
		names.push(name);
	}
}

/** Property names of an object-pattern body (`a, b: c, "d": e = 1, ...rest`). */
function patternBodyNames(body: string, strings: readonly string[]): string[] {
	const out: string[] = [];
	let depth = 0;
	let part = "";
	const flush = (): void => {
		const text = part.trim();
		part = "";
		if (text === "" || text.startsWith("...")) return;
		const quoted = /^"S(\d+)"/u.exec(text);
		if (quoted) {
			const value = strings[Number(quoted[1])];
			if (value !== undefined) out.push(value);
			return;
		}
		const named = new RegExp(`^(${ID})`, "u").exec(text);
		if (named) out.push(named[1]!);
	};
	for (const char of body) {
		if (char === "{" || char === "[" || char === "(") depth += 1;
		else if (char === "}" || char === "]" || char === ")") depth -= 1;
		if (char === "," && depth === 0) flush();
		else part += char;
	}
	flush();
	return out;
}

/** Literal source names a helper's text looks up on its `sources` argument, first-seen order, without writes. */
export function literalSourceLookups(text: string): string[] {
	const blanked = blank(text);
	if (blanked === undefined) return [];
	const { code, strings } = blanked;
	if (SHADOWED.test(code)) return [];
	const written = new Set<string>();
	const names: string[] = [];
	const scan = (
		pattern: string,
		group: number,
		kind: "name" | "string",
	): void =>
		patternNames(
			code,
			strings,
			new RegExp(pattern, "gu"),
			group,
			kind,
			written,
			names,
		);
	// sources.name, sources?.name
	scan(String.raw`${SRC}\s*\??\.\s*(${ID})`, 1, "name");
	// sources["name"], sources?.["name"]
	scan(String.raw`${SRC}\s*(?:\?\.)?\s*\[\s*"S(\d+)"\s*\]`, 1, "string");
	// Object.hasOwn(sources, "name"), hasOwnProperty.call(sources, "name"), Reflect.has(sources, "name")
	scan(
		String.raw`\b(?:hasOwn|call|has|get)\s*\(\s*sources\s*,\s*"S(\d+)"`,
		1,
		"string",
	);
	// sources.hasOwnProperty("name")
	scan(
		String.raw`${SRC}\s*\.\s*(?:hasOwnProperty|propertyIsEnumerable)\s*\(\s*"S(\d+)"`,
		1,
		"string",
	);
	// "name" in sources
	scan(String.raw`"S(\d+)"\s+in\s+sources(?![\w$])`, 1, "string");
	// const { name } = sources;  /  { sources: { name } }
	for (const pattern of [
		/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*sources(?![\w$.[(])/gu,
		/[{,]\s*sources\s*:\s*\{([^{}]*)\}/gu,
	])
		for (const match of code.matchAll(pattern))
			names.push(...patternBodyNames(match[1] ?? "", strings));
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		if (seen.has(name) || written.has(name)) continue;
		seen.add(name);
		if (PROBED_BY_RUNTIME.has(name) || name in Object.prototype) continue;
		result.push(name);
	}
	return result;
}

/**
 * True when `name` can be a key of `sources` for a stage fed by `from` ids. Source keys are the stage id (a foreach
 * stage's first item), `<stage>.<item>` for the other items, `<stage>.main|item|controller|output…` and
 * `<loop>.<child>`; inside a container the sibling id is namespaced, so a nested stage also matches by suffix.
 */
export function sourceNameReachable(
	name: string,
	from: readonly string[],
	nested: boolean,
): boolean {
	return from.some(
		(id) =>
			name === id ||
			name.startsWith(`${id}.`) ||
			(nested && (name.endsWith(`.${id}`) || name.includes(`.${id}.`))),
	);
}
