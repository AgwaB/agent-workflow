// agent-workflow 2026-11-01: experimental engine-side check of verifier web quotes.
// Off unless the owner sets AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH=1. When on, every
// verifier evidence row with an http(s) URL and a quote is checked by the engine itself
// (`context.evidence.checkWebQuotes`: fetch the cited page, look for the quote). No model calls.
// The result is shown in the report (counts in final-report.md, unchecked quotes in audit.md);
// it does not change any claim verdict.

const VERIFIER_STAGE_IDS = ["verify-claims", "verify-core-claims", "verify-tail-claims"];
const MAX_QUOTE_CHARS = 400;

function verifierRows(value) {
	if (Array.isArray(value)) return value.flatMap(verifierRows);
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value.auditedClaims)) return value.auditedClaims;
	if (Array.isArray(value.results)) return value.results;
	if ("status" in value || "verdict" in value || "claimId" in value || "id" in value)
		return [value];
	return [];
}

function claimIdOf(row) {
	for (const key of ["id", "claimId"])
		if (typeof row?.[key] === "string" && row[key].trim()) return row[key].trim();
	return null;
}

function webUrlOf(evidence) {
	for (const key of ["url", "sourceUrl"]) {
		const value = typeof evidence?.[key] === "string" ? evidence[key].trim() : "";
		if (/^https?:\/\//i.test(value)) return value;
	}
	return null;
}

export function collectWebQuotes(sources) {
	const rows = [];
	const seen = new Set();
	for (const [sourceId, source] of Object.entries(sources ?? {})) {
		if (!VERIFIER_STAGE_IDS.some((id) => sourceId === id || sourceId.startsWith(`${id}.`)))
			continue;
		for (const claim of verifierRows(source)) {
			const claimId = claimIdOf(claim);
			const evidence = Array.isArray(claim?.evidence) ? claim.evidence : [];
			for (const [index, row] of evidence.entries()) {
				const url = webUrlOf(row);
				if (!url) continue;
				const key = `${claimId ?? sourceId}#${index}`;
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push({
					key,
					claimId,
					evidenceIndex: index,
					url,
					quote: typeof row.quote === "string" ? row.quote : "",
				});
			}
		}
	}
	return rows;
}

export default async function checkWebQuotes({ sources, context = {} }) {
	const schema = "deep-research-web-quote-check-v1";
	if (!context.evidence?.refetchEnabled)
		return {
			schema,
			enabled: false,
			digest:
				"Web quote check is off (experimental; set AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH=1).",
			results: [],
		};
	const rows = collectWebQuotes(sources);
	let checked;
	try {
		checked = await context.evidence.checkWebQuotes(
			rows.map(({ key, url, quote }) => ({ key, url, quote })),
		);
	} catch (error) {
		context.signal?.throwIfAborted();
		const message = error instanceof Error ? error.message : String(error);
		return {
			schema,
			enabled: true,
			digest: `Web quote check could not run: ${message}`,
			error: message,
			results: [],
		};
	}
	const byKey = new Map(rows.map((row) => [row.key, row]));
	const results = checked.results.map((result) => {
		const row = byKey.get(result.key);
		return {
			claimId: row?.claimId ?? null,
			evidenceIndex: row?.evidenceIndex ?? null,
			url: result.url,
			quote: (row?.quote ?? "").slice(0, MAX_QUOTE_CHARS),
			grade: result.grade,
			...(result.level ? { level: result.level } : {}),
			...(result.view ? { view: result.view } : {}),
			...(result.reason ? { reason: result.reason } : {}),
			...(result.detail ? { detail: result.detail } : {}),
			...(result.page
				? {
						page: {
							finalUrl: result.page.finalUrl,
							status: result.page.status,
							contentType: result.page.contentType,
							bodySha256: result.page.bodySha256,
							fromCache: result.page.fromCache,
						},
					}
				: {}),
		};
	});
	const { summary } = checked;
	return {
		schema,
		enabled: true,
		digest: `Web quote check: ${summary.verified} of ${summary.quotes} quotes found on the cited page (${summary.pages} pages); ${summary.unverified} not checked.`,
		summary,
		results,
	};
}
