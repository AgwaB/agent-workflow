// The package version both MCP servers report (moved here from their two copies, refactor
// 2026-11-04). dist/mcp/package-version.js -> ../../package.json is the package root.
import { readFileSync } from "node:fs";

export function packageVersion(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
