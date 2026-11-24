// render-report.mjs: safe Markdown for tables and lists built from rows. Deterministic, no file or network
// access, no model call. Row text is untrusted: `|`, backslashes, Markdown and HTML characters are escaped,
// newlines never break a table row, and an object or array is NEVER turned into "[object Object]": it renders
// as compact JSON (keys sorted, in a code span), or as the field you choose with `select`.
//
//   { "id": "report", "from": ["diff"], "support": { "uses": "./helpers/render-report.mjs",
//     "options": { "title": "Route audit", "sections": [
//       { "title": "Only in code", "from": "diff", "rows": "onlyLeft", "type": "table",
//         "columns": ["key", { "field": "row.handler", "title": "Handler", "code": true }] },
//       { "title": "Conflicts", "from": "diff", "rows": "conflicts", "type": "list",
//         "template": "{key}: {field} is {left} in code, {right} in the docs" } ] } } }
//
// Options
//   title      the report's H1 (optional); intro: one paragraph of plain text (optional).
//   sections   [{ title, from, rows, type, columns | template | field, sortBy, limit, emptyText }]
//     from/rows   stage id or source key (or an array) and the row-array path (default "items"); a stage id
//                 with foreach items collects every completed item.
//     type        "table" (default) or "list".
//     columns     table columns: a field path, or { field, title, select, code, max }. `select` picks a field
//                 out of an object value (or out of every element of an array value); `code` renders a code
//                 span; `max` caps the cell (default 300 characters, then "…"). With no columns a table shows
//                 every top-level key of the first row.
//     template    list item text with {field.path} placeholders ("{name}: {detail}"); or `field`: one path.
//                 With neither, an item is the row as compact JSON. `ordered: true` numbers the items.
//     sortBy      a field path, ascending (numbers numerically, text by code point); stable.
//     limit       show at most this many rows and say how many more there were (default: all).
//     emptyText   the line shown when there are no rows (default "None.").
// Library (pure; pass rows directly)
//   renderTable(rows, columns, options), renderList(rows, options), renderCell(value, options),
//   escapeText(text), codeSpan(text), jsonText(value)
// Output (declare these keys in the stage's controlSchema)
//   { schema: "render-report-v1", digest, status: "passed", markdown, completionSummaryMarkdown }

const clip = (value, max) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
const MAX_CELL = 300;
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function pick(value, path) {
	let cursor = value;
	for (const part of String(path)
		.replace(/^\$\.?/, "")
		.split(".")) {
		if (part === "") continue;
		if (cursor === null || typeof cursor !== "object") return undefined;
		cursor = cursor[part];
	}
	return cursor;
}

/** Text with Markdown, HTML and table characters escaped and every whitespace run (newlines too) one space. */
export function escapeText(text) {
	return String(text)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/([\\`*_[\]<>|&~])/g, "\\$1");
}

/** An inline code span that survives backticks and pipes inside the text. */
export function codeSpan(text) {
	const flat = String(text).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
	if (flat === "") return "";
	const longest = Math.max(
		0,
		...(flat.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(longest + 1);
	return `${fence}${flat.startsWith("`") || flat.endsWith("`") ? ` ${flat} ` : flat}${fence}`;
}

/** Compact JSON with sorted keys; never throws, never "[object Object]". */
export function jsonText(value) {
	try {
		const text = JSON.stringify(value, (_, inner) =>
			inner !== null && typeof inner === "object" && !Array.isArray(inner)
				? Object.fromEntries(
						Object.entries(inner).sort(([a], [b]) => order(a, b)),
					)
				: typeof inner === "bigint"
					? String(inner)
					: inner,
		);
		return text === undefined ? "" : text;
	} catch {
		return "(unprintable value)";
	}
}

const isPlain = (value) =>
	value === null ||
	["string", "number", "boolean", "bigint"].includes(typeof value);

function shorten(text, max) {
	const chars = [...text];
	return chars.length > max
		? `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
		: text;
}

function plainText(value) {
	return value === null || value === undefined ? "" : String(value);
}

/**
 * One value as safe inline Markdown. options: select (field path inside an object / each array element),
 * code (code span), max (characters, default 300), empty (text for null / undefined, default "").
 */
export function renderCell(value, options) {
	const opts = options ?? {};
	const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : MAX_CELL;
	let shown = value;
	if (opts.select !== undefined) {
		shown = Array.isArray(shown)
			? shown
					.map((entry) => (isPlain(entry) ? entry : pick(entry, opts.select)))
					.filter((entry) => entry !== undefined)
			: isPlain(shown)
				? shown
				: pick(shown, opts.select);
	}
	if (shown === null || shown === undefined) return opts.empty ?? "";
	// Plain values (and arrays of them) are text; anything nested is JSON, as code.
	const asText = isPlain(shown)
		? plainText(shown)
		: Array.isArray(shown) && shown.every(isPlain)
			? shown.map(plainText).join(", ")
			: undefined;
	if (asText === undefined) return codeSpan(shorten(jsonText(shown), max));
	const clipped = shorten(asText.replace(/\s+/g, " ").trim(), max);
	return opts.code === true ? codeSpan(clipped) : escapeText(clipped);
}

function column(entry) {
	const spec = typeof entry === "string" ? { field: entry } : (entry ?? {});
	if (typeof spec.field !== "string" || spec.field === "")
		throw new Error("render-report: every column needs a field path");
	return { ...spec, title: spec.title ?? spec.field };
}

/** A Markdown table. `columns` default to the first row's top-level keys. options.emptyText for no rows. */
export function renderTable(rows, columns, options) {
	const opts = options ?? {};
	if (rows.length === 0) return opts.emptyText ?? "None.";
	const specs = (
		Array.isArray(columns) && columns.length > 0
			? columns
			: Object.keys(
					rows[0] !== null && typeof rows[0] === "object"
						? rows[0]
						: { value: 1 },
				).sort(order)
	).map(column);
	const head = (spec) => escapeText(spec.title) || " ";
	const lines = [
		`| ${specs.map(head).join(" | ")} |`,
		`| ${specs.map(() => "---").join(" | ")} |`,
	];
	for (const row of rows)
		lines.push(
			`| ${specs
				.map((spec) => {
					const value =
						row !== null && typeof row === "object"
							? pick(row, spec.field)
							: spec.field === "value"
								? row
								: undefined;
					return renderCell(value, spec) || " ";
				})
				.join(" | ")} |`,
		);
	return lines.join("\n");
}

function fill(template, row, options) {
	return template.replace(/\{([^{}]+)\}/g, (_, path) =>
		renderCell(pick(row, path.trim()), options),
	);
}

/** A Markdown list. options: template ("{a}: {b}"), field, ordered, emptyText, max (per placeholder). */
export function renderList(rows, options) {
	const opts = options ?? {};
	if (rows.length === 0) return opts.emptyText ?? "None.";
	return rows
		.map((row, index) => {
			const marker = opts.ordered === true ? `${index + 1}.` : "-";
			const text =
				typeof opts.template === "string"
					? fill(opts.template, row, opts)
					: typeof opts.field === "string"
						? renderCell(pick(row, opts.field), opts)
						: renderCell(row, opts);
			return `${marker} ${text}`;
		})
		.join("\n");
}

function collectRows(section, sources, context) {
	const from = section.from;
	if (from === undefined)
		throw new Error("render-report: every section needs a from");
	const path = section.rows ?? "items";
	const rows = [];
	const statuses = Array.isArray(context?.sourceStatuses)
		? context.sourceStatuses
		: [];
	for (const name of Array.isArray(from) ? from : [from]) {
		const items = statuses
			.filter(
				(row) =>
					row.stageId === name &&
					row.itemIdentity !== undefined &&
					sources[row.source] !== undefined,
			)
			.map((row) => row.source);
		const keys = items.length > 0 ? items : name in sources ? [name] : [];
		if (keys.length === 0)
			throw new Error(
				`render-report: "${name}" is not a completed source of this stage`,
			);
		for (const key of keys) {
			const list = pick(sources[key], path);
			if (!Array.isArray(list))
				throw new Error(
					`render-report: source "${key}" has no array at ${path}`,
				);
			rows.push(...list);
		}
	}
	return rows;
}

function sorted(rows, field) {
	const key = (row) => pick(row, field);
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const x = key(a.row);
			const y = key(b.row);
			if (x === undefined || x === null)
				return y === undefined || y === null ? a.index - b.index : 1;
			if (y === undefined || y === null) return -1;
			if (typeof x === "number" && typeof y === "number")
				return x - y || a.index - b.index;
			return order(String(x), String(y)) || a.index - b.index;
		})
		.map((entry) => entry.row);
}

export default async function helper({ sources, options, context }) {
	const opts = options ?? {};
	const sections = Array.isArray(opts.sections) ? opts.sections : [];
	if (sections.length === 0)
		throw new Error(
			"render-report: options.sections lists at least one section",
		);
	const parts = [];
	if (typeof opts.title === "string" && opts.title !== "")
		parts.push(`# ${escapeText(opts.title)}`);
	if (typeof opts.intro === "string" && opts.intro !== "")
		parts.push(escapeText(opts.intro));
	const sizes = [];
	for (const section of sections) {
		let rows = collectRows(section, sources, context);
		if (typeof section.sortBy === "string") rows = sorted(rows, section.sortBy);
		const total = rows.length;
		const limit =
			Number.isInteger(section.limit) && section.limit >= 0
				? section.limit
				: total;
		const shown = rows.slice(0, limit);
		const body =
			section.type === "list"
				? renderList(shown, section)
				: renderTable(shown, section.columns, section);
		const more =
			total > shown.length ? `\n\n_… and ${total - shown.length} more._` : "";
		parts.push(
			`${typeof section.title === "string" && section.title !== "" ? `## ${escapeText(section.title)} (${total})\n\n` : ""}${body}${more}`,
		);
		sizes.push(`${clip(section.title ?? section.from, 40)}: ${total}`);
	}
	return {
		schema: "render-report-v1",
		digest: clip(
			`rendered ${sections.length} sections (${sizes.join("; ")})`,
			200,
		),
		status: "passed",
		markdown: `${parts.join("\n\n")}\n`,
		completionSummaryMarkdown: clip(
			`${typeof opts.title === "string" && opts.title !== "" ? `${opts.title}: ` : ""}${sizes.join("; ")}`,
			900,
		),
	};
}
