// New in agent-workflow (WP34): terminal helpers shared by the `/aw` board (board.ts) and the
// profile picker (profile-tui.ts). Ported from pi-workflow 0.16.4 (b83cc4f) src/workflow-view.ts
// (`matchesKey`, the Kitty/modifyOtherKeys parsers, `visibleWidth`, `truncateToWidth`, `boxed`,
// `joinColumns`, the theme helpers, `escapeLaunchCommandForDisplay`, `wrapLaunchCommand`). MIT, same
// author. pi-workflow kept them self-contained instead of importing `@earendil-works/pi-tui`; so do
// we, because this package builds and loads without the optional Pi peer. The only Pi 1.1 APIs the
// components use are the ones `ctx.ui.custom` hands them: `tui.requestRender()` and the theme's
// `fg`/`bg`/`bold`.

/** The part of Pi's theme the components use (`theme.fg(color, text)`, `bg`, `bold`). */
export type Theme = {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

/** The part of Pi's TUI the components use. */
export type Tui = { requestRender(force?: boolean): void };

/** Pi 1.1 component contract (`render`, `handleInput`, `invalidate`, `dispose`). */
export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
	dispose?(): void;
}

// --- keys ---------------------------------------------------------------------------------------

const MOD_CTRL = 4;
const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 } as const;
const KITTY_FUNCTIONAL_EQUIVALENTS = new Map<number, number>([
	[57414, 13],
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
]);

/** Legacy, Kitty (CSI u) and modifyOtherKeys forms of the keys the components use. */
export function matchesKey(data: string, key: string): boolean {
	if (key === "escape")
		return data === "\u001b" || matchesSpecialKey(data, 27, 0);
	if (key === "up" || key === "down" || key === "left" || key === "right")
		return (
			matchesArrowKey(data, key) ||
			matchesSpecialKey(data, ARROW_CODEPOINTS[key], 0)
		);
	if (key === "enter" || key === "return")
		return (
			data === "\r" ||
			data === "\n" ||
			data === "\u001bOM" ||
			matchesSpecialKey(data, 13, 0)
		);
	if (key === "backspace")
		return (
			data === "\u007f" || data === "\b" || matchesSpecialKey(data, 127, 0)
		);
	if (key === "ctrl+c")
		return data === "\u0003" || matchesSpecialKey(data, 99, MOD_CTRL);
	if (key === "ctrl+d")
		return data === "\u0004" || matchesSpecialKey(data, 100, MOD_CTRL);
	return data === key || matchesPrintableKey(data, key);
}

function matchesArrowKey(
	data: string,
	key: keyof typeof ARROW_CODEPOINTS,
): boolean {
	const legacy = {
		up: ["\u001b[A", "\u001bOA"],
		down: ["\u001b[B", "\u001bOB"],
		left: ["\u001b[D", "\u001bOD"],
		right: ["\u001b[C", "\u001bOC"],
	}[key];
	if (legacy.includes(data)) return true;
	const arrowMatch = /^\u001b\[1;(\d+)(?::(\d+))?([ABCD])$/.exec(data);
	if (!arrowMatch) return false;
	if (Number(arrowMatch[1]) - 1 !== 0) return false;
	const codepoint = {
		A: ARROW_CODEPOINTS.up,
		B: ARROW_CODEPOINTS.down,
		C: ARROW_CODEPOINTS.right,
		D: ARROW_CODEPOINTS.left,
	}[arrowMatch[3] as "A" | "B" | "C" | "D"];
	return codepoint === ARROW_CODEPOINTS[key];
}

function matchesSpecialKey(
	data: string,
	expectedCodepoint: number,
	expectedModifier: number,
): boolean {
	const parsed = parseKittySequence(data) ?? parseModifyOtherKeysSequence(data);
	if (!parsed) return false;
	const codepoint =
		KITTY_FUNCTIONAL_EQUIVALENTS.get(parsed.codepoint) ?? parsed.codepoint;
	return (
		codepoint === expectedCodepoint && parsed.modifier === expectedModifier
	);
}

function matchesPrintableKey(data: string, key: string): boolean {
	if (key.length !== 1) return false;
	const parsed = parseKittySequence(data);
	if (!parsed || parsed.modifier !== 0) return false;
	return parsed.codepoint === key.charCodeAt(0);
}

function parseKittySequence(
	data: string,
): { codepoint: number; modifier: number } | undefined {
	const csiUMatch =
		/^\u001b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/.exec(data);
	if (csiUMatch)
		return {
			codepoint: Number(csiUMatch[1]),
			modifier: Number(csiUMatch[4] ?? "1") - 1,
		};
	const arrowMatch = /^\u001b\[1;(\d+)(?::(\d+))?([ABCD])$/.exec(data);
	if (arrowMatch) {
		const codepoint = {
			A: ARROW_CODEPOINTS.up,
			B: ARROW_CODEPOINTS.down,
			C: ARROW_CODEPOINTS.right,
			D: ARROW_CODEPOINTS.left,
		}[arrowMatch[3] as "A" | "B" | "C" | "D"];
		return { codepoint, modifier: Number(arrowMatch[1]) - 1 };
	}
	return undefined;
}

function parseModifyOtherKeysSequence(
	data: string,
): { codepoint: number; modifier: number } | undefined {
	const match = /^\u001b\[27;(\d+);(\d+)~$/.exec(data);
	if (!match) return undefined;
	return { modifier: Number(match[1]) - 1, codepoint: Number(match[2]) };
}

/** A printable key, case-insensitive (`r` and `R`). */
export function isKey(data: string, key: string): boolean {
	return (
		matchesKey(data, key.toLowerCase()) || matchesKey(data, key.toUpperCase())
	);
}

export function isCloseInput(data: string): boolean {
	return (
		data === "q" ||
		data === "Q" ||
		matchesKey(data, "ctrl+c") ||
		matchesKey(data, "ctrl+d")
	);
}

export function isEnter(data: string): boolean {
	return matchesKey(data, "enter");
}

// --- width --------------------------------------------------------------------------------------

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

export function visibleWidth(text: string): number {
	const clean = stripAnsi(text);
	let width = 0;
	for (const { segment } of GRAPHEME_SEGMENTER.segment(clean))
		width += graphemeWidth(segment);
	return width;
}

export function truncateToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width || 0));
	if (safeWidth === 0) return "";
	if (visibleWidth(text) <= safeWidth) return text;
	const hasAnsi =
		text.includes("\u001b[") ||
		text.includes("\u001b]") ||
		text.includes("\u001b_");
	const ellipsis = "…";
	const limit = Math.max(0, safeWidth - visibleWidth(ellipsis));
	let visible = 0;
	let output = "";
	for (let index = 0; index < text.length; ) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			output += ansi.value;
			index = ansi.nextIndex;
			continue;
		}
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		const charWidth = graphemeWidth(char);
		if (visible + charWidth > limit) break;
		output += char;
		visible += charWidth;
		index += char.length;
	}
	return `${output}${ellipsis}${hasAnsi ? "\u001b[0m" : ""}`;
}

export function stripAnsi(text: string): string {
	let output = "";
	for (let index = 0; index < text.length; ) {
		const ansi = readAnsi(text, index);
		if (ansi) {
			index = ansi.nextIndex;
			continue;
		}
		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const char = String.fromCodePoint(codePoint);
		output += char;
		index += char.length;
	}
	return output;
}

function readAnsi(
	text: string,
	index: number,
): { value: string; nextIndex: number } | undefined {
	if (text.charCodeAt(index) !== 0x1b) return undefined;
	const next = text[index + 1];
	if (next === "[") {
		let nextIndex = index + 2;
		while (nextIndex < text.length) {
			const code = text.charCodeAt(nextIndex);
			nextIndex += 1;
			if (code >= 0x40 && code <= 0x7e)
				return { value: text.slice(index, nextIndex), nextIndex };
		}
		return { value: text.slice(index), nextIndex: text.length };
	}
	if (next === "]" || next === "_") {
		let nextIndex = index + 2;
		while (nextIndex < text.length) {
			if (text[nextIndex] === "\x07")
				return {
					value: text.slice(index, nextIndex + 1),
					nextIndex: nextIndex + 1,
				};
			if (text[nextIndex] === "\x1b" && text[nextIndex + 1] === "\\")
				return {
					value: text.slice(index, nextIndex + 2),
					nextIndex: nextIndex + 2,
				};
			nextIndex += 1;
		}
		return { value: text.slice(index), nextIndex: text.length };
	}
	return undefined;
}

function graphemeWidth(segment: string): number {
	if (segment.length === 0) return 0;
	if (segment === "\t") return 3;
	if (/^[\p{Mark}\p{Control}\p{Surrogate}\u200d\ufe0e\ufe0f]+$/u.test(segment))
		return 0;
	if (isEmojiLike(segment)) return 2;
	const base = segment.replace(
		/^[\p{Mark}\p{Control}\p{Format}\p{Surrogate}]+/u,
		"",
	);
	const codePoint = base.codePointAt(0);
	if (codePoint === undefined) return 0;
	return isWideCodePoint(codePoint) ? 2 : 1;
}

function isEmojiLike(segment: string): boolean {
	if (/[\ufe0f\u200d]/u.test(segment)) return true;
	const codePoint = segment.codePointAt(0);
	if (codePoint === undefined) return false;
	return (
		(codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
		codePoint === 0x2705 ||
		(codePoint >= 0x2b50 && codePoint <= 0x2b55)
	);
}

function isWideCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x1100 && codePoint <= 0x115f) ||
		codePoint === 0x2329 ||
		codePoint === 0x232a ||
		(codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6)
	);
}

export function padAnsi(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

export function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

/** Control characters shown as U+FFFD (names and labels; never raw terminal controls). */
export function safeLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}

// --- layout -------------------------------------------------------------------------------------

export function boxed(
	theme: Theme,
	titleText: string,
	width: number,
	content: string[],
	color = "borderMuted",
): string[] {
	const safeWidth = Math.max(8, width);
	const bodyWidth = Math.max(1, safeWidth - 4);
	const topLabel = `╭─ ${titleText} `;
	const top = `${topLabel}${"─".repeat(Math.max(0, safeWidth - visibleWidth(topLabel) - 1))}╮`;
	const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`;
	const body = content.length > 0 ? content : [""];
	return [
		fg(theme, color, fit(top, safeWidth)),
		...body.map(
			(line) =>
				`${fg(theme, color, "│")} ${padAnsi(fit(line, bodyWidth), bodyWidth)} ${fg(theme, color, "│")}`,
		),
		fg(theme, color, bottom),
	];
}

export function joinColumns(
	left: string,
	right: string,
	width: number,
	leftWidth: number,
): string {
	const safeLeftWidth = Math.max(1, Math.min(leftWidth, width - 1));
	const safeRightWidth = Math.max(1, width - safeLeftWidth - 1);
	return `${padAnsi(fit(left, safeLeftWidth), safeLeftWidth)} ${fit(right, safeRightWidth)}`;
}

export function joinFixedColumns(columns: string[], widths: number[]): string {
	return columns
		.map((column, index) =>
			padAnsi(fit(column, widths[index] ?? 1), widths[index] ?? 1),
		)
		.join(" ");
}

export function visibleWindow<T>(
	items: T[],
	selectedIndex: number,
	maxRows: number,
): {
	rows: Array<{ item: T; index: number }>;
	hiddenBefore: number;
	hiddenAfter: number;
} {
	const total = items.length;
	if (total === 0) return { rows: [], hiddenBefore: 0, hiddenAfter: 0 };
	const safeMaxRows = Math.max(1, maxRows);
	const selected = clampIndex(selectedIndex, total);
	const start =
		total <= safeMaxRows
			? 0
			: Math.max(
					0,
					Math.min(selected - Math.floor(safeMaxRows / 2), total - safeMaxRows),
				);
	const end = Math.min(total, start + safeMaxRows);
	return {
		rows: items
			.slice(start, end)
			.map((item, offset) => ({ item, index: start + offset })),
		hiddenBefore: start,
		hiddenAfter: Math.max(0, total - end),
	};
}

export function wrapIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return (index + length) % length;
}

export function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

// --- theme --------------------------------------------------------------------------------------

export function fg(theme: Theme, color: string, text: string): string {
	return theme.fg ? theme.fg(color, text) : text;
}
export function strong(theme: Theme, text: string): string {
	return theme.bold ? theme.bold(text) : text;
}
export function accent(theme: Theme, text: string): string {
	return fg(theme, "accent", text);
}
export function muted(theme: Theme, text: string): string {
	return fg(theme, "muted", text);
}
export function success(theme: Theme, text: string): string {
	return fg(theme, "success", text);
}
export function warning(theme: Theme, text: string): string {
	return fg(theme, "warning", text);
}
export function errorText(theme: Theme, text: string): string {
	return fg(theme, "error", text);
}

export function bgBand(theme: Theme, color: string, text: string): string {
	if (!theme.bg) return text;
	const marker = "__AW_BG_MARKER__";
	const wrapped = theme.bg(color, marker);
	const markerIndex = wrapped.indexOf(marker);
	if (markerIndex < 0) return theme.bg(color, text);
	const prefix = wrapped.slice(0, markerIndex);
	const suffix = wrapped.slice(markerIndex + marker.length);
	return `${prefix}${text.replace(/\u001b\[0m/g, `\u001b[0m${prefix}`)}${suffix}`;
}

export function selectedLine(
	theme: Theme,
	line: string,
	width: number,
	selected: boolean,
): string {
	if (!selected) return line;
	const padded = padAnsi(line, width);
	return theme.bg ? bgBand(theme, "selectedBg", padded) : accent(theme, padded);
}

export function kvRow(
	theme: Theme,
	key: string,
	value: string,
	valueColor = "text",
): string {
	return `${muted(theme, `${key}:`)} ${fg(theme, valueColor, value)}`;
}

export function metaLine(theme: Theme, pairs: Array<[string, string]>): string {
	return pairs
		.map(([key, value]) => kvRow(theme, key, value))
		.join(` ${muted(theme, "·")} `);
}

/** Footer: the key of each `key text` part in the accent colour. */
export function navHint(theme: Theme, text: string): string {
	return text
		.split(" · ")
		.map((part) => {
			const firstSpace = part.indexOf(" ");
			if (firstSpace < 0) return accent(theme, part);
			return `${accent(theme, part.slice(0, firstSpace))}${muted(theme, part.slice(firstSpace))}`;
		})
		.join(` ${muted(theme, "·")} `);
}

export function chip(
	theme: Theme,
	label: string,
	value: string,
	color: string,
): string {
	return fg(theme, color, strong(theme, `● ${label} ${value} `));
}

// --- launch command -----------------------------------------------------------------------------

/** Control, bidi and line characters escaped (the exact text is still what `c` copies). */
export function escapeForDisplay(text: string): string {
	let escaped = "";
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "\\") escaped += "\\\\";
		else if (character === "\n") escaped += "\\n";
		else if (character === "\r") escaped += "\\r";
		else if (character === "\t") escaped += "\\t";
		else if (
			codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x061c ||
			(codePoint >= 0x200e && codePoint <= 0x200f) ||
			(codePoint >= 0x2028 && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		)
			escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
		else escaped += character;
	}
	return escaped;
}

export function wrapByWidth(text: string, width: number): string[] {
	if (!text) return [""];
	const lines: string[] = [];
	let line = "";
	let lineWidth = 0;
	for (const character of text) {
		const characterWidth = visibleWidth(character);
		if (line && lineWidth + characterWidth > width) {
			lines.push(line);
			line = "";
			lineWidth = 0;
		}
		line += character;
		lineWidth += characterWidth;
	}
	lines.push(line);
	return lines;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
