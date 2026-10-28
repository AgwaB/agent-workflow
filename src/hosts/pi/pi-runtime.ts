// New in agent-workflow (live bundle 5, WP39): Pi's own module for the Pi host's late imports.
// Pi 1.1 resolves its packages (`@earendil-works/pi-coding-agent`, …) for an extension only while it
// loads the extension entry (jiti with aliases). A computed `import()` made later from a nested
// module resolves natively and fails when the extension's directory has no copy of the Pi package
// (`pi -e <checkout>/dist/hosts/pi/index.js`; `pi install` does not install the optional peer
// either). Live, that silently disabled the `/aw wait` and `/aw auto` loaders (no Escape) and made
// the board's `c` report "Launch command copy failed". index.ts loads Pi's module once and
// registers it here; the late users read it from here and import only as a fallback.

// Not a string literal on purpose: the package builds without the optional Pi peer.
export const PI_PACKAGE: string = ["@earendil-works", "pi-coding-agent"].join(
	"/",
);

let registered: Record<string, unknown> | undefined;

/** index.ts: the module its top-level `import()` of Pi returned. */
export function registerPiRuntimeModule(module: unknown): void {
	if (module !== null && typeof module === "object")
		registered = module as Record<string, unknown>;
}

/** Pi's module: the registered one, else a dynamic import (throws when Pi cannot be resolved). */
export async function loadPiRuntimeModule(): Promise<Record<string, unknown>> {
	if (registered !== undefined) return registered;
	return (await import(PI_PACKAGE)) as Record<string, unknown>;
}

/** Tests only. */
export function resetPiRuntimeModuleForTests(): void {
	registered = undefined;
}
