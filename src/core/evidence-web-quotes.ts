// agent-workflow 2026-11-01: engine-side check of web quotes (experimental, opt-in).
// For each `{url, quote}` the engine fetches the cited page itself (cache, safe fetch, PDF text),
// builds the page's text views and looks for the quote (evidence-quote-match.ts). The model never
// sees this and no tokens are spent. A quote that cannot be checked gets a reason (image, PDF tool
// missing, blocked address, little page text, …) instead of a verdict: honest labelling, not a
// gate (owner decision 2026-11-01; offline sample of 114 recorded quotes: 0 fabricated, 5 unchecked
// — images 4, PDF table 1).
import {
	EvidencePageCache,
	evidenceCacheDir,
	type CachedPage,
} from "./evidence-page-cache.js";
import { isPdf, pdfTextViews, pdfToText } from "./evidence-pdf-text.js";
import {
	matchQuote,
	PreparedPage,
	type QuoteMatchLevel,
} from "./evidence-quote-match.js";
import {
	safeFetch,
	type SafeFetchFailure,
	type SafeFetchResult,
} from "./evidence-safe-fetch.js";
import { htmlToTextViews } from "./evidence-text-views.js";
import { workflowExperimentalFlagEnabled } from "./experimental-speed-flags.js";

export const EVIDENCE_REFETCH_ENV =
	"AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH";

export interface WebQuoteInput {
	/** Caller's id for the row (e.g. `claimId#evidenceIndex`). */
	readonly key: string;
	readonly url: string;
	readonly quote: string;
}

export type WebQuoteReason =
	| SafeFetchFailure
	| "no-quote"
	| "quote-not-on-page"
	| "little-page-text"
	| "image"
	| "audio"
	| "video"
	| "unsupported-type"
	| "pdf-tool-missing"
	| "pdf-extract-failed";

export type WebQuoteView = "rendered" | "tex" | "text" | "pdf" | "pdf-joined";

export interface WebQuotePage {
	readonly url: string;
	readonly finalUrl: string;
	readonly status: number;
	readonly contentType: string;
	readonly bodySha256: string;
	readonly bytes: number;
	readonly fetchedAt: string;
	readonly fromCache: boolean;
}

export interface WebQuoteResult {
	readonly key: string;
	readonly url: string;
	readonly grade: "verified-refetched" | "unverified";
	readonly level?: QuoteMatchLevel;
	readonly view?: WebQuoteView;
	readonly reason?: WebQuoteReason;
	readonly detail?: string;
	readonly page?: WebQuotePage;
}

export interface WebQuoteSummary {
	readonly quotes: number;
	readonly pages: number;
	readonly verified: number;
	readonly unverified: number;
	readonly byLevel: Partial<Record<QuoteMatchLevel, number>>;
	readonly byReason: Partial<Record<WebQuoteReason, number>>;
}

export interface CheckWebQuotesOptions {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly concurrency?: number;
	readonly cache?: EvidencePageCache;
	readonly fetch?: (
		url: string,
		options: { signal?: AbortSignal },
	) => Promise<SafeFetchResult>;
	readonly pdfToText?: typeof pdfToText;
}

type PageOutcome =
	| {
			readonly ok: true;
			readonly page: WebQuotePage;
			readonly views: PreparedPage;
			readonly names: readonly WebQuoteView[];
			readonly renderedChars: number;
	  }
	| {
			readonly ok: false;
			readonly reason: WebQuoteReason;
			readonly detail: string;
			readonly page?: WebQuotePage;
	  };

/** Pages with less reader text than this are probably script-rendered or a block page. */
const LITTLE_TEXT_CHARS = 1000;

function charsetOf(contentType: string, body: Buffer): string {
	const declared = contentType.match(/charset\s*=\s*"?([\w.:-]+)/i)?.[1];
	if (declared) return declared;
	const meta = body
		.subarray(0, 4096)
		.toString("latin1")
		.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
	return meta ?? "utf-8";
}

function decodeText(contentType: string, body: Buffer): string {
	try {
		return new TextDecoder(charsetOf(contentType, body)).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

function isHtml(contentType: string, body: Buffer): boolean {
	if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType))
		return true;
	if (contentType.trim() !== "" && !/^text\/plain\b/i.test(contentType))
		return false;
	return /^\s*(?:<!doctype html|<html\b)/i.test(
		body.subarray(0, 1024).toString("latin1"),
	);
}

/** Text views of a fetched body by content type (HTML, Markdown/plain text, PDF), or why none. */
export async function pageTextViews(
	contentType: string,
	body: Buffer,
	options: Pick<CheckWebQuotesOptions, "signal" | "pdfToText"> = {},
): Promise<
	| { views: string[]; names: WebQuoteView[]; renderedChars: number }
	| { reason: WebQuoteReason; detail: string }
> {
	const type = contentType.toLowerCase();
	if (isPdf(type, body)) {
		const result = await (options.pdfToText ?? pdfToText)(body, {
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (!result.ok) return { reason: result.reason, detail: result.detail };
		const views = pdfTextViews(result.text);
		return {
			views,
			names: views.length > 1 ? ["pdf", "pdf-joined"] : ["pdf"],
			renderedChars: result.text.length,
		};
	}
	for (const media of ["image", "audio", "video"] as const)
		if (type.startsWith(`${media}/`))
			return { reason: media, detail: `content type ${contentType}` };
	if (isHtml(type, body)) {
		const { rendered, tex } = htmlToTextViews(decodeText(type, body));
		return tex === undefined
			? {
					views: [rendered],
					names: ["rendered"],
					renderedChars: rendered.length,
				}
			: {
					views: [rendered, tex],
					names: ["rendered", "tex"],
					renderedChars: rendered.length,
				};
	}
	if (
		type === "" ||
		/^text\//.test(type) ||
		/^application\/(?:json|xml|[\w.+-]+\+(?:json|xml))\b/.test(type)
	) {
		const text = decodeText(type, body);
		return { views: [text], names: ["text"], renderedChars: text.length };
	}
	return { reason: "unsupported-type", detail: `content type ${contentType}` };
}

async function loadPage(
	url: string,
	cache: EvidencePageCache,
	options: CheckWebQuotesOptions,
): Promise<PageOutcome> {
	let cached = await cache.get(url);
	let fromCache = cached !== undefined;
	if (!cached) {
		const fetched = await (options.fetch ?? safeFetch)(url, {
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (!fetched.ok)
			return { ok: false, reason: fetched.reason, detail: fetched.detail };
		const entry: CachedPage = await cache.put(
			{
				url,
				finalUrl: fetched.finalUrl,
				status: fetched.status,
				contentType: fetched.contentType,
				redirects: fetched.redirects,
			},
			fetched.body,
		);
		cached = { page: entry, body: fetched.body };
		fromCache = false;
	}
	const { page: entry, body } = cached;
	const page: WebQuotePage = {
		url,
		finalUrl: entry.finalUrl,
		status: entry.status,
		contentType: entry.contentType,
		bodySha256: entry.bodySha256,
		bytes: entry.bytes,
		fetchedAt: entry.fetchedAt,
		fromCache,
	};
	const views = await pageTextViews(entry.contentType, body, options);
	if ("reason" in views)
		return { ok: false, reason: views.reason, detail: views.detail, page };
	return {
		ok: true,
		page,
		views: new PreparedPage(views.views),
		names: views.names,
		renderedChars: views.renderedChars,
	};
}

function fetchKey(url: string): string {
	try {
		const parsed = new URL(url.trim());
		parsed.hash = "";
		return parsed.href;
	} catch {
		return url.trim();
	}
}

export async function checkWebQuotes(
	rows: readonly WebQuoteInput[],
	options: CheckWebQuotesOptions,
): Promise<{ results: WebQuoteResult[]; summary: WebQuoteSummary }> {
	const cache =
		options.cache ?? new EvidencePageCache(evidenceCacheDir(options.cwd));
	const urls = [
		...new Set(
			rows
				.filter((row) => row.quote.trim() !== "")
				.map((row) => fetchKey(row.url)),
		),
	];
	const pages = new Map<string, PageOutcome>();
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < urls.length) {
			options.signal?.throwIfAborted();
			const url = urls[next] as string;
			next += 1;
			pages.set(url, await loadPage(url, cache, options));
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.max(1, Math.min(options.concurrency ?? 4, urls.length)) },
			worker,
		),
	);
	const results = rows.map((row): WebQuoteResult => {
		const base = { key: row.key, url: row.url };
		if (row.quote.trim() === "")
			return { ...base, grade: "unverified", reason: "no-quote" };
		const outcome = pages.get(fetchKey(row.url));
		if (!outcome)
			return { ...base, grade: "unverified", reason: "aborted", detail: "" };
		if (!outcome.ok)
			return {
				...base,
				grade: "unverified",
				reason: outcome.reason,
				detail: outcome.detail,
				...(outcome.page ? { page: outcome.page } : {}),
			};
		const match = matchQuote(row.quote, outcome.views);
		if (match.matched)
			return {
				...base,
				grade: "verified-refetched",
				level: match.level,
				view: outcome.names[match.view] ?? "text",
				page: outcome.page,
			};
		return {
			...base,
			grade: "unverified",
			reason:
				outcome.renderedChars < LITTLE_TEXT_CHARS
					? "little-page-text"
					: "quote-not-on-page",
			page: outcome.page,
		};
	});
	const byLevel: Partial<Record<QuoteMatchLevel, number>> = {};
	const byReason: Partial<Record<WebQuoteReason, number>> = {};
	for (const result of results) {
		if (result.level) byLevel[result.level] = (byLevel[result.level] ?? 0) + 1;
		if (result.reason)
			byReason[result.reason] = (byReason[result.reason] ?? 0) + 1;
	}
	const verified = results.filter(
		(result) => result.grade === "verified-refetched",
	).length;
	return {
		results,
		summary: {
			quotes: results.length,
			pages: urls.length,
			verified,
			unverified: results.length - verified,
			byLevel,
			byReason,
		},
	};
}

/** What support helpers receive as `context.evidence`. */
export interface SupportEvidenceContext {
	/** True when the owner opted in with AGENT_WORKFLOW_EXPERIMENTAL_EVIDENCE_REFETCH=1. */
	readonly refetchEnabled: boolean;
	checkWebQuotes(
		rows: readonly WebQuoteInput[],
	): Promise<{ results: WebQuoteResult[]; summary: WebQuoteSummary }>;
}

export function supportEvidenceContext(
	cwd: string,
	signal: AbortSignal,
	env: Record<string, string | undefined> = process.env,
): SupportEvidenceContext {
	return {
		refetchEnabled: workflowExperimentalFlagEnabled(EVIDENCE_REFETCH_ENV, env),
		checkWebQuotes: (rows) => checkWebQuotes(rows, { cwd, signal }),
	};
}
