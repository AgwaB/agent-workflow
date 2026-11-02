// agent-workflow 2026-11-01: does a model's quote occur in a fetched page? Deterministic, strict.
// Levels, tried in order:
// - exact: the quote is a substring of a page view that does not start or end inside a word or
//   number of the page (exact and normalized levels; scripts without spaces between words exempt);
// - normalized: after folding both sides — Unicode NFKC (𝑡→t, ₜ→t, ligatures), curly quotes,
//   dashes and primes, zero-width characters, Markdown links/escapes/emphasis/code marks, `$`,
//   table pipes, runs of whitespace and spaces before closing punctuation; a quote's own trailing
//   punctuation is not compared;
// - math: additionally spaces around symbols and single letters removed, ONLY when the quote itself
//   contains math notation; spaces between words stay, so words cannot merge or split.
// Words, numbers and their order must still match; there is no edit-distance allowance (a fixed
// allowance lets changed numbers pass — the instructor reference accepts "0123456ZZZ" for
// "0123456789"). Offline check: 334 mutated quotes (numbers, negation, word swaps) 0 passed.

export type QuoteMatchLevel = "exact" | "normalized" | "math";

export type QuoteMatch =
	| {
			readonly matched: true;
			readonly level: QuoteMatchLevel;
			readonly view: number;
	  }
	| { readonly matched: false };

const ZERO_WIDTH = /[\u00ad\u200b-\u200d\u2060-\u2064\ufeff]/g;

export function foldForMatch(text: string): string {
	return text
		.normalize("NFKC")
		.replace(ZERO_WIDTH, "")
		.replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc\u00b4]/g, "'")
		.replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
		.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
		.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
		.replace(/\\([!-/:-@[-`{-~])/g, "$1")
		.replace(/[*_$`]/g, "")
		.replace(/\|/g, " ")
		.replace(/-\s+/g, "-")
		.replace(/\s+/g, " ")
		.replace(/ ([,.;:!?)\]])/g, "$1")
		.replace(/([(\[]) /g, "$1")
		.trim();
}

// Inline TeX (`$x$`, not prices like "$5 and $3"), TeX commands, sub/superscripts, math operators
// and math alphanumerics (not plain Greek, so Greek prose stays word-gap strict).
const MATH_NOTATION =
	/\$(?:[^\s$]|[^\s$][^$]*[^\s$])\$|\\[a-z]+|[_^]\{|[\u2070-\u209f\u2200-\u22ff\u27c0-\u27ef\u2980-\u2aff]|[\u{1d400}-\u{1d7ff}]/u;

export function hasMathNotation(quote: string): boolean {
	return MATH_NOTATION.test(quote);
}

// Math level: drop spaces around symbols and single letters (rendered MathML puts every token in
// its own box: "𝐿 𝑡 = { 𝑡 }"), but keep the space between two words of 2+ letters, so merged or
// split words ("based on"/"basedon", "not able"/"notable") still fail.
const KEEP = "\u0000";
const squeeze = (folded: string): string =>
	folded
		.replace(/(?<=\p{L}{2}) (?=\p{L}{2})/gu, KEEP)
		.replace(/\s+/g, "")
		.replaceAll(KEEP, " ");

/** Alternative texts of one page (rendered, TeX, de-hyphenated PDF, …), folded once. */
export class PreparedPage {
	readonly views: readonly string[];
	#folded: string[] | undefined;
	#squeezed: string[] | undefined;
	constructor(views: readonly string[]) {
		this.views = views;
	}
	get folded(): readonly string[] {
		this.#folded ??= this.views.map(foldForMatch);
		return this.#folded;
	}
	get squeezed(): readonly string[] {
		this.#squeezed ??= this.folded.map(squeeze);
		return this.#squeezed;
	}
}

// A quote's first and last characters must not continue a word or number of the page: "12% of users"
// is not in "112% of users" (quality A/B 2026-11-02 review finding). Letters of scripts written
// without spaces between words (CJK, Hangul with its attached particles, Thai, …) are exempt.
const WORD_CHAR = /[\p{L}\p{N}]/u;
const UNSPACED_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const joins = (char: string | undefined): boolean =>
	char !== undefined && WORD_CHAR.test(char) && !UNSPACED_SCRIPT.test(char);

function codePointBefore(text: string, index: number): string | undefined {
	if (index <= 0) return undefined;
	const low = text.charCodeAt(index - 1);
	const start =
		low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
	return String.fromCodePoint(text.codePointAt(start) as number);
}

function codePointAtIndex(text: string, index: number): string | undefined {
	const point = text.codePointAt(index);
	return point === undefined ? undefined : String.fromCodePoint(point);
}

/** `needle` occurs in `text` without cutting a word or number at either end. */
function containsWhole(text: string, needle: string): boolean {
	const first = codePointAtIndex(needle, 0);
	const last = codePointBefore(needle, needle.length);
	for (
		let at = text.indexOf(needle);
		at >= 0;
		at = text.indexOf(needle, at + 1)
	) {
		if (joins(first) && joins(codePointBefore(text, at))) continue;
		if (joins(last) && joins(codePointAtIndex(text, at + needle.length)))
			continue;
		return true;
	}
	return false;
}

export function matchQuote(
	quote: string,
	page: PreparedPage | readonly string[],
): QuoteMatch {
	const prepared = page instanceof PreparedPage ? page : new PreparedPage(page);
	const needle = quote.trim();
	if (needle === "") return { matched: false };
	for (const [view, text] of prepared.views.entries())
		if (containsWhole(text, needle))
			return { matched: true, level: "exact", view };
	const folded = foldForMatch(needle);
	if (folded === "") return { matched: false };
	// A quote cut from the middle of a sentence often gets a closing period the page does not have
	// there ("…eight model families." for "…eight model families: OpenAI…"); trailing punctuation is
	// not compared. Leading/inner punctuation still is.
	const body = folded.replace(/\s*[.,;:!?]+$/, "");
	const candidates =
		body.length >= 8 && body !== folded ? [folded, body] : [folded];
	for (const candidate of candidates)
		for (const [view, text] of prepared.folded.entries())
			if (containsWhole(text, candidate))
				return { matched: true, level: "normalized", view };
	if (!hasMathNotation(needle)) return { matched: false };
	const squeezed = squeeze(candidates.at(-1) as string);
	for (const [view, text] of prepared.squeezed.entries())
		if (text.includes(squeezed)) return { matched: true, level: "math", view };
	return { matched: false };
}
