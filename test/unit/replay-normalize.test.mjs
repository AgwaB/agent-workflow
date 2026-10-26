import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareTrees, createContext, loadAllowedDifferences, normalizeTree } from "../replay/normalize.mjs";

const fixture = fileURLToPath(new URL("../replay/fixtures/minimal/", import.meta.url));

test("replay policy reproduces the committed normalized tree of the minimal recording", () => {
	const out = mkdtempSync(join(tmpdir(), "aw-replay-normalize-"));
	try {
		normalizeTree(join(fixture, "run"), join(out, "n"), createContext({}), { allowed: loadAllowedDifferences() });
		assert.deepEqual(compareTrees(join(fixture, "normalized"), join(out, "n")), []);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
