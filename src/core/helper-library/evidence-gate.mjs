// evidence-gate.mjs: a support stage that checks every row's cited quote against the project files with
// evidence-locate.mjs (same folder; `agent-workflow new helper evidence-gate <workflow>` adds both). It looks
// for the QUOTE, never trusts the model's line numbers, and replaces them with the real range. Deterministic,
// read-only, no model call.
//
//   { "id": "gate", "from": ["audit"], "support": { "uses": "./helpers/evidence-gate.mjs",
//     "options": { "from": "audit", "rows": "findings",
//                  "fields": { "id": "id", "file": "file", "quote": "quote",
//                              "startLine": "startLine", "endLine": "endLine", "term": "symbol" },
//                  "policy": "drop" } } }
//
// Options
//   from      stage id or source key (or an array of them). A stage id with foreach items collects every
//             completed item (through context.sourceStatuses). Required.
//   rows      path of the row array inside each source's control (default "items"; "$." prefix optional).
//   fields    paths inside one row (dotted): id (default "id"), file (default "evidence.file"),
//             quote (default "evidence.quote"); optional startLine, endLine (claimed range, corrected in
//             the kept row) and term (a name that the quote must contain as a whole word).
//   policy    "drop" (default): rows that fail are removed and listed, the stage passes (status "passed").
//             "block": any failing row makes the stage declare status "blocked", the run stops as declared.
//   minKept   with "drop", fewer verified rows than this (default 0) ends the stage "failed".
//   minQuoteChars (default 8), termMatch ("word" | "substring"), fixQuote (default false: replace the row's
//             quote with the text as it stands in the file when it was only located), fixLines (default true).
// Output (declare these keys in the stage's controlSchema)
//   { schema: "evidence-gate-v1", digest, status, gates: { passed }, policy,
//     counts: { total, exact, located, rejected, kept, lineCorrected, unchecked },
//     kept: [row...]            the verified rows (copies, lines fixed), in source order,
//     rejected: [{ index, id, file, reason }], checks: [{ index, id, verdict, file, startLine, endLine,
//     lineCorrected, reason? }], markdown, completionSummaryMarkdown }
// Under `agent-workflow rehearse` (AGENT_WORKFLOW_REHEARSAL=1) the files are not read: every row is kept.
import { locateEvidence } from "./evidence-locate.mjs";

const clip = (value, max) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
const escape = (text) => text.replace(/([\\`*_[\]<>|])/g, "\\$1");

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

function setPath(value, path, next) {
	const parts = String(path)
		.replace(/^\$\.?/, "")
		.split(".")
		.filter((part) => part !== "");
	let cursor = value;
	for (const part of parts.slice(0, -1)) {
		if (cursor[part] === null || typeof cursor[part] !== "object")
			cursor[part] = {};
		cursor = cursor[part];
	}
	if (parts.length > 0) cursor[parts[parts.length - 1]] = next;
}

/** Rows of the named sources: stage ids collect their foreach items, source keys are read directly. */
function collectRows(from, rowsPath, sources, context) {
	const rows = [];
	const missing = [];
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
		if (keys.length === 0) {
			if (statuses.some((row) => row.stageId === name || row.source === name)) {
				missing.push(name);
				continue;
			}
			throw new Error(
				`evidence-gate: "${name}" is not a source of this stage (declare it in from)`,
			);
		}
		for (const key of keys) {
			const list = pick(sources[key], rowsPath);
			if (!Array.isArray(list))
				throw new Error(
					`evidence-gate: source "${key}" has no array at ${rowsPath}`,
				);
			rows.push(...list);
		}
	}
	return { rows, missing };
}

function result(status, policy, counts, kept, rejected, checks, note, digest) {
	const lines = [
		"# Evidence check",
		"",
		`- Status: **${status}** (policy ${policy})`,
		`- Rows: ${counts.total}; kept ${counts.kept} (exact ${counts.exact}, located ${counts.located}${counts.unchecked > 0 ? `, unchecked ${counts.unchecked}` : ""}); rejected ${counts.rejected}`,
		`- Line numbers corrected: ${counts.lineCorrected}`,
		"",
	];
	if (note) lines.push(note, "");
	if (rejected.length > 0) {
		lines.push("## Rejected rows", "");
		for (const row of rejected)
			lines.push(
				`- \`${escape(row.id)}\` (\`${escape(row.file)}\`): ${escape(row.reason)}`,
			);
		lines.push("");
	}
	return {
		schema: "evidence-gate-v1",
		digest: clip(digest, 200),
		status,
		gates: { passed: status === "passed" },
		policy,
		counts,
		kept,
		rejected,
		checks,
		markdown: lines.join("\n"),
		completionSummaryMarkdown: clip(`Evidence check: ${digest}`, 900),
	};
}

export default async function helper({ sources, options, context }) {
	const opts = options ?? {};
	if (opts.from === undefined)
		throw new Error("evidence-gate: options.from names the source stage");
	const policy = opts.policy ?? "drop";
	if (policy !== "drop" && policy !== "block")
		throw new Error('evidence-gate: options.policy must be "drop" or "block"');
	const fields = {
		id: "id",
		file: "evidence.file",
		quote: "evidence.quote",
		...(opts.fields ?? {}),
	};
	const { rows, missing } = collectRows(
		opts.from,
		opts.rows ?? "items",
		sources,
		context,
	);
	const rehearsal = process.env.AGENT_WORKFLOW_REHEARSAL === "1";
	const cache = new Map();
	const kept = [];
	const rejected = [];
	const checks = [];
	const counts = {
		total: rows.length,
		exact: 0,
		located: 0,
		rejected: 0,
		kept: 0,
		lineCorrected: 0,
		unchecked: 0,
	};
	for (const [index, row] of rows.entries()) {
		const isObject = row !== null && typeof row === "object";
		const text = (path) => {
			const value = isObject && path ? pick(row, path) : undefined;
			return typeof value === "string" ? value : "";
		};
		const id = clip(text(fields.id) || `#${index}`, 64);
		const file = text(fields.file);
		let check;
		if (rehearsal) {
			check = { verdict: "unchecked", startLine: 0, endLine: 0 };
		} else if (!isObject) {
			check = { verdict: "rejected", reason: "the row is not an object" };
		} else if (file === "" || text(fields.quote) === "") {
			check = {
				verdict: "rejected",
				reason: "the row lacks its evidence file or quote",
			};
		} else {
			check = await locateEvidence({
				cwd: context.cwd,
				file,
				quote: text(fields.quote),
				term: fields.term ? text(fields.term) : undefined,
				claimedStart: fields.startLine
					? pick(row, fields.startLine)
					: undefined,
				claimedEnd: fields.endLine ? pick(row, fields.endLine) : undefined,
				minQuoteChars: opts.minQuoteChars,
				termMatch: opts.termMatch,
				cache,
			});
		}
		checks.push({
			index,
			id,
			verdict: check.verdict,
			file: clip(file, 240),
			startLine: check.startLine ?? 0,
			endLine: check.endLine ?? 0,
			lineCorrected: check.lineCorrected === true,
			...(check.reason === undefined
				? {}
				: { reason: clip(check.reason, 300) }),
		});
		if (check.verdict === "rejected") {
			counts.rejected++;
			rejected.push({
				index,
				id,
				file: clip(file || "(none)", 240),
				reason: clip(check.reason, 300),
			});
			continue;
		}
		counts.kept++;
		if (check.verdict === "unchecked") counts.unchecked++;
		else counts[check.verdict]++;
		if (check.lineCorrected) counts.lineCorrected++;
		const copy = structuredClone(row);
		if (check.verdict !== "unchecked") {
			if (opts.fixLines !== false) {
				if (fields.startLine) setPath(copy, fields.startLine, check.startLine);
				if (fields.endLine) setPath(copy, fields.endLine, check.endLine);
			}
			if (opts.fixQuote === true && check.verdict === "located")
				setPath(copy, fields.quote, check.quote);
		}
		kept.push(copy);
	}
	const minKept = Number.isInteger(opts.minKept) ? opts.minKept : 0;
	const base = `${counts.kept} of ${counts.total} rows verified${counts.rejected > 0 ? `, ${counts.rejected} rejected` : ""}${counts.lineCorrected > 0 ? `, ${counts.lineCorrected} with corrected lines` : ""}`;
	const note = rehearsal
		? "Rehearsal: the files were not read, every row was kept."
		: missing.length > 0
			? `Source ${missing.join(", ")} did not complete; its rows are not in this check.`
			: "";
	let status = "passed";
	let digest = base;
	if (missing.length > 0 && rows.length === 0) {
		status = "failed";
		digest = `no rows to check: ${missing.join(", ")} did not complete`;
	} else if (policy === "block" && counts.rejected > 0) {
		status = "blocked";
		digest = `${base}; policy block stops the run (${rejected[0].id}: ${rejected[0].reason})`;
	} else if (policy === "drop" && counts.kept < minKept) {
		status = "failed";
		digest = `${base}; fewer than the required ${minKept}`;
	}
	return result(status, policy, counts, kept, rejected, checks, note, digest);
}
