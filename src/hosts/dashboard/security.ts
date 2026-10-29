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
export function bootstrapSession(
	response: ServerResponse,
	token: string,
): void {
	response.setHeader(
		"Set-Cookie",
		`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
	);
	response.writeHead(302, { Location: "/" });
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
