// Canonical report Markdown helpers. Run tools/release/sync-report-markdown.mjs after edits.

export function cleanText(value) {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		// Only before punctuation that ends a word: ".agent-workflow/…", " .env" keep their space (2026-11-04).
		.replace(/\s+([,.;:!?])(?=\s|$)/g, "$1")
		.trim();
}

// Serialize data, never structure. Quote line breaks and tabs are made visible as JSON escapes.

function serializeText(value, { quote = false, table = false, completion = false } = {}) {
	const text = quote ? JSON.stringify(value) : cleanText(value);
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(completion ? /([\\`*_[\]{}#+!])/g : /([\\`*_[\]{}#+!~])/g, "\\$1")
		.replace(/\|/g, table ? "&#124;" : "\\|")
		.replace(completion ? /^([-~=])(?=\s|[-~=]|$)/u : /^([-=])(?=\s|[-=]|$)/u, "\\$1")
		.replace(/^(\d{1,9})([.)])(?=\s|$)/u, "$1\\$2")
		// Hide GFM's autolink delimiters in the Markdown source, not the rendered text.
		.replace(/:(?=\/\/)/g, "&#58;")
		.replace(/(www)\./gi, "$1&#46;")
		.replace(/@/g, "&#64;");
}

export function escapeMarkdownText(value, options) {
	return serializeText(value, options);
}

// Keep the established Markdown sent to structured and Markdown hosts.
export function escapeCompletionText(value) {
	return serializeText(value, { completion: true });
}

export function escapeTableCell(value) {
	return serializeText(value, { table: true });
}

export function inlineCode(value, { table = false } = {}) {
	let text = String(value ?? "").replace(/\r\n?|\n/g, " ");
	if (!text) return "";
	if (table) {
		// GFM cannot carry an odd run of literal backslashes before a pipe in a
		// code cell: one more slash would make it a separator. Preserve it as prose.
		if (/(?:^|[^\\])(?:\\\\)*\\\|/.test(text)) return escapeTableCell(text);
		text = text.replace(/\|/g, "\\|");
	}
	const fence = "`".repeat(1 + Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length)));
	const padded = /^`|`$|^ .* $/.test(text) && /[^ ]/.test(text) ? ` ${text} ` : text;
	return `${fence}${padded}${fence}`;
}

export function validHttpUrl(text) {
	if (!/^https?:\/\/[^/?#]/i.test(text) || /[\x00-\x20\x7f-\x9f\\]/u.test(text)) return null;
	try {
		const parsed = new URL(text);
		if (!parsed.hostname || parsed.username || parsed.password) return null;
		// Use URL only for validation: its serialization changes request targets.
		return text;
	} catch {
		return null;
	}
}

export function sentences(text) {
	const ko = /[가-힣]/u.test(text);
	return [...new Intl.Segmenter(ko ? "ko" : "en", { granularity: "sentence" }).segment(text)]
		.map(({ segment }) => segment.trim()).filter(Boolean);
}

export function fold(title, body, indent = "") {
	return ["<details>", `<summary>${title}</summary>`, "", ...body, "", "</details>"].map(
		(line) => line ? `${indent}${line}` : "",
	);
}

export function reportLocale(...prose) {
	// Prefer the first informative field (usually the model's narrative, not machine keys).
	const text = prose.find((value) => typeof value === "string" && /\p{L}/u.test(value)) ?? "";
	const hangul = text.match(/[가-힣]/gu)?.length ?? 0;
	const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
	return (en, ko) => hangul > 0 && hangul * 3 >= latin ? ko : en;
}

// The renderer chrome has two translations. Match a request for the output
// language, not a bare mention (e.g. "review the Korean API").
export function reviewReportLocale(runtimeTask, ...readerProse) {
	const task = typeof runtimeTask === "string" ? runtimeTask : "";
	// Consume negated directives as a whole so their nested "report in ..."
	// cannot be mistaken for an affirmative request by the noun-form fallback.
	const directives = task.matchAll(/\b(?:(not|never|don['’]t|doesn['’]t|didn['’]t|can['’]t|cannot|shouldn['’]t|mustn['’]t|won['’]t)\s+)?(?:(?:write|render|produce|provide|deliver|present|output|respond|answer)\s+(?:(?:(?:the|your|a|final)\s+)*(?:report|review|summary|findings|results)\s+)?in\s+|(?:report|review|summary)\s+(?:language\s*[:=]\s*|in\s+))(Korean|English)\b/gi);
	const explicit = [...directives].find((match) => !match[1]);
	if (explicit) return (en, ko) => /^Korean$/i.test(explicit[2]) ? ko : en;
	const koreanRequest = task.match(/(?:보고서|검토\s*결과|요약)(?:는|를|을|은)?\s*(?:[:：]\s*)?(한국어|영어)(?:로|으로)\s*(?:작성|출력|제공|보고|정리)/u);
	if (koreanRequest) return (en, ko) => koreanRequest[1] === "한국어" ? ko : en;
	return reportLocale(...readerProse, task);
}

export function shortNarrative(value, max = 180) {
	const parts = sentences(cleanText(value));
	if (!parts.length || parts.length > 2 || parts.some((part) => part.length > max)) return [];
	return parts.flatMap((part) => [escapeMarkdownText(part), ""]);
}

export function reportSection(level, title, body) {
	return body.length ? [`${"#".repeat(level)} ${title}`, "", ...body, ""] : [];
}

export function reportActions(title, rows) {
	return reportSection(2, title, rows.filter(({ value }) => cleanText(value)).map(({ label, value }) =>
		`1. **${escapeMarkdownText(label)}** — ${escapeMarkdownText(value)}`,
	));
}

export function reportStatus(value, t) {
	const statuses = {
		REVIEW_COMPLETE: ["Review complete", "검토 완료"], NEEDS_WORK: ["Needs work", "수정 필요"],
		PARTIAL_REVIEW: ["Partial review", "부분 검토"], READY: ["Ready", "배포 가능"],
		BLOCKED: ["Blocked", "차단됨"], UNKNOWN: ["Unknown", "알 수 없음"],
		CONFORMS: ["Conforms", "요구사항 충족"], GAPS_FOUND: ["Gaps found", "요구사항 미충족"],
		INCONCLUSIVE: ["Inconclusive", "판단 보류"], KEEP: ["Kept", "유지"],
		WEAKEN: ["Weakened", "완화"], DROP: ["Dropped", "제외"],
		NEEDS_HUMAN: ["Needs human review", "사람 검토 필요"], CRITICAL: ["Critical", "치명적"],
		HIGH: ["High", "높음"], MEDIUM: ["Medium", "보통"], LOW: ["Low", "낮음"],
		NONE: ["None", "표시 없음"], RISK_NONE: ["None", "위험 없음"], INFO: ["Informational", "정보"], COVERED: ["Covered", "충족"], UNCLEAR: ["Unclear", "불명확"],
		GAP: ["Gap", "공백"], NEEDSHUMAN: ["Needs human review", "사람 검토 필요"],
		UNVERIFIED_OR_INCOMPLETE: ["Unverified or incomplete", "미검증 또는 불완전"],
		MISSING: ["Missing", "누락"], CONSISTENT: ["Consistent", "일관됨"],
		INCONSISTENT: ["Inconsistent", "불일치"], NOT_APPLICABLE: ["Not applicable", "해당 없음"],
		PASS: ["Pass", "통과"], WARN: ["Warning", "주의"], FAIL: ["Fail", "실패"],
		SKIPPED: ["Skipped", "건너뜀"], PARTIAL: ["Partial", "일부"], COMPLETE: ["Complete", "완료"],
		COMPLETED: ["Completed", "완료"], FAILED: ["Failed", "실패"], UNAVAILABLE: ["Unavailable", "자료 없음"],
	};
	const text = cleanText(value);
	const key = text.toUpperCase().replace(/[ -]/g, "_");
	return Object.hasOwn(statuses, key) ? t(...statuses[key]) : text;
}

export function reportRiskStatus(value, t) {
	return reportStatus(cleanText(value).toLowerCase() === "none" ? "RISK_NONE" : value, t);
}
