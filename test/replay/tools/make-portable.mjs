#!/usr/bin/env node
// make-portable.mjs <srcDir> <outDir> --root P --pkg P [--home P] [--tmp P]
// Copies a recording tree replacing absolute host roots with <ROOT>/<PKG>/<HOME>/<TMP>
// (the reversible first step of test/replay/normalize.mjs). Text files only.
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createContext, portablePaths } from "../normalize.mjs"; // pi-workflow copy: "../../test/replay/normalize.mjs"
const argv = process.argv.slice(2);
const pos = [];
const roots = { HOME: homedir(), TMP: tmpdir() };
for (let i = 0; i < argv.length; i += 1) {
	const a = argv[i];
	if (a === "--root") roots.ROOT = argv[++i];
	else if (a === "--pkg") roots.PKG = argv[++i];
	else if (a === "--home") roots.HOME = argv[++i];
	else if (a === "--tmp") roots.TMP = argv[++i];
	else pos.push(a);
}
const [src, out] = pos.map((p) => resolve(p));
const ctx = createContext(roots);
rmSync(out, { recursive: true, force: true });
const walk = (from, to) => {
	for (const e of readdirSync(from, { withFileTypes: true })) {
		const s = join(from, e.name);
		const t = join(to, portablePaths(e.name, ctx));
		if (e.isDirectory()) walk(s, t);
		else {
			mkdirSync(dirname(t), { recursive: true });
			writeFileSync(t, portablePaths(readFileSync(s, "utf8"), ctx));
		}
	}
};
walk(src, out);
console.log(`portable copy ${src} -> ${out}`);
