import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { literalModuleImports } from "./support-source-lookups.js";
import type {
	ArtifactGraphStageSpec,
	ArtifactGraphWorkflowSpec,
} from "./types.js";

/** Advisory only: never execute helpers to discover what they import or read. */
export async function bundleFileWarnings(
	spec: ArtifactGraphWorkflowSpec,
	specPath: string,
): Promise<string[]> {
	if (basename(specPath) !== "spec.json") return [];
	const dir = dirname(specPath);
	const root = await realpath(dir).catch(() => undefined);
	if (!root) return [];
	const relativeFiles = async (subdir: string, extension: string) => {
		const path = join(dir, subdir);
		if (!(await lstat(path).catch(() => undefined))?.isDirectory()) return [];
		const entries = await readdir(path, { withFileTypes: true }).catch(
			() => [],
		);
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
			.map((entry) => `${subdir}/${entry.name}`);
	};
	const candidates = [
		...(await relativeFiles("schemas", ".json")),
		...(await relativeFiles("helpers", ".mjs")),
	];
	if (candidates.length === 0) return [];
	const reachable = new Set<string>();
	const pending: string[] = [];
	const add = (name: unknown, from: string) => {
		if (typeof name !== "string" || isAbsolute(name)) return;
		let resolved: string;
		try {
			resolved = fileURLToPath(new URL(name, pathToFileURL(from)));
		} catch {
			return;
		}
		const inside = relative(dir, resolved);
		if (
			!inside ||
			inside === ".." ||
			inside.startsWith(`..${sep}`) ||
			isAbsolute(inside) ||
			reachable.has(inside)
		)
			return;
		reachable.add(inside);
		if (/\.[cm]?js$/u.test(inside)) pending.push(resolved);
	};
	const visit = (stages: readonly ArtifactGraphStageSpec[], path: string) => {
		for (const stage of stages) {
			if (!stage || typeof stage !== "object") continue;
			add(stage.output?.controlSchema, path);
			add(stage.support?.uses, path);
			add(stage.dynamic?.uses, path);
			for (const helper of Object.values(stage.dynamic?.helpers ?? {})) {
				add(helper?.uses, path);
				add(helper?.inputSchema, path);
				add(helper?.outputSchema, path);
			}
			if (Array.isArray(stage.stages)) visit(stage.stages, path);
			if (stage.onExhausted) visit([stage.onExhausted], path);
		}
	};
	visit(spec.artifactGraph.stages, specPath);
	// Explicit alternate entry points (e.g. deep-research/tiered-verification.spec.json)
	// live beside spec.json and may use the same assets. Flat specs elsewhere are not scanned.
	for (const file of await readdir(dir, { withFileTypes: true }).catch(
		() => [],
	)) {
		if (!file.isFile() || !file.name.endsWith(".spec.json")) continue;
		const path = join(dir, file.name);
		try {
			const alt = JSON.parse(await readFile(path, "utf8"));
			if (alt?.schemaVersion === 1 && Array.isArray(alt.artifactGraph?.stages))
				visit(alt.artifactGraph.stages, path);
		} catch {
			// An unreadable alternate spec has no statically discoverable references.
		}
	}
	while (pending.length > 0) {
		const path = pending.pop()!;
		const real = await realpath(path).catch(() => undefined);
		if (
			!real?.startsWith(`${root}${sep}`) ||
			!(await stat(real).catch(() => undefined))?.isFile()
		)
			continue;
		const text = await readFile(real, "utf8").catch(() => "");
		for (const name of literalModuleImports(text)) add(name, path);
	}
	const orphans = candidates
		.filter((candidate) => !reachable.has(candidate))
		.sort();
	return orphans.length > 0
		? [
				`Possibly orphaned bundle files: ${orphans.map((candidate) => JSON.stringify(candidate)).join(", ")}. No spec reference or reachable relative import was found. Advisory: computed import() paths and fs reads are invisible; verify usage before deleting.`,
			]
		: [];
}
