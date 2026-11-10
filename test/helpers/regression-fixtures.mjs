// Engine-replay regression fixtures (2026-11-10, owner: "리그레션 테스트를 대거 추가"; context-quality X5 step 3).
// A recorded run is frozen into one gzip JSON: every model task's raw outputs in attempt order (failed attempts
// first), the artifact reads it made, the project files of the run's cwd, the runtime task and profile, and the web
// pages its quote check read. test/regression/engine-replay.test.mjs replays it through the real engine with the
// fixture executor's `replay` option and compares the outcome with a golden file.
//
//   node test/helpers/regression-fixtures.mjs --capture <run dir> <name>   freeze a recorded run
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REGRESSION_FIXTURES = join(REPO, "test", "fixtures", "regression");
export const REGRESSION_GOLDEN = join(REGRESSION_FIXTURES, "golden");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const SKIP = new Set([".agent-workflow", ".git", "node_modules"]);
const MAX_PROJECT_FILE_BYTES = 256 * 1024;
/** Stands for the run's working directory in recorded outputs; the replay executor puts the replay's cwd back. */
export const CWD_PLACEHOLDER = "{{AW_REPLAY_CWD}}";

/** Recorded text with the run's cwd (as written, its realpath, macOS /private form) replaced by the placeholder. */
function relocate(text, cwd) {
	const forms = new Set([cwd]);
	try {
		forms.add(realpathSync(cwd));
	} catch {}
	for (const form of [...forms]) {
		if (form.startsWith("/private/")) forms.add(form.slice("/private".length));
		else forms.add(`/private${form}`);
	}
	let out = text;
	for (const form of [...forms].sort((a, b) => b.length - a.length))
		out = out.split(form).join(CWD_PLACEHOLDER);
	return out;
}

function projectFiles(root, dir = root, out = {}) {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const path = join(dir, name);
		const info = statSync(path);
		if (info.isDirectory()) projectFiles(root, path, out);
		else if (info.isFile() && info.size <= MAX_PROJECT_FILE_BYTES)
			out[relative(root, path)] = readFileSync(path, "utf8");
	}
	return out;
}

/** Raw outputs of a task directory in attempt order: raw.invalid-attempt-1.md, …, then raw.md. */
function attemptsOf(taskDir) {
	const invalid = readdirSync(taskDir)
		.map((name) => /^raw\.invalid-attempt-(\d+)\.md$/.exec(name))
		.filter(Boolean)
		.sort((a, b) => Number(a[1]) - Number(b[1]))
		.map((match) => readFileSync(join(taskDir, match[0]), "utf8"));
	const final = existsSync(join(taskDir, "raw.md"))
		? [readFileSync(join(taskDir, "raw.md"), "utf8")]
		: [];
	return [...invalid, ...final];
}

function readsOf(taskDir) {
	const path = join(taskDir, "read-ledger.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.map(({ source, artifact, path, maxChars, maxItems }) => ({
			source,
			artifact,
			...(path === undefined ? {} : { path }),
			...(maxChars === undefined ? {} : { maxChars }),
			...(maxItems === undefined ? {} : { maxItems }),
		}));
}

/** Pages a support control names by body hash ({url, bodySha256, …}) whose body the run kept. */
function pagesOf(runDir, controls) {
	const pages = new Map();
	const walk = (value) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			// A web quote result: {url, page: {finalUrl, status, contentType, bodySha256}}.
			const page = value.page;
			if (
				typeof value.url === "string" &&
				typeof page?.bodySha256 === "string" &&
				/^[0-9a-f]{64}$/.test(page.bodySha256)
			) {
				const body = join(runDir, "evidence", "pages", page.bodySha256);
				if (existsSync(body) && !pages.has(value.url))
					pages.set(value.url, {
						url: value.url,
						finalUrl: page.finalUrl ?? value.url,
						status: page.status ?? 200,
						contentType: page.contentType ?? "text/html",
						body: readFileSync(body).toString("base64"),
					});
			}
			Object.values(value).forEach(walk);
		}
	};
	controls.forEach(walk);
	return [...pages.values()];
}

/** The bundled spec a recorded run used, by its workflow name. */
function bundledSpecOf(name) {
	const bundle = name.startsWith("deep-research") ? "deep-research" : name;
	const dir = join(REPO, "workflows", bundle);
	const file = readdirSync(dir)
		.filter((entry) => entry === "spec.json" || entry.endsWith(".spec.json"))
		.find((entry) => readJson(join(dir, entry)).name === name);
	if (!file) throw new Error(`no bundled spec named ${name}`);
	return relative(REPO, join(dir, file));
}

export function captureRegressionFixture(runDir, name) {
	const run = readJson(join(runDir, "run.json"));
	const compiled = readJson(join(runDir, "compiled.json"));
	const tasks = {};
	const controls = [];
	for (const task of run.tasks) {
		const dir = join(runDir, "tasks", task.taskId);
		if (!existsSync(dir)) continue;
		if (existsSync(join(dir, "control.json")))
			controls.push(readJson(join(dir, "control.json")));
		const attempts = attemptsOf(dir).map((text) => relocate(text, run.cwd));
		if (attempts.length === 0) continue;
		tasks[task.specId] = { attempts, reads: readsOf(dir) };
	}
	const fixture = {
		schema: "agent-workflow-regression-fixture-v1",
		name,
		source: {
			runId: run.runId,
			status: run.status,
			createdAt: run.createdAt,
			engine: run.codeRevisions?.engine ?? null,
			executor: run.executor?.id ?? null,
		},
		workflow: run.name,
		spec: bundledSpecOf(run.name),
		task: compiled.task,
		profile: run.executionProfile?.name ?? null,
		files: projectFiles(run.cwd),
		tasks,
		pages: pagesOf(runDir, controls),
	};
	mkdirSync(REGRESSION_FIXTURES, { recursive: true });
	const path = join(REGRESSION_FIXTURES, `${name}.json.gz`);
	writeFileSync(path, gzipSync(JSON.stringify(fixture), { level: 9 }));
	return {
		path,
		tasks: Object.keys(tasks).length,
		pages: fixture.pages.length,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [flag, runDir, name] = process.argv.slice(2);
	if (flag !== "--capture" || !runDir || !name) {
		console.error(
			"usage: node test/helpers/regression-fixtures.mjs --capture <run dir> <name>",
		);
		process.exit(2);
	}
	const result = captureRegressionFixture(resolve(runDir), name);
	console.log(
		`${result.path}: ${result.tasks} model tasks, ${result.pages} pages, ${(statSync(result.path).size / 1024).toFixed(0)} KB`,
	);
}
