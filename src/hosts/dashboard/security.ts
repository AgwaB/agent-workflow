import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const DASHBOARD_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export const SESSION_COOKIE = "aw_session";
export function generateDashboardToken(): string {
	return randomBytes(32).toString("base64url");
}
export function dashboardCsrf(token: string): string {
	return createHmac("sha256", token).update("csrf").digest("base64url");
}
export function secureEqual(
	actual: string | undefined,
	expected: string,
): boolean {
	if (actual === undefined) return false;
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
export function hasSessionCookie(
	request: IncomingMessage,
	token: string,
): boolean {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
	return (
		values.length === 1 &&
		secureEqual(values[0]!.slice(SESSION_COOKIE.length + 1), token)
	);
}
/** UI state a printed deep link may carry past the bootstrap (`?token=…&run=…`); nothing else survives. */
export const BOOTSTRAP_FORWARDED_PARAMS = [
	"project",
	"run",
	"task",
	"tab",
	"view",
] as const;
const FORWARDED_VALUE = /^[A-Za-z0-9._-]{1,120}$/;

/** Where the bootstrap redirects: `/` plus the allowlisted, well-formed UI params (never the token). */
export function bootstrapLocation(params: URLSearchParams): string {
	const kept = new URLSearchParams();
	for (const key of BOOTSTRAP_FORWARDED_PARAMS) {
		const value = params.get(key);
		if (value && FORWARDED_VALUE.test(value)) kept.set(key, value);
	}
	const query = kept.toString();
	return query ? `/?${query}` : "/";
}

export function bootstrapSession(
	response: ServerResponse,
	token: string,
	location = "/",
): void {
	response.setHeader(
		"Set-Cookie",
		`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
	);
	response.writeHead(302, { Location: location });
	response.end();
}
export function allowedHost(host: string | undefined, port: number): boolean {
	return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
		host ?? "",
	);
}
export function allowedFetchSite(site: string | string[] | undefined): boolean {
	return site === undefined || site === "same-origin" || site === "none";
}
export function validRunId(id: string): boolean {
	return /^workflow_[A-Za-z0-9_-]+$/.test(id);
}
/** Exact task or spec id; never paths, prefixes, control characters or URL separators. */
export function validTaskId(id: string): boolean {
	return id.length <= 256 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(id);
}
export function securityHeaders(response: ServerResponse): void {
	response.setHeader("Content-Security-Policy", DASHBOARD_CSP);
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("Cache-Control", "no-store");
}
