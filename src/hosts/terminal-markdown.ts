// This is a terminal reading view of our Markdown, not a CommonMark/HTML renderer.
const namedEntities: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00a0",
};
const entity = /&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|lt|gt|quot|apos|nbsp));/g;
const entityAt = new RegExp(entity.source, "y");
function decodeProse(text: string): string {
	return text.replace(entity, (_, decimal, hex, name) => {
		if (name) return namedEntities[name];
		const value =
			decimal === undefined ? Number.parseInt(hex, 16) : Number(decimal);
		return value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)
			? "\ufffd"
			: String.fromCodePoint(value);
	});
}

/** Keep line feeds, tabs and RTL letters; expose invisible direction controls. */
export function terminalText(text: string): string {
	return text
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(
			/\p{Bidi_Control}/gu,
			(char) =>
				`\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
		);
}

// Match links/images as atoms, before interpreting delimiters in a destination.
// Angle destinations and the usual bare destinations with balanced parentheses.
const link =
	/(!?)\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>\n]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))*))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/y;
const targetToken = new RegExp(
	/\\([!-/:-@\[-`{-~])/.source + "|" + entity.source,
	"g",
);
const delimiter = /`+|\*{1,3}|_{1,3}/y;
const punctuation = /[!-/:-@\[-`{-~]/;

function inline(
	raw: string,
	legacyGtEscape: boolean,
	allowLinks = true,
): string {
	const parts: string[] = [];
	const emphasis: { marker: string; part: number }[] = [];
	for (let i = 0; i < raw.length; ) {
		const c = raw[i];
		if (c === "\\") {
			if (legacyGtEscape && raw.startsWith("\\&gt;", i)) {
				parts.push(">");
				i += 5;
				continue;
			}
			if (i + 1 < raw.length && punctuation.test(raw[i + 1])) {
				parts.push(raw[i + 1]);
				i += 2;
				continue;
			}
		}
		if (allowLinks && (c === "[" || c === "!")) {
			link.lastIndex = i;
			const match = link.exec(raw);
			if (match) {
				const end = link.lastIndex;
				const label = inline(match[2], legacyGtEscape, false);
				const target = (match[3] ?? match[4]).replace(
					targetToken,
					(token, escaped) => escaped ?? decodeProse(token),
				);
				parts.push(
					match[1]
						? `[image${label ? `: ${label}` : ""}] (${target})`
						: label === target || !target
							? label
							: label
								? `${label} (${target})`
								: target,
				);
				i = end;
				continue;
			}
		}
		if (c === "&") {
			entityAt.lastIndex = i;
			const match = entityAt.exec(raw);
			if (match) {
				i += match[0].length;
				parts.push(decodeProse(match[0]));
				continue;
			}
		}
		if (c === "`" || c === "*" || c === "_") {
			delimiter.lastIndex = i;
			const marker = delimiter.exec(raw)?.[0];
			if (marker) {
				const start = i;
				i += marker.length;
				if (c === "`") {
					const ticks = /`+/g;
					ticks.lastIndex = i;
					for (let close = ticks.exec(raw); close; close = ticks.exec(raw)) {
						if (close[0].length !== marker.length) continue;
						const code = raw.slice(i, close.index).replace(/\n/g, " ");
						parts.push(
							/^ .* $/.test(code) && /[^ ]/.test(code)
								? code.slice(1, -1)
								: code,
						);
						i = ticks.lastIndex;
						break;
					}
					if (i === start + marker.length) parts.push(marker);
					continue;
				}
				const left = raw[start - 1] ?? " ";
				const right = raw[i] ?? " ";
				const wordUnderscore =
					c === "_" &&
					/[\p{L}\p{N}]/u.test(left) &&
					/[\p{L}\p{N}]/u.test(right);
				const open = emphasis.at(-1);
				if (!wordUnderscore && open?.marker === marker && /\S/.test(left)) {
					parts[open.part] = "";
					emphasis.pop();
					continue;
				}
				if (!wordUnderscore && /\S/.test(right))
					emphasis.push({ marker, part: parts.length });
				parts.push(marker);
				continue;
			}
		}
		// Leave ~~deletions~~ visibly marked in plain text.
		parts.push(c);
		i++;
	}
	return parts.join("");
}

function tableCells(line: string): string[] {
	// GFM's table escape is removed even within a code cell.
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
const tableSeparator = /^ *\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|? *$/;

/** Render completion Markdown without opening links, loading images or interpreting HTML. */
export function completionPlainText(
	source: string,
	legacyGtEscape = false,
): string {
	const prose = (text: string) => inline(text, legacyGtEscape);
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const output: string[] = [];
	// Inline code spans may cross soft line breaks, but not block boundaries.
	const paragraph: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length) output.push(prose(paragraph.join("\n")));
		paragraph.length = 0;
	};
	let quoted = false;
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const run = /^ *(?<fence>`{3,}|~{3,})(?<info>.*)$/.exec(line)?.groups;
		if (fence) {
			if (run?.fence.startsWith(fence) && !run.info.trim()) fence = undefined;
			else output.push(line);
			continue;
		}
		if (run && (run.fence[0] === "~" || !run.info.includes("`"))) {
			flushParagraph();
			fence = run.fence;
			continue;
		}
		if (line.includes("|") && tableSeparator.test(lines[i + 1] ?? "")) {
			flushParagraph();
			output.push(tableCells(line).map(prose).join(" | "));
			i++;
			while (lines[i + 1]?.includes("|"))
				output.push(tableCells(lines[++i]).map(prose).join(" | "));
			continue;
		}
		const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			output.push(prose(heading[1].replace(/\s+#+\s*$/, "")));
			continue;
		}
		const setext = line.trim() && /^ {0,3}(?:=+|-+)$/.test(lines[i + 1] ?? "");
		const item = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/.exec(line);
		const quote = /^ {0,3}>[ \t]?/.exec(line);
		if (item || Boolean(quote) !== quoted) flushParagraph();
		quoted = Boolean(quote);
		const text = quote ? line.slice(quote[0].length) : line;
		if (
			!text.trim() ||
			/^ {0,3}(?:(?:- *){3,}|(?:\* *){3,}|(?:_ *){3,})$/.test(text)
		) {
			flushParagraph();
			output.push(prose(text));
		} else if (item) {
			const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
			const marker = item[2].replace(/^[-*+]$/, "-").replace(/\)$/, ".");
			paragraph.push(
				`${item[1]}${marker} ${task ? `[${task[1].toLowerCase()}] ${task[2]}` : item[3]}`,
			);
		} else paragraph.push(text);
		if (setext) {
			flushParagraph();
			i++;
		}
	}
	flushParagraph();
	return terminalText(output.join("\n"));
}
