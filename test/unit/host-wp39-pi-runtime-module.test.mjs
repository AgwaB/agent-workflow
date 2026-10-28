// Live bundle 5 (WP39), D1/D2: in a real Pi 1.1 TUI (`pi -e <checkout>/dist/hosts/pi/index.js`) the
// `/aw auto` comparison and `/aw wait` showed no loader (so Escape could not cancel) and the board's
// `c` said "Launch command copy failed". Pi resolves its packages for an extension only while it
// loads the entry; the late `import("@earendil-works/pi-coding-agent")` in active-ui.ts and
// board-source.ts resolved natively and failed (checked live with a probe extension: entry import
// ok, nested late import ERR_MODULE_NOT_FOUND). index.ts now registers the module its entry import
// got, and those late users read it. No Pi, no model or agent-CLI calls: the test environment has
// no Pi package, like the extension's directory in that setup.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const runtime = await import("../../dist/hosts/pi/pi-runtime.js");
const { piBorderedLoaderFactory } = await import(
	"../../dist/hosts/pi/active-ui.js"
);
const { piCopyToClipboard } = await import(
	"../../dist/hosts/pi/board-source.js"
);

afterEach(() => runtime.resetPiRuntimeModuleForTests());

test("without Pi's module the late users degrade (no loader) or fail (copy), as seen live", async () => {
	assert.equal(await piBorderedLoaderFactory(), undefined);
	await assert.rejects(piCopyToClipboard("x"));
});

test("the module registered by the entry gives the loader and the clipboard", async () => {
	const copied = [];
	class FakeLoader {
		constructor(tui, theme, label) {
			this.args = { tui, theme, label };
		}
	}
	runtime.registerPiRuntimeModule({
		BorderedLoader: FakeLoader,
		copyToClipboard: async (text) => {
			copied.push(text);
		},
	});
	const factory = await piBorderedLoaderFactory();
	assert.equal(typeof factory, "function");
	const loader = factory("tui", "theme", "Comparing workflow candidates…");
	assert.ok(loader instanceof FakeLoader);
	assert.equal(loader.args.label, "Comparing workflow candidates…");
	await piCopyToClipboard('/aw auto "task"');
	assert.deepEqual(copied, ['/aw auto "task"']);
});

test("the entry registers the module it imported (source check: index.ts)", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(
		new URL("../../src/hosts/pi/index.ts", import.meta.url),
		"utf8",
	);
	assert.match(
		source,
		/registerPiRuntimeModule\(await import\(PI_PACKAGE\)\)/u,
	);
	for (const file of ["active-ui.ts", "board-source.ts"]) {
		const late = await readFile(
			new URL(`../../src/hosts/pi/${file}`, import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(late, /await import\(PI_PACKAGE\)/u, file);
		assert.match(late, /loadPiRuntimeModule\(\)/u, file);
	}
});
