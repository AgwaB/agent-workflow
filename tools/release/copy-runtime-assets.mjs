#!/usr/bin/env node
// Build step (run by `npm run build` after tsc): copy non-TypeScript runtime
// assets into dist/ so the compiled runtime finds them next to itself.
// The Darwin process-identity helper must stay executable: process-identity.js
// execFile()s it directly, and a lost exec bit fails every macOS identity check.
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const assets = [
	{ path: "runtime/native/darwin-process-identity", mode: 0o755 },
	{ path: "runtime/native/darwin-process-identity.manifest.json", mode: 0o644 },
];

for (const asset of assets) {
	const source = join(root, "src", asset.path);
	const target = join(root, "dist", asset.path);
	await mkdir(dirname(target), { recursive: true });
	await copyFile(source, target);
	await chmod(target, asset.mode);
	const mode = (await stat(target)).mode & 0o777;
	if (mode !== asset.mode)
		throw new Error(
			`${asset.path}: expected mode ${asset.mode.toString(8)}, got ${mode.toString(8)}`,
		);
	console.log(
		`copied src/${asset.path} -> dist/${asset.path} (${mode.toString(8)})`,
	);
}
