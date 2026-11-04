// Id and path checks shared by the runtime's artifact store, registry and orchestration (moved here
// unchanged from their copies, refactor 2026-11-04).
import { isAbsolute, relative, sep } from "node:path";

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertSafeId(name: string, value: string): void {
	if (!SAFE_ID_PATTERN.test(value)) {
		throw new Error(
			`${name} must contain only letters, numbers, dots, underscores, or dashes.`,
		);
	}
}

export function isInsideOrEqual(parent: string, child: string): boolean {
	const childRelative = relative(parent, child);
	return (
		childRelative === "" ||
		(!childRelative.startsWith("..") && !isAbsolute(childRelative))
	);
}

export function toSafeRelativePath(cwd: string, artifactPath: string): string {
	const artifactRelative = relative(cwd, artifactPath);
	if (
		artifactRelative === "" ||
		artifactRelative.startsWith("..") ||
		isAbsolute(artifactRelative)
	) {
		throw new Error(
			"artifact path must stay inside cwd to be exposed as a relative tool path.",
		);
	}
	return artifactRelative.split(sep).join("/");
}
