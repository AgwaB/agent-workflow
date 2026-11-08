// agent-workflow 2026-11-01: bounded public-web GET for engine-side evidence checks.
// Reference-checked choices (analysis report nontext-evidence-refs-20261101, §9b of the evidence
// receipts design):
// - plain HTTP, like gemini-cli/qwen-code/opencode/crush/cline/crewai web fetch tools;
// - `Accept` prefers Markdown and `Accept-Language` is en-US (opencode webfetch.ts); documentation
//   sites that redirect by locale return their English Markdown (verified on Claude docs);
// - private, loopback, link-local and reserved addresses are refused for the name AND every redirect
//   hop, at connect time so DNS answers cannot change after the check (crewai url_read_tool);
// - credentials in URLs are refused; bodies are capped while streaming, also after decompression.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const EVIDENCE_FETCH_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 agent-workflow-evidence-check";
export const EVIDENCE_FETCH_ACCEPT =
	"text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, application/xhtml+xml;q=0.7, application/pdf;q=0.6, */*;q=0.1";
export const EVIDENCE_FETCH_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

export type SafeFetchFailure =
	| "invalid-url"
	| "unsupported-scheme"
	| "credentials-in-url"
	| "blocked-address"
	| "dns-failed"
	| "too-many-redirects"
	| "http-error"
	| "too-large"
	| "timeout"
	| "network-error"
	| "aborted"
	// X2: a re-check from a run's page store found no stored body for the URL.
	| "not-stored";

export type SafeFetchResult =
	| {
			readonly ok: true;
			readonly url: string;
			readonly finalUrl: string;
			readonly status: number;
			readonly contentType: string;
			readonly body: Buffer;
			readonly redirects: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly url: string;
			readonly reason: SafeFetchFailure;
			readonly detail: string;
			readonly status?: number;
			readonly finalUrl?: string;
	  };

export interface SafeFetchOptions {
	readonly signal?: AbortSignal;
	/** Body cap for most types (default 5 MB). */
	readonly maxBytes?: number;
	/** Body cap when the response is a PDF (default 10 MB). */
	readonly maxPdfBytes?: number;
	/** Whole request including redirects (default 30 s). */
	readonly timeoutMs?: number;
	readonly maxRedirects?: number;
	/** Tests only: allow these exact host names despite private addresses (e.g. a local server). */
	readonly allowHostsForTests?: readonly string[];
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	// Deprecated site-local (RFC 3879); still routed inside some networks (quality A/B 2026-11-02).
	["fec0::", 10],
	["ff00::", 8],
] as const)
	BLOCKED.addSubnet(net, prefix, "ipv6");

/** True for addresses an evidence fetch must never connect to. */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return BLOCKED.check(address, "ipv4");
	if (family !== 6) return true;
	const mapped = address
		.toLowerCase()
		.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	if (mapped !== undefined) return BLOCKED.check(mapped, "ipv4");
	if (/^::ffff:/i.test(address)) return true;
	return BLOCKED.check(address, "ipv6");
}

class FetchStop extends Error {
	constructor(
		readonly reason: SafeFetchFailure,
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

function hostBlockedByName(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host === "metadata.google.internal"
	);
}

function checkUrl(raw: string, allowHosts: ReadonlySet<string>): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new FetchStop("invalid-url", `not a URL: ${raw.slice(0, 200)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new FetchStop("unsupported-scheme", `scheme ${url.protocol}`);
	if (url.username !== "" || url.password !== "")
		throw new FetchStop("credentials-in-url", "URL carries credentials");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (allowHosts.has(host)) return url;
	if (hostBlockedByName(host))
		throw new FetchStop("blocked-address", `host ${host} is local`);
	if (isIP(host) !== 0 && isBlockedAddress(host))
		throw new FetchStop("blocked-address", `address ${host} is not public`);
	return url;
}

type LookupCallback = (
	error: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void;

// Connect-time resolution: every resolved address must be public (DNS rebinding cannot swap in a
// private address after a separate pre-check).
export function publicOnlyLookup(allowHosts: ReadonlySet<string> = new Set()) {
	return (
		hostname: string,
		options: { all?: boolean; family?: number | string },
		callback: LookupCallback,
	): void => {
		dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
			if (error) return callback(error, []);
			const list = addresses as LookupAddress[];
			if (list.length === 0)
				return callback(
					Object.assign(new Error(`no address for ${hostname}`), {
						code: "ENOTFOUND",
					}),
					[],
				);
			if (
				!allowHosts.has(hostname) &&
				list.some((entry) => isBlockedAddress(entry.address))
			)
				return callback(
					Object.assign(
						new Error(`${hostname} resolves to a non-public address`),
						{
							code: "EVIDENCE_BLOCKED_ADDRESS",
						},
					),
					[],
				);
			if (options.all) return callback(null, list);
			const first = list[0] as LookupAddress;
			callback(null, first.address, first.family);
		});
	};
}

// `pipeline`, not `pipe`: a source error or early close (connection reset, the timeout aborting the
// request) must reach the decoder. With `pipe` the decoder never ended and the fetch never settled,
// timeout included (found by the 2026-11-02 quality A/B reviews, reproduced).
function decoded(response: IncomingMessage): NodeJS.ReadableStream {
	const encoding = String(response.headers["content-encoding"] ?? "")
		.trim()
		.toLowerCase();
	const decoder =
		encoding === "gzip" || encoding === "x-gzip"
			? createGunzip()
			: encoding === "deflate"
				? createInflate()
				: encoding === "br"
					? createBrotliDecompress()
					: undefined;
	if (decoder === undefined) return response;
	// A source failure destroys the decoder with that error; the caller listens on the decoder.
	pipeline(response, decoder, () => undefined);
	return decoder;
}

function isPdfType(contentType: string): boolean {
	return /^application\/(?:x-)?pdf\b/i.test(contentType);
}

interface OneHop {
	status: number;
	location?: string;
	contentType: string;
	body?: Buffer;
}

function getOnce(
	url: URL,
	options: Required<Pick<SafeFetchOptions, "maxBytes" | "maxPdfBytes">>,
	allowHosts: ReadonlySet<string>,
	signal: AbortSignal,
): Promise<OneHop> {
	return new Promise<OneHop>((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = send(
			url,
			{
				method: "GET",
				headers: {
					"User-Agent": EVIDENCE_FETCH_USER_AGENT,
					Accept: EVIDENCE_FETCH_ACCEPT,
					"Accept-Language": EVIDENCE_FETCH_ACCEPT_LANGUAGE,
					"Accept-Encoding": "gzip, deflate, br",
				},
				lookup: publicOnlyLookup(allowHosts) as never,
				signal,
			},
			(response) => {
				const status = response.statusCode ?? 0;
				const contentType = String(response.headers["content-type"] ?? "");
				if (status >= 300 && status < 400 && response.headers.location) {
					response.resume();
					resolve({
						status,
						location: response.headers.location,
						contentType,
					});
					return;
				}
				if (status < 200 || status >= 300) {
					response.resume();
					reject(new FetchStop("http-error", `HTTP ${status}`, status));
					return;
				}
				const cap = isPdfType(contentType)
					? options.maxPdfBytes
					: options.maxBytes;
				const declared = Number(response.headers["content-length"]);
				if (
					Number.isFinite(declared) &&
					declared > cap &&
					!response.headers["content-encoding"]
				) {
					response.destroy();
					reject(new FetchStop("too-large", `${declared} bytes > ${cap}`));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				const stream = decoded(response);
				stream.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > cap) {
						response.destroy();
						(stream as { destroy?: () => void }).destroy?.();
						reject(new FetchStop("too-large", `more than ${cap} bytes`));
						return;
					}
					chunks.push(chunk);
				});
				stream.on("error", (error: Error) => reject(error));
				stream.on("end", () =>
					resolve({ status, contentType, body: Buffer.concat(chunks) }),
				);
				// Closed without `end` and without an error: still settle (no-op after `end`).
				stream.on("close", () =>
					reject(new Error("response closed before its end")),
				);
			},
		);
		request.on("error", reject);
		request.end();
	});
}

function failureOf(error: unknown, signal: AbortSignal, outer?: AbortSignal) {
	if (error instanceof FetchStop)
		return {
			reason: error.reason,
			detail: error.message,
			status: error.status,
		};
	const code = (error as NodeJS.ErrnoException)?.code;
	if (outer?.aborted) return { reason: "aborted" as const, detail: "stopped" };
	if (signal.aborted)
		return { reason: "timeout" as const, detail: "timed out" };
	if (code === "EVIDENCE_BLOCKED_ADDRESS")
		return {
			reason: "blocked-address" as const,
			detail: (error as Error).message,
		};
	if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA")
		return { reason: "dns-failed" as const, detail: String(code) };
	return {
		reason: "network-error" as const,
		detail: (error as Error)?.message?.slice(0, 200) ?? String(error),
	};
}

export async function safeFetch(
	rawUrl: string,
	options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
	const limits = {
		maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
		maxPdfBytes: options.maxPdfBytes ?? 10 * 1024 * 1024,
	};
	const maxRedirects = options.maxRedirects ?? 5;
	const allowHosts = new Set(options.allowHostsForTests ?? []);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const redirects: string[] = [];
	let current = rawUrl;
	try {
		for (let hop = 0; ; hop += 1) {
			const url = checkUrl(current, allowHosts);
			url.hash = "";
			const result = await getOnce(url, limits, allowHosts, signal);
			if (result.location !== undefined) {
				if (hop >= maxRedirects)
					throw new FetchStop(
						"too-many-redirects",
						`more than ${maxRedirects} redirects`,
					);
				current = new URL(result.location, url).href;
				redirects.push(current);
				continue;
			}
			return {
				ok: true,
				url: rawUrl,
				finalUrl: url.href,
				status: result.status,
				contentType: result.contentType,
				body: result.body ?? Buffer.alloc(0),
				redirects,
			};
		}
	} catch (error) {
		const failure = failureOf(error, signal, options.signal);
		return {
			ok: false,
			url: rawUrl,
			...failure,
			...(redirects.length > 0 ? { finalUrl: current } : {}),
		};
	}
}
