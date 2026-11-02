// agent-workflow 2026-11-01: page text for engine-side quote checks (no dependencies).
// An HTML page yields a rendered view (what a reader sees; MathML TeX annotations dropped) and,
// when the page has MathML, a TeX view where each formula is its `alttext` between `$` — models
// quote formulas either way (offline sample: arXiv HTML, 3 rendered + 1 TeX quotes).
// The extraction is deliberately crude: matching folds whitespace and markup, so exact layout does
// not matter, and nothing here decides a verdict on its own.

export interface PageTextViews {
	/** Text a reader sees. */
	readonly rendered: string;
	/** Formulas as `$tex$`; only for pages with MathML. */
	readonly tex?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
	ndash: "\u2013",
	mdash: "\u2014",
	lsquo: "\u2018",
	rsquo: "\u2019",
	sbquo: "\u201a",
	ldquo: "\u201c",
	rdquo: "\u201d",
	bdquo: "\u201e",
	hellip: "\u2026",
	laquo: "\u00ab",
	raquo: "\u00bb",
	middot: "\u00b7",
	bull: "\u2022",
	times: "\u00d7",
	divide: "\u00f7",
	minus: "\u2212",
	plusmn: "\u00b1",
	deg: "\u00b0",
	le: "\u2264",
	ge: "\u2265",
	ne: "\u2260",
	asymp: "\u2248",
	infin: "\u221e",
	copy: "\u00a9",
	reg: "\u00ae",
	trade: "\u2122",
	sect: "\u00a7",
	para: "\u00b6",
	thinsp: "\u2009",
	ensp: "\u2002",
	emsp: "\u2003",
	zwj: "\u200d",
	zwnj: "\u200c",
	shy: "\u00ad",
	prime: "\u2032",
	Prime: "\u2033",
	larr: "\u2190",
	rarr: "\u2192",
	harr: "\u2194",
	euro: "\u20ac",
	pound: "\u00a3",
	yen: "\u00a5",
	cent: "\u00a2",
	micro: "\u00b5",
	alpha: "\u03b1",
	beta: "\u03b2",
	gamma: "\u03b3",
	delta: "\u03b4",
	epsilon: "\u03b5",
	lambda: "\u03bb",
	mu: "\u03bc",
	pi: "\u03c0",
	sigma: "\u03c3",
	theta: "\u03b8",
	omega: "\u03c9",
};

export function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi,
		(whole, body: string) => {
			if (body[0] === "#") {
				const code =
					body[1] === "x" || body[1] === "X"
						? Number.parseInt(body.slice(2), 16)
						: Number.parseInt(body.slice(1), 10);
				return Number.isInteger(code) && code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: whole;
			}
			return NAMED_ENTITIES[body] ?? whole;
		},
	);
}

// Every pattern here stays linear on hostile pages (the 2026-11-02 quality A/B reviews: unclosed
// `<` made the old tag/element regexes quadratic — 160 KB took 15 s, blocking the event loop outside
// the fetch timeout). A tag, with quoted attribute values that may contain `>`; neither a tag nor a
// quoted value runs past the next `<`, so a failed match costs at most the distance to it.
const TAG = /<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/g;
const BLOCK_TAG =
	/^<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|thead|tbody|tfoot|table|caption|h[1-6]|section|article|header|footer|nav|aside|main|blockquote|pre|figure|figcaption|details|summary|form|fieldset|legend|address|center|option)\b/i;

/**
 * Replace each `<name …>…</name>` (up to the nearest closing tag) in one forward scan. Once no
 * closing tag follows an opening one, none follows any later opening either, so the scan stops and
 * the rest stays as it is (what the former lazy regex left unmatched).
 */
function replaceElements(
	html: string,
	name: string,
	replace: (element: string, open: string, inner: string) => string,
): string {
	const open = new RegExp(`<${name}\\b(?:[^<>"']|"[^"<]*"|'[^'<]*')*>`, "gi");
	const close = new RegExp(`<\\/${name}\\s*>`, "gi");
	let out = "";
	let from = 0;
	for (;;) {
		open.lastIndex = from;
		const opened = open.exec(html);
		if (opened === null) break;
		const innerStart = opened.index + opened[0].length;
		close.lastIndex = innerStart;
		const closed = close.exec(html);
		if (closed === null) break;
		const end = closed.index + closed[0].length;
		out +=
			html.slice(from, opened.index) +
			replace(
				html.slice(opened.index, end),
				opened[0],
				html.slice(innerStart, closed.index),
			);
		from = end;
	}
	return out + html.slice(from);
}

function dropElements(html: string, names: readonly string[]): string {
	let out = html;
	for (const name of names) out = replaceElements(out, name, () => " ");
	return out;
}

function dropComments(html: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const start = html.indexOf("<!--", from);
		if (start < 0) break;
		const end = html.indexOf("-->", start + 4);
		if (end < 0) break;
		out += `${html.slice(from, start)} `;
		from = end + 3;
	}
	return out + html.slice(from);
}

function stripTags(html: string): string {
	const text = html.replace(TAG, (tag) => (BLOCK_TAG.test(tag) ? "\n" : ""));
	return decodeHtmlEntities(text)
		.replace(/[ \t\f\r\u00a0]+/g, " ")
		.replace(/ ?\n[\s]*/g, "\n")
		.trim();
}

function attribute(tag: string, name: string): string | undefined {
	const match = tag.match(
		new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
	);
	if (!match) return undefined;
	return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

function texOf(mathElement: string): string {
	const open = mathElement.match(
		/^<math\b(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/i,
	)?.[0];
	const alt = open === undefined ? undefined : attribute(open, "alttext");
	if (alt?.trim()) return alt.trim();
	let annotation: string | undefined;
	replaceElements(
		mathElement,
		"annotation",
		(element, annotationOpen, inner) => {
			if (
				annotation === undefined &&
				/\sencoding\s*=\s*["']application\/x-tex["']/i.test(annotationOpen)
			)
				annotation = inner;
			return element;
		},
	);
	if (annotation?.trim()) return decodeHtmlEntities(annotation.trim());
	return stripTags(dropElements(mathElement, ["annotation", "annotation-xml"]));
}

export function htmlToTextViews(html: string): PageTextViews {
	const body = dropElements(dropComments(html), [
		"script",
		"style",
		"template",
		"svg",
		"head",
	]);
	const rendered = stripTags(
		dropElements(body, ["annotation", "annotation-xml"]),
	);
	if (!/<math\b/i.test(body)) return { rendered };
	const tex = stripTags(
		replaceElements(body, "math", (math) => ` $${texOf(math)}$ `),
	);
	return { rendered, tex };
}
