import { decodeHTMLStrict } from "entities";
import { Marked, type Token } from "marked";

const markdown = new Marked({
	gfm: true,
	tokenizer: {
		escape(src: string) {
			// Older spec-review summaries escaped `>` before encoding it. Handle
			// that spelling only in Markdown prose, never inside code or a URL.
			if (src.startsWith("\\&gt;"))
				return { type: "escape" as const, raw: "\\&gt;", text: "&gt;" };
			return false;
		},
	},
});

function decodeProse(text: string): string {
	// HTML remaps some legacy C1 references to printable Windows-1252 glyphs.
	// Do not give encoded terminal controls a different meaning in this view.
	return decodeHTMLStrict(
		text.replace(/&#(?:(\d+)|[xX]([\da-fA-F]+));/g, (entity, dec, hex) => {
			const value = dec === undefined ? Number.parseInt(hex, 16) : Number(dec);
			return (value < 32 && value !== 9 && value !== 10) ||
				(value >= 127 && value <= 159)
				? ""
				: entity;
		}),
	);
}

/** Human terminal output: keep line feeds and tabs, not terminal control codes. */
export function terminalText(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Render completion Markdown without invoking an HTML renderer or opening links. */
export function completionPlainText(source: string): string {
	const inline = (tokens: Token[]): string =>
		tokens
			.map((token) => {
				switch (token.type) {
					case "link": {
						const label = inline(token.tokens ?? []);
						const href = decodeProse(token.href);
						return label === href ? label : `${label} (${href})`;
					}
					case "image":
						return decodeProse(token.text);
					case "br":
						return "\n";
					case "codespan":
						// Marked HTML-encodes every ampersand in a code span; decode that one layer.
						return decodeHTMLStrict(token.text);
					default:
						return "tokens" in token && token.tokens
							? inline(token.tokens)
							: decodeProse("text" in token ? token.text : token.raw);
				}
			})
			.join("");
	const blocks = (tokens: Token[], gap = "\n\n"): string =>
		tokens
			.flatMap((token) => {
				switch (token.type) {
					case "space":
					case "def":
						return [];
					case "code":
						return token.text;
					case "blockquote":
						return blocks(token.tokens ?? []);
					case "hr":
						return "---";
					case "list":
						return token.items
							.map((item: { tokens: Token[] }, index: number) => {
								const prefix = token.ordered
									? `${Number(token.start) + index}. `
									: "- ";
								return (
									prefix +
									blocks(item.tokens, "\n").replace(
										/\n/g,
										`\n${" ".repeat(prefix.length)}`,
									)
								);
							})
							.join("\n");
					case "table":
						return [token.header, ...token.rows]
							.map((row) =>
								row
									.map((cell: { tokens: Token[] }) => inline(cell.tokens))
									.join(" | "),
							)
							.join("\n");
					default:
						return inline([token]);
				}
			})
			.join(gap);
	return terminalText(
		blocks(markdown.lexer(terminalText(source.replace(/\r\n/g, "\n")))),
	);
}
