#!/usr/bin/env node
// Vendors Shiki for the dashboard's code colouring (owner decision 2026-11-03: "Shiki 쓰자").
//
// The dashboard ships static files and no runtime dependencies, so this script builds a small
// browser bundle once and commits it under src/hosts/dashboard/ui/vendor/shiki/:
//   - highlight.js: Shiki core + the JavaScript regex engine (no WASM: the dashboard CSP has no
//     'wasm-unsafe-eval'), exporting language(name) and tokens(code, name);
//   - chunk-*.js: one lazily imported chunk per language grammar and theme, so a report loads only
//     the grammars its code blocks use;
//   - colours.css: one class per theme colour (.shl-<hex> sets --shiki-light, .shd-<hex> sets
//     --shiki-dark), so the dashboard colours tokens with classes, not inline styles;
//   - THIRD-PARTY-NOTICES.txt: the licences of every bundled package, grammar and theme;
//   - manifest.json: versions, languages, aliases, themes and file hashes.
// Only grammars whose licence tm-grammars records (all MIT here) are bundled; the script fails
// otherwise. Re-run after changing VERSIONS or LANGUAGES:
//   node tools/release/vendor-shiki.mjs
// It installs the pinned packages into a temporary directory (network) and needs npm.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "src/hosts/dashboard/ui/vendor/shiki");

const VERSIONS = {
	"@shikijs/core": "4.6.0",
	"@shikijs/engine-javascript": "4.6.0",
	"@shikijs/langs": "4.6.0",
	"@shikijs/themes": "4.6.0",
	// Licence metadata and texts for the grammars and themes (not bundled).
	"tm-grammars": "1.32.22",
	"tm-themes": "1.12.12",
	esbuild: "0.25.12",
};
const LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"json",
	"jsonc",
	"python",
	"go",
	"rust",
	"java",
	"kotlin",
	"swift",
	"c",
	"csharp",
	"shellscript",
	"diff",
	"sql",
	"html",
	"css",
	"markdown",
	"docker",
];
const ALIASES = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	jsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	golang: "go",
	rs: "rust",
	kt: "kotlin",
	kts: "kotlin",
	cs: "csharp",
	"c#": "csharp",
	h: "c",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	shell: "shellscript",
	console: "shellscript",
	patch: "diff",
	md: "markdown",
	dockerfile: "docker",
	htm: "html",
};
const THEMES = { light: "github-light", dark: "github-dark-dimmed" };

const work = await mkdtemp(join(tmpdir(), "aw-vendor-shiki-"));
try {
	await writeFile(
		join(work, "package.json"),
		JSON.stringify({ private: true, type: "module", dependencies: VERSIONS }),
	);
	execFileSync(
		"npm",
		["install", "--no-audit", "--no-fund", "--loglevel=error"],
		{ cwd: work, stdio: "inherit" },
	);
	await writeFile(join(work, "entry.mjs"), entrySource());
	const esbuild = createRequire(join(work, "package.json"))("esbuild");
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	const result = await esbuild.build({
		absWorkingDir: work,
		entryPoints: ["entry.mjs"],
		bundle: true,
		format: "esm",
		splitting: true,
		minify: true,
		target: "es2022",
		outdir: target,
		entryNames: "highlight",
		chunkNames: "chunk-[hash]",
		legalComments: "none",
		metafile: true,
		logLevel: "warning",
	});
	const inputs = Object.keys(result.metafile.inputs);
	await writeFile(join(target, "colours.css"), await colourClasses(work));
	await writeFile(
		join(target, "THIRD-PARTY-NOTICES.txt"),
		await notices(work, inputs),
	);
	const files = [];
	for (const name of (await readdir(target)).sort()) {
		if (!/\.(?:js|css)$/.test(name)) continue;
		const bytes = await readFile(join(target, name));
		if (/\/Users\/|\/home\/|[A-Z]:\\\\/.test(bytes.toString("utf8")))
			throw new Error(`${name}: contains a local path`);
		files.push({
			name,
			bytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	}
	await writeFile(
		join(target, "manifest.json"),
		`${JSON.stringify(
			{
				generatedBy: "tools/release/vendor-shiki.mjs",
				versions: VERSIONS,
				languages: LANGUAGES,
				aliases: ALIASES,
				themes: THEMES,
				files,
			},
			null,
			"\t",
		)}\n`,
	);
	const total = files.reduce((sum, file) => sum + file.bytes, 0);
	console.log(
		`vendored Shiki ${VERSIONS["@shikijs/core"]}: ${files.length} files, ${(total / 1024).toFixed(0)} KiB -> ${relative(root, target)}`,
	);
} finally {
	await rm(work, { recursive: true, force: true });
}

function entrySource() {
	const langs = LANGUAGES.map(
		(lang) =>
			`\t${JSON.stringify(lang)}: () => import("@shikijs/langs/${lang}"),`,
	).join("\n");
	return `import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
const LANGS = {
${langs}
};
const ALIASES = ${JSON.stringify(ALIASES)};
const THEMES = ${JSON.stringify(THEMES)};
let core;
/** The bundled language for a fence tag, or null. */
export function language(name) {
	const id = String(name || "").toLowerCase();
	const lang = Object.hasOwn(ALIASES, id) ? ALIASES[id] : id;
	return Object.hasOwn(LANGS, lang) ? lang : null;
}
/** Lines of tokens; each token has content and htmlStyle {"--shiki-light", "--shiki-dark"}. */
export async function tokens(code, name) {
	const lang = language(name);
	if (!lang) return null;
	core ??= createHighlighterCore({
		themes: [
			import("@shikijs/themes/${THEMES.light}"),
			import("@shikijs/themes/${THEMES.dark}"),
		],
		langs: [],
		engine: createJavaScriptRegexEngine(),
	});
	const highlighter = await core;
	if (!highlighter.getLoadedLanguages().includes(lang))
		await highlighter.loadLanguage(LANGS[lang]());
	return highlighter.codeToTokens(code, { lang, themes: THEMES, defaultColor: false })
		.tokens;
}
`;
}

/** Every colour the two themes can give a token, as classes setting --shiki-light / --shiki-dark. */
async function colourClasses(work) {
	const out = [
		"/* Generated by tools/release/vendor-shiki.mjs: Shiki theme colours as classes. */",
	];
	for (const [variant, prefix] of [
		["light", "shl"],
		["dark", "shd"],
	]) {
		const theme = (
			await import(
				join(
					work,
					"node_modules/@shikijs/themes/dist",
					`${THEMES[variant]}.mjs`,
				)
			)
		).default;
		const colours = new Set();
		const add = (value) => {
			if (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value))
				colours.add(value.slice(1).toLowerCase());
		};
		add(theme.fg);
		add(theme.colors?.["editor.foreground"]);
		for (const rule of theme.tokenColors ?? theme.settings ?? [])
			add(rule.settings?.foreground);
		for (const hex of [...colours].sort())
			out.push(`.${prefix}-${hex} { --shiki-${variant}: #${hex}; }`);
	}
	return `${out.join("\n")}\n`;
}

/** Licences of the bundled packages, then the grammar and theme sections tm-grammars/tm-themes record. */
async function notices(work, inputs) {
	const out = [
		"Third-party notices for the vendored Shiki bundle",
		"=================================================",
		"",
		"Generated by tools/release/vendor-shiki.mjs. The files in this directory bundle the",
		"packages, grammars and themes listed below, each under its own licence.",
		"",
	];
	const packages = new Set();
	for (const input of inputs) {
		const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
		if (match) packages.add(match[1]);
	}
	for (const name of [...packages].sort()) {
		const dir = join(work, "node_modules", name);
		const manifest = JSON.parse(
			await readFile(join(dir, "package.json"), "utf8"),
		);
		const licenceFile = (await readdir(dir)).find((file) =>
			/^licen[cs]e/i.test(file),
		);
		if (!licenceFile) throw new Error(`${name}: no licence file to reproduce`);
		out.push(
			"-".repeat(72),
			`Package: ${name}@${manifest.version} (${manifest.license})`,
			"-".repeat(72),
			(await readFile(join(dir, licenceFile), "utf8")).trim(),
			"",
		);
	}
	const grammars = new Set();
	for (const input of inputs) {
		const match = /@shikijs\/langs\/dist\/([\w-]+)\.mjs$/.exec(input);
		if (match) grammars.add(match[1]);
	}
	const themes = new Set(Object.values(THEMES));
	out.push(
		...(await sections(
			join(work, "node_modules/tm-grammars/NOTICE"),
			grammars,
			"grammar",
		)),
		...(await sections(
			join(work, "node_modules/tm-themes/NOTICE"),
			themes,
			"theme",
		)),
	);
	return `${out.join("\n").trimEnd()}\n`;
}

async function sections(noticePath, names, kind) {
	const text = await readFile(noticePath, "utf8");
	const blocks = text.split(/^={20,}$/m).slice(1);
	const found = new Map();
	const out = [];
	for (const block of blocks) {
		const files = /^Files:\s*(.+)$/m.exec(block)?.[1] ?? "";
		const covered = files
			.split(/[,\s]+/)
			.map((file) => file.replace(/\.json$/, ""))
			.filter((name) => names.has(name));
		if (!covered.length) continue;
		const spdx = /^SPDX:\s*(.+)$/m.exec(block)?.[1]?.trim();
		if (spdx !== "MIT")
			throw new Error(
				`${covered.join(", ")}: ${kind} licence ${spdx ?? "unknown"} is not MIT; review before bundling`,
			);
		for (const name of covered) found.set(name, spdx);
		out.push("-".repeat(72), block.trim(), "");
	}
	const missing = [...names].filter((name) => !found.has(name));
	if (missing.length)
		throw new Error(
			`no licence recorded for ${kind}(s) ${missing.join(", ")}; drop them or review their licence`,
		);
	return out;
}
