// Static check for support helpers: a literal lookup of a source name the stage cannot receive.
// A helper that asks `sources` for a wrong name and then declares failed/blocked looks like a content gate
// but is a wiring error. The helper is not instrumented: the text is scanned (literal keys only, comments and
// strings blanked), so `validate`, `compile` and `rehearse` agree and the helper runs as it does in the engine.
// The result is advisory: a warning `rehearse` prints, never a rehearsal finding; when unsure it says nothing.

/** Names the runtime and serializers probe on any object; never a helper's source lookup. */
const PROBED_BY_RUNTIME = new Set(["toJSON", "then", "asymmetricMatch"]);

interface BlankedSource {
	code: string;
	strings: string[];
}

/** Words after which a `/` starts a regular expression (after any other word, a number or `)`/`]` it divides). */
const REGEX_AFTER_WORD = new Set([
	"return",
	"typeof",
	"case",
	"in",
	"of",
	"void",
	"delete",
	"throw",
	"new",
	"instanceof",
	"else",
	"do",
	"yield",
	"await",
]);

/** Words whose parenthesised head is followed by a statement, so a `/` after its `)` starts a regular expression. */
const CONTROL_HEAD = new Set(["if", "while", "for", "with"]);

/** True when the `)` ending `tail` closes the head of an if/while/for/with statement (not a call or a group). */
function closesControlHead(tail: string): boolean {
	let depth = 0;
	for (let at = tail.length - 1; at >= 0; at -= 1) {
		const char = tail[at]!;
		if (char === ")" || char === "]" || char === "}") depth += 1;
		else if (char === "(" || char === "[" || char === "{") {
			depth -= 1;
			if (depth === 0) {
				if (char !== "(") return false;
				const word = /[A-Za-z_$][\w$]*(?:\s+await)?\s*$/u.exec(
					tail.slice(0, at),
				)?.[0];
				const head = word?.trim().split(/\s+/u)[0];
				// `x.if (a) / 2` is a method call; a property named like a keyword is not a head
				return (
					head !== undefined &&
					CONTROL_HEAD.has(head) &&
					!/\.\s*[\w$]+\s*$/u.test(tail.slice(0, at))
				);
			}
		}
	}
	return false;
}

function regexMayStart(code: string): boolean {
	const tail = code.trimEnd();
	const last = tail.at(-1);
	if (last === undefined) return true;
	// a postfix `x++ / 2` divides; a prefix `++` cannot be followed by a regexp
	if (tail.endsWith("++") || tail.endsWith("--")) return false;
	if (last === ")") return closesControlHead(tail);
	if (/[\w$]/u.test(last)) {
		const word = /[A-Za-z_$][\w$]*$/u.exec(tail)?.[0];
		return word !== undefined && REGEX_AFTER_WORD.has(word);
	}
	return "(,=:[!&|?{};+-*%<>~^".includes(last);
}

/**
 * Replaces comments with spaces, string and regular-expression literals with `"S<n>"` (n indexes `strings`) or
 * `"T"` (a literal with an escape, a regexp: never matched), and a template literal with `"T"` followed by its
 * `${…}` expressions as code, `("T",(expr),…)`, so an expression inside one is scanned and its text is not.
 * Returns undefined for text it cannot tokenize; the caller then declines to judge.
 */
function blank(text: string): BlankedSource | undefined {
	const strings: string[] = [];
	let index = 0;
	// Scans code up to the end of the text, or, inside a template substitution, to its closing brace.
	const scan = (inSubstitution: boolean): string | undefined => {
		let code = "";
		let depth = 0;
		while (index < text.length) {
			const char = text[index]!;
			const next = text[index + 1];
			if (inSubstitution) {
				if (char === "{") depth += 1;
				else if (char === "}") {
					if (depth === 0) {
						index += 1;
						return code;
					}
					depth -= 1;
				}
			}
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
			if (char === "/" && regexMayStart(code)) {
				index += 1;
				let inClass = false;
				for (;;) {
					const current = text[index];
					if (current === undefined || current === "\n") return undefined;
					if (current === "\\") {
						index += 2;
						continue;
					}
					if (current === "[") inClass = true;
					else if (current === "]") inClass = false;
					else if (current === "/" && !inClass) break;
					index += 1;
				}
				index += 1;
				while (/[a-z]/u.test(text[index] ?? "")) index += 1;
				code += '"T"';
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
				const expressions: string[] = [];
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
						index += 2;
						const expression = scan(true);
						if (expression === undefined) return undefined;
						expressions.push(expression);
						continue;
					}
					value += current;
					index += 1;
				}
				index += 1;
				if (expressions.length > 0)
					code += `("T"${expressions.map((expression) => `,(${expression})`).join("")})`;
				else if (dynamic) code += '"T"';
				else code += `"S${strings.push(value) - 1}"`;
				continue;
			}
			code += char;
			index += 1;
		}
		return inSubstitution ? undefined : code;
	};
	const code = scan(false);
	return code === undefined ? undefined : { code, strings };
}

/** Literal relative imports (including re-exports and literal import()) without executing a helper. */
export function literalModuleImports(text: string): string[] {
	const blanked = blank(text);
	if (!blanked) return [];
	const imports =
		/(?<![\w$.])(?:import\s*\(\s*"S(\d+)"\s*(?=[,)])|(?:import\s*|(?:import|export)\s+[\w$*,\s{}]*?\bfrom\s*)"S(\d+)")/gu;
	return [...blanked.code.matchAll(imports)].flatMap((match) => {
		const value = blanked.strings[Number(match[1] ?? match[2])];
		return value?.startsWith("./") || value?.startsWith("../") ? [value] : [];
	});
}

const ID = String.raw`[A-Za-z_$][\w$]*`;
const SRC = String.raw`(?<![\w$.])sources(?![\w$])`;
const WRITE = String.raw`\s*(?:\+\+|--|(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|\|\||&&)?=(?![=>]))`;
const SHADOWED = new RegExp(
	[
		String.raw`\b(?:const|let|var)\s+sources\b`,
		String.raw`\bfunction\s*[\w$]*\s*\(\s*sources\b`,
		String.raw`\(\s*(?:[^(){}]*,\s*)?sources\s*(?:=[^()]*)?\)\s*=>`,
		String.raw`${SRC}\s*=>`,
	].join("|"),
	"u",
);

/** Index of the bracket that encloses `index`, or -1. */
function enclosingOpen(code: string, index: number): number {
	let depth = 0;
	for (let at = index - 1; at >= 0; at -= 1) {
		const char = code[at]!;
		if (char === ")" || char === "]" || char === "}") depth += 1;
		else if (char === "(" || char === "[" || char === "{") {
			if (depth === 0) return at;
			depth -= 1;
		}
	}
	return -1;
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchingClose(code: string, open: number): number {
	let depth = 0;
	for (let at = open; at < code.length; at += 1) {
		const char = code[at]!;
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			depth -= 1;
			if (depth === 0) return at;
		}
	}
	return -1;
}

/**
 * Index just past a default (`= expression`) that follows at `from`, up to the `,`, `)`, `]` or `}` that ends it
 * at the same depth; `from` itself when no default follows. The expression may hold any balanced brackets.
 */
function skipDefault(code: string, from: number): number {
	const start = /^\s*=(?![=>])/u.exec(code.slice(from));
	if (!start) return from;
	let depth = 0;
	for (let at = from + start[0].length; at < code.length; at += 1) {
		const char = code[at]!;
		if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) return at;
			depth -= 1;
		} else if (char === "," && depth === 0) return at;
	}
	return from;
}

/**
 * True when the `{` at `open` is a binding pattern: it follows `const`/`let`/`var` and is assigned, or it is a
 * parameter of a function or arrow (`({ … }) =>`, `({ … } = {}) {`). An object literal, a call argument and
 * anything else is not; an enclosing pattern level (`{ a: { … } }`) is followed up.
 */
function isBindingPattern(code: string, open: number): boolean {
	let current = open;
	for (;;) {
		const close = matchingClose(code, current);
		if (close === -1) return false;
		const after = code.slice(close + 1);
		const before = code.slice(0, current);
		if (/\b(?:const|let|var)\s*$/u.test(before) && /^\s*=(?![=>])/u.test(after))
			return true;
		// a default on the whole pattern (`({ … } = {}) =>`) may hold any balanced expression
		const rest = code.slice(skipDefault(code, close + 1));
		if (/^\s*\)\s*(?:=>|\{)/u.test(rest)) return true;
		if (!/^\s*[,}]/u.test(rest)) return false;
		const outer = enclosingOpen(code, current);
		if (outer === -1 || code[outer] !== "{") return false;
		current = outer;
	}
}

/**
 * True when the helper reassigns or redeclares `sources` itself. A default in a destructuring pattern
 * (`({ sources = {} })`) names the argument's own property and rebinds nothing; a reassignment, or anything not
 * clearly a pattern, does (the helper is then not judged).
 */
function rebindsSources(code: string): boolean {
	if (SHADOWED.test(code)) return true;
	for (const match of code.matchAll(new RegExp(`${SRC}\\s*=(?![=>])`, "gu"))) {
		const index = match.index ?? 0;
		const previous = code.slice(0, index).trimEnd().at(-1);
		if (previous !== "{" && previous !== ",") return true;
		const open = enclosingOpen(code, index);
		// A block (the function body, `{ sources = x; }`) is not a pattern: that is a reassignment.
		if (open === -1 || code[open] !== "{" || !isBindingPattern(code, open))
			return true;
	}
	return false;
}

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
	if (rebindsSources(code)) return [];
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
	// (`"x" in sources.a` is a field check on a declared source, not a lookup)
	scan(
		String.raw`"S(\d+)"\s+in\s+sources(?![\w$])(?!\s*(?:\??\.|\[))`,
		1,
		"string",
	);
	// const { name } = sources;  /  a parameter or declaration pattern { sources: { name } } (an object literal
	// that builds `{ sources: { … } }` is construction, not a lookup)
	for (const match of code.matchAll(
		/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*sources(?![\w$.[(])/gu,
	))
		names.push(...patternBodyNames(match[1] ?? "", strings));
	for (const match of code.matchAll(/[{,]\s*sources\s*:\s*\{([^{}]*)\}/gu)) {
		const open = enclosingOpen(
			code,
			(match.index ?? 0) + match[0].indexOf("sources"),
		);
		if (open !== -1 && code[open] === "{" && isBindingPattern(code, open))
			names.push(...patternBodyNames(match[1] ?? "", strings));
	}
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
