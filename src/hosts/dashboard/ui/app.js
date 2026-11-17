// WP43: the server projection is the only source of run state. Output is always text.
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
function element(tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value === true ? "" : String(value));
	}
	append(node, children);
	return node;
}
function append(node, children) {
	for (const child of children.flat(Infinity)) {
		if (child !== null && child !== undefined && child !== false)
			node.append(
				child instanceof Node ? child : document.createTextNode(String(child)),
			);
	}
	return node;
}
function svg(tag, attrs = {}, ...children) {
	const node = document.createElementNS(NS, tag);
	for (const [key, value] of Object.entries(attrs))
		node.setAttribute(key, String(value));
	return append(node, children);
}
const button = (text, action, attrs = {}) =>
	element("button", { type: "button", onclick: action, ...attrs }, text);
const labels = {
	completed: "Completed",
	running: "Running",
	pending: "Waiting",
	blocked: "Blocked",
	failed: "Failed",
	interrupted: "Stopped",
	skipped: "Skipped",
	retry: "Waiting to retry",
};
const iconPaths = {
	completed: "M3.5 8.5l3 3 6-7",
	failed: "M4 4l8 8M12 4l-8 8",
	blocked: "M8 3v6M8 12h.01",
	attention: "M4 14V2l8 1-2 3 2 3-8-1",
	retry: "M13 6a6 6 0 1 0 1 3M8 5v3.2l2 1.2M11 2l3 1-1 3",
	interrupted: "M5.5 5.5h5v5h-5z",
	skipped: "M4 12l8-8",
	td: "M5 2.5h6v3H5zM5 10.5h6v3H5zM8 5.5v5",
	lr: "M1.5 5h4v6h-4zM10.5 5h4v6h-4zM5.5 8h5",
	fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
	sidebar: "M2.5 3.5h11v9h-11zM6.5 3.5v9",
	agent: "M8 1.8l1.6 4.6 4.6 1.6-4.6 1.6L8 14.2 6.4 9.6 1.8 8l4.6-1.6z",
	code: "M5.5 4L1.8 8l3.7 4M10.5 4l3.7 4-3.7 4",
	timeline: "M2 4h6M5 8h8M3.5 12h5",
};
function markIcon(status, x = 0, y = 0, size = 16) {
	const icon = svg("svg", {
		x,
		y,
		width: size,
		height: size,
		viewBox: "0 0 16 16",
		class: `status-icon ${status}`,
		"aria-hidden": "true",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": 1.5,
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
	});
	if (status === "running")
		icon.append(
			svg("circle", {
				cx: 8,
				cy: 8,
				r: 3.5,
				fill: "currentColor",
				stroke: "none",
			}),
		);
	else {
		if (
			["pending", "skipped", "interrupted"].includes(status) ||
			!iconPaths[status]
		)
			icon.append(svg("circle", { cx: 8, cy: 8, r: 6.25 }));
		if (iconPaths[status]) icon.append(svg("path", { d: iconPaths[status] }));
	}
	return icon;
}
/** "✦" for an agent's work, "</>" for a step the engine runs itself (not a status mark). */
function kindIcon(kind, x = 0, y = 0, size = 14) {
	const icon = markIcon(kind, x, y, size);
	icon.setAttribute("class", `kind-icon ${kind}`);
	return icon;
}
const glyph = (status) =>
	element(
		"span",
		{ class: `glyph ${status}`, "aria-hidden": "true" },
		markIcon(status),
	);
function logo() {
	// Colours come from the theme (app.css .logo rules); the attributes are the dark fallback.
	return svg(
		"svg",
		{
			class: "logo",
			width: 20,
			height: 20,
			viewBox: "0 0 20 20",
			"aria-hidden": "true",
		},
		svg("rect", {
			class: "logo-tile",
			x: 1,
			y: 1,
			width: 18,
			height: 18,
			rx: 5,
			fill: "#eeeff2",
		}),
		svg("path", {
			class: "logo-ink",
			d: "M6.5 6.5l7 3.5-7 3.5",
			fill: "none",
			stroke: "#0b0c0f",
			"stroke-width": 1.4,
		}),
		svg("circle", {
			class: "logo-ink",
			cx: 6.5,
			cy: 6.5,
			r: 2,
			fill: "#0b0c0f",
		}),
		svg("circle", {
			class: "logo-ink",
			cx: 6.5,
			cy: 13.5,
			r: 2,
			fill: "#0b0c0f",
		}),
		svg("circle", {
			class: "logo-live",
			cx: 13.5,
			cy: 10,
			r: 2,
			fill: "#6fbf8e",
		}),
	);
}

/**
 * Theme (2026-11-01, owner choice): follow the system by default; the top-bar button pins Light or
 * Dark (kept in this browser) and cycles Auto → Light → Dark → Auto. CSS does the rest
 * (`color-scheme` + `light-dark()`), so an unpinned page needs no script to match the system.
 */
const THEMES = ["auto", "light", "dark"];
const THEME_KEY = "agent-workflow:theme";
function themeChoice() {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return THEMES.includes(value) ? value : "auto";
	} catch {
		return "auto";
	}
}
function applyTheme(choice) {
	if (choice === "auto") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
}
function cycleTheme() {
	const next = THEMES[(THEMES.indexOf(themeChoice()) + 1) % THEMES.length];
	try {
		if (next === "auto") localStorage.removeItem(THEME_KEY);
		else localStorage.setItem(THEME_KEY, next);
	} catch {
		// Storage can be unavailable (private mode); the choice then lasts for this page only.
	}
	applyTheme(next);
	themeOverride = next;
	renderTop();
	$("theme-button")?.focus({ preventScroll: true });
}
let themeOverride = null;
applyTheme(themeChoice());
/**
 * The runs rail (owner, 2026-11-03): it folds away with the top bar's sidebar button, kept in this
 * browser. Below 1440 px it steps aside while the inspector is open (the button brings it back for
 * that inspection); on a phone it is a drawer over the page, closed until asked for.
 */
const RAIL_KEY = "agent-workflow:rail";
const phone = matchMedia("(max-width: 800px)"),
	roomy = matchMedia("(min-width: 1440px)");
let railFolded = (() => {
	try {
		return localStorage.getItem(RAIL_KEY) === "folded";
	} catch {
		return false;
	}
})();
let railOpen = false, // phone drawer, never kept
	railForced = false; // shown beside the inspector although the screen is narrow
const inspecting = () => $("body").classList.contains("inspecting");
function railShown() {
	if (phone.matches) return railOpen;
	return !railFolded && (roomy.matches || !inspecting() || railForced);
}
function applyRail() {
	if (!inspecting()) railForced = false;
	const shown = railShown();
	$("body").classList.toggle("rail-folded", !shown && !phone.matches);
	$("body").classList.toggle("rail-open", shown && phone.matches);
	// Folded, the rail slides away (CSS) and is inert; it keeps its place in the page.
	$("rail").inert = !shown;
	const control = $("top").querySelector(".rail-button");
	if (control) {
		control.setAttribute("aria-expanded", String(shown));
		control.setAttribute("aria-label", shown ? "Hide runs" : "Show runs");
		control.title = shown ? "Hide runs" : "Show runs";
	}
}
function toggleRail(open = !railShown()) {
	if (phone.matches) railOpen = open;
	else if (open) {
		railFolded = false;
		railForced = inspecting();
	} else if (inspecting() && !roomy.matches && !railForced) railFolded = true;
	else if (inspecting() && !roomy.matches) railForced = false;
	else railFolded = true;
	try {
		if (railFolded) localStorage.setItem(RAIL_KEY, "folded");
		else localStorage.removeItem(RAIL_KEY);
	} catch {}
	applyRail();
}
for (const query of [phone, roomy]) query.addEventListener("change", applyRail);
$("rail-scrim").addEventListener("click", () => toggleRail(false));
function railButton() {
	return button(markIcon("sidebar"), () => toggleRail(), {
		class: "rail-button",
		"aria-controls": "rail",
	});
}
function themeButton() {
	const choice = themeOverride ?? themeChoice();
	const name = { auto: "Auto", light: "Light", dark: "Dark" }[choice];
	const next = { auto: "Light", light: "Dark", dark: "Auto" }[choice];
	return button(name, cycleTheme, {
		class: "theme-button",
		id: "theme-button",
		"data-theme-choice": choice,
		"aria-label": `Theme: ${name}. Switch to ${next}`,
		title: `Theme: ${name} (${choice === "auto" ? "follows the system" : "pinned"}). Click for ${next}.`,
	});
}
const date = (value) => Date.parse(value) || 0;
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
function syncClock(value) {
	if (date(value)) clockOffset = date(value) - Date.now();
}
function duration(ms) {
	if (!Number.isFinite(ms)) return "n/a";
	if (ms >= 0 && ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return minutes < 60
		? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
		: `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
function countdown(value, time = now()) {
	const seconds = Math.max(0, Math.ceil((date(value) - time) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function ago(value, time = now()) {
	const minutes = Math.max(0, Math.floor((time - date(value)) / 60000));
	return minutes < 1
		? "just now"
		: minutes < 60
			? `${minutes}m ago`
			: minutes < 1440
				? `${Math.floor(minutes / 60)}h ago`
				: `${Math.floor(minutes / 1440)}d ago`;
}
const liveRun = (run) => ["running", "blocked"].includes(run.status);
const elapsed = (run) =>
	duration((liveRun(run) ? now() : date(run.updatedAt)) - date(run.createdAt));
const retryDetails = new Set([
	"retry_backoff",
	"retry_model_failure",
	"launchRetry",
	"launch_retry",
]);
export function taskState(task) {
	return !["completed", "failed", "interrupted", "skipped"].includes(
		task.status,
	) &&
		(retryDetails.has(task.statusDetail) ||
			(task.retry && task.status === "pending"))
		? "retry"
		: task.status;
}
// A verdict-gated "failed" run finished its work: Resume would relaunch nothing useful.
const needsResume = (run) =>
	!(run.status === "failed" && run.verdictGate) &&
	(["failed", "interrupted"].includes(run.status) ||
		run.tasks?.some((t) => t.statusDetail === "executor_needs_decision"));
// Human wording from F v9-O. Never display an unknown engine status/detail as prose.
export function statusSentence(run, time = now(), stopping = false) {
	const tasks = (run.tasks || []).filter((t) => !t.placeholder);
	const retries = tasks.filter((t) => taskState(t) === "retry");
	const failed = tasks.find((t) => t.status === "failed");
	const reviewing = tasks.some(
		(t) =>
			t.stageId === "reviewers" &&
			["running", "retry", "blocked"].includes(taskState(t)),
	);
	if (stopping) return "Stopping. Waiting for the supervisor to confirm.";
	if (run.status === "interrupted") {
		// The engine interrupted it itself: the process running it ended (host closed), not a user stop.
		if (
			run.statusDetail === "driver_lost" ||
			tasks.some((t) => t.statusDetail === "driver_lost")
		)
			return "Stopped: the process running it ended (its host was closed). Completed work is kept. Resume to continue.";
		return "Stopped by you. Completed work is kept. Resume when ready.";
	}
	if (
		tasks.some((t) => t.statusDetail === "executor_needs_decision") ||
		run.needsYou?.some((n) => n.kind === "decision")
	)
		return `${reviewing ? "Reviewing" : "Work"} is paused. The executor couldn't confirm whether one task ran, so you need to decide.`;
	if (run.status === "failed" && run.verdictGate)
		return `Finished ${ago(run.updatedAt, time)} with verdict ${run.verdict ? verdictWord(run.verdict) : "not passed"}. The final gate did not pass; the report explains why.${run.reportAvailable ? " Report is ready." : ""}`;
	if (run.status === "failed")
		return failed
			? `Stopped at ${failed.stageId}. ${/contract/.test(failed.statusDetail || "") ? "Output didn't match the contract." : "A task failed."} Inspect and resume when ready.`
			: "A task failed. Inspect and resume when ready.";
	if (run.status === "completed")
		return `Finished ${ago(run.updatedAt, time)}.${run.reportAvailable ? " Report is ready." : ""}`;
	if (run.status === "blocked")
		return "Work is paused. Review the run details before continuing.";
	// `live: false` on a run that says running: the process that drove it is gone (30 s grace for a
	// launch that has not taken its lease yet). Nothing progresses until it is driven or stopped.
	if (
		run.status === "running" &&
		run.live === false &&
		time - date(run.createdAt) > 30_000
	)
		return "Stalled. No process is driving this run and nothing is progressing. Stop it, then resume to continue.";
	let text = reviewing
		? "Reviewing is under way."
		: run.status === "running"
			? "Work is under way."
			: "Waiting to start.";
	if (run.taskSummary?.failed)
		text += ` ${run.taskSummary.failed} task${run.taskSummary.failed === 1 ? "" : "s"} failed; other work continues.`;
	if (retries.length) {
		const task = [...retries].sort(
			(a, b) => date(a.retry?.nextRetryAt) - date(b.retry?.nextRetryAt),
		)[0];
		const retry = task.retry;
		const rate = /429|rate.limit/i.test(retry?.reason || "");
		const kind = rate ? "rate-limit retry" : "automatic retry";
		if (retry?.nextRetryAt && retry.attempt) {
			const attempt = `${retry.attempt}${retry.maxAttempts ? ` of ${retry.maxAttempts}` : ""}`;
			text +=
				retries.length === 1
					? ` One ${reviewing ? "reviewer" : "task"} is waiting for ${rate ? "a" : "an"} ${kind} (${attempt}, ${countdown(retry.nextRetryAt, time)}).`
					: ` ${retries.length} ${reviewing ? "reviewers" : "tasks"} are waiting to retry. The next ${kind} is in ${countdown(retry.nextRetryAt, time)} (attempt ${attempt}).`;
		} else text += " A task is waiting for an automatic retry.";
	}
	return (
		text +
		(run.needsYou?.length
			? " Your attention is needed."
			: failed
				? " No decision is requested."
				: " Nothing needs you.")
	);
}
function taskLine(task) {
	const state = taskState(task);
	if (state === "retry")
		return task.retry
			? `Waiting to retry, attempt ${task.retry.attempt}${task.retry.maxAttempts ? ` of ${task.retry.maxAttempts}` : ""}${task.retry.nextRetryAt ? `, next in ${countdown(task.retry.nextRetryAt)}` : ""}`
			: "Waiting for an automatic retry";
	if (state === "running")
		return `Running${task.startedAt ? `, ${duration(now() - date(task.startedAt))}` : ""}`;
	return `${state === "completed" ? "Done" : labels[state] || "Waiting"}${task.startedAt && task.completedAt ? `, ${duration(task.elapsedMs ?? date(task.completedAt) - date(task.startedAt))}` : ""}`;
}
const cost = (usage) =>
	usage?.costUsd == null ? "Not collected" : formatUsd(usage.costUsd);
function readState() {
	const params = new URLSearchParams(location.search);
	const choice = (key, values) =>
		values.includes(params.get(key)) ? params.get(key) : null;
	return {
		project: params.get("project"),
		run: params.get("run"),
		task: params.get("task"),
		stage: params.get("stage"),
		tab: choice("tab", ["result", "output", "stderr", "events"]),
		view: choice("view", [
			// "runs" opens the latest run (the nav's Runs item); the overview has no view of its own.
			"runs",
			"history",
			"report",
			"details",
			"workflows",
			"profiles",
			// "maintenance" (until 2026-11-13) opens the overview, where its parts now live.
			"executors",
		]),
		dialog: choice("dialog", ["stop", "resume"]),
		layout: choice("layout", ["td", "lr", "timeline"]) || "td",
		// The workflow page opened from the Workflows list (2026-11-11).
		workflow: params.get("workflow"),
		profile: params.get("profile"),
		createProfile: choice("createProfile", ["1"]),
	};
}
let state = readState();
let projects = [];
let session,
	runs = [],
	run = null,
	graphModel = null,
	graphControl = null;
const runLandingSeen = new Set();
let workflowTarget = null;
let runRevision = 0;
let loadGeneration = 0,
	selectionController,
	eventSource,
	reconnectTimer;
let backoff = 1000,
	lastEvent = 0,
	connection = "Reconnecting",
	busy = false;
let logController,
	logGeneration = 0,
	logKey = "",
	logData = null,
	logError = "",
	logLoading = false;
// 2026-11-03: a finished task's result (digest, analysis, refs, control) for the Result tab.
let resultController,
	resultGeneration = 0,
	resultKey = "",
	resultData = null,
	resultError = "",
	resultLoading = false;
let reportGeneration = 0,
	modalKey = "",
	returnFocus = null,
	noticeTimer;
const stoppingRuns = new Set();
const readonly = () => session?.mode === "read-only";
function urlState(replace = false) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(state))
		if (
			value &&
			!(
				key === "layout" &&
				value === "td" &&
				!new URLSearchParams(location.search).has("layout")
			)
		)
			params.set(key, value);
	history[replace ? "replaceState" : "pushState"](
		settingsHistoryState(replace ? history.state : null, replace),
		"",
		`${location.pathname}${params.size ? `?${params}` : ""}`,
	);
	syncTitle();
}
/** 2026-11-12 (review, P3-8): each history entry reads differently ("Report · deep-review · my-service"). */
function syncTitle() {
	const project = projects.find((entry) => entry.id === state.project)?.name;
	const name = state.run
		? (run?.runId === state.run ? run : runs.find((r) => r.runId === state.run))
				?.name
		: null;
	const page = managementView()
		? state.view.charAt(0).toUpperCase() + state.view.slice(1)
		: state.run
			? state.view === "report" && name
				? "Report"
				: null
			: state.project
				? "Overview"
				: null;
	document.title =
		[
			page,
			state.view === "profiles"
				? state.createProfile
					? "New profile"
					: state.profile
				: state.run
					? name
					: null,
			project,
		]
			.filter(Boolean)
			.join(" | ") || "agent-workflow";
}
async function api(path, options = {}) {
	if (path.startsWith("/api/runs"))
		path = `/api/projects/${encodeURIComponent(state.project)}/${path.slice(5)}`;
	const response = await fetch(path, {
		credentials: "same-origin",
		...options,
		signal: options.signal || AbortSignal.timeout(20000),
	});
	const data = await response.json();
	if (!response.ok)
		throw Object.assign(
			new Error(data.error || `Request failed (${response.status})`),
			{ status: response.status, data },
		);
	return data;
}
function notice(text) {
	clearTimeout(noticeTimer);
	$("notice").textContent = text;
	$("notice").hidden = false;
	noticeTimer = setTimeout(() => {
		$("notice").hidden = true;
	}, 12000);
}
async function copy(text) {
	try {
		await navigator.clipboard.writeText(text);
		notice("Copied");
	} catch {
		notice("Copy was unavailable. Select the text and copy it manually.");
	}
}
function go(patch, replace = false) {
	const wasReport = state.view === "report";
	const switching = patch.run && patch.run !== state.run;
	if (switching)
		state = {
			...state,
			task: null,
			stage: null,
			tab: null,
			view: null,
			dialog: null,
			workflow: null,
			profile: null,
			createProfile: null,
		};
	if (Object.hasOwn(patch, "task")) state.stage = null;
	if (Object.hasOwn(patch, "stage")) state.task = null;
	if (patch.task || patch.stage) state.view = null;
	state = { ...state, ...patch };
	urlState(replace);
	if (railOpen) toggleRail(false);
	if (switching) loadRun();
	// The report is a page: entering or leaving it redraws the whole centre.
	else if (run && wasReport !== (state.view === "report")) renderRun();
	else {
		renderSelection();
		renderModal();
	}
}
function renderTop() {
	const focusedLabel = $("top").contains(document.activeElement)
		? document.activeElement.getAttribute("aria-label")
		: null;
	const needs = visibleNeeds().length;
	$("top").replaceChildren();
	append($("top"), [
		railButton(),
		element(
			"span",
			{ class: "brand row" },
			logo(),
			element("span", { class: "brand-name" }, "agent-workflow"),
		),
		element("span", { class: "muted", "aria-hidden": "true" }, "/"),
		element(
			"span",
			{ class: "project", id: "project" },
			projects.find((project) => project.id === state.project)?.name ||
				"All projects",
		),
		button(
			[
				element("span", { class: "search-icon", "aria-hidden": "true" }, "⌕"),
				element("span", { class: "search-label" }, "Jump to run, stage…"),
				element("kbd", {}, "⌘K"),
			],
			openPalette,
			{ class: "search", "aria-label": "Jump to run or stage" },
		),
		element("span", { class: "grow" }),
		button(
			// Amber only when something waits for you; "Needs you 0" stays neutral.
			[needs ? glyph("blocked") : null, `Needs you  ${needs}`],
			() => {
				// 2026-11-12 (review, P2-2): the overview shows the needs itself; the rail has none there.
				if (homeShown()) {
					$("home-needs")?.querySelector("button, a")?.focus();
					return;
				}
				if (!railShown()) toggleRail(true);
				$("rail").querySelector(".need")?.focus();
			},
			{ class: `needs-button${needs ? "" : " none"}` },
		),
		readonly()
			? element("span", { class: "badge", id: "readonly-badge" }, "Read-only")
			: null,
		themeButton(),
		managementView()
			? null
			: element("span", {
					id: "connection",
					class: "connection",
					role: "status",
				}),
	]);
	applyRail();
	updateConnection();
	syncTitle();
	if (focusedLabel)
		$("top")
			.querySelector(`[aria-label="${CSS.escape(focusedLabel)}"]`)
			?.focus({ preventScroll: true });
}
function updateConnection() {
	const el = $("connection");
	if (!el) return;
	const stale = lastEvent && Date.now() - lastEvent > 30000;
	el.textContent =
		connection === "Signed out"
			? "Signed out: use the printed URL"
			: stale
				? `Stale (updated ${Math.floor((Date.now() - lastEvent) / 1000)}s ago)`
				: connection === "Live"
					? "• Live"
					: "Reconnecting";
	el.classList.toggle("live", !stale && connection === "Live");
}
/**
 * True when the server answers but no longer accepts this tab's session (auth mode: restart → new
 * token). When it still answers, adopt its current session (a restarted open-mode server has a new
 * CSRF secret; mutations would otherwise be refused).
 */
async function sessionLost() {
	try {
		const response = await fetch("/api/session", {
			credentials: "same-origin",
		});
		if (response.ok) session = await response.json();
		return response.status === 401;
	} catch {
		return false;
	}
}
/** A workflow's verdict token (`BLOCKED`, `needs_changes`) in sentence case. */
function verdictWord(value) {
	const text = String(value || "")
		.replace(/[_-]+/g, " ")
		.trim();
	return /[a-z]/.test(text)
		? text
		: text.charAt(0) + text.slice(1).toLowerCase();
}
/**
 * The compact rail (2026-11-11, owner): a short word only when there is something to know, with
 * its tone — a clean finish says nothing (its check mark does), a verdict or stop says it once.
 */
function railStatus(summary) {
	if (summary.status === "failed" && !summary.verdictGate)
		return ["err", "Failed"]; // the reason is under "Needs you", above
	if (summary.status === "blocked" || needsAttention(summary))
		return ["warn", "Needs you"];
	if (summary.status === "completed" || summary.status === "failed") {
		const outcome = finishedOutcome(summary);
		if (outcome.caveats) return ["warn", "With caveats"];
		if (!outcome.clean) return ["warn", outcome.word];
		const verdict = verdictWord(summary.verdict);
		return ["", verdict.charAt(0).toUpperCase() + verdict.slice(1)];
	}
	if (summary.status === "interrupted") return ["", "Stopped"];
	if (summary.status === "running") return ["", ""];
	return ["", "Waiting to start"];
}
function railCount(counts, agents) {
	const noun = agents ? "agents" : "tasks";
	return counts.completed === counts.total
		? `${counts.total} ${noun}`
		: `${counts.completed} of ${counts.total} ${noun}`;
}
/**
 * 2026-11-12 (owner, review P1-5): one duration language. A live run shows the clock running; a run
 * that has ended shows its active time (when agents and steps worked), as the overview and the
 * report do, so the same run never has two numbers.
 */
const runElapsed = (run) =>
	!liveRun(run) && run.activeMs != null ? duration(run.activeMs) : elapsed(run);
/** "6m" for "6m 00s", "1h" for "1h 00m": the rail rounds where nothing is lost. */
const railElapsed = (run) => runElapsed(run).replace(/ 00[sm]$/, "");
function progress(completed, total, status = "") {
	return element("progress", {
		class: status ? `p-${status}` : null,
		max: Math.max(1, total || 0),
		value: completed || 0,
		"aria-label": `${completed || 0} of ${total || 0} tasks complete`,
	});
}
/**
 * 2026-11-01: a failure you have looked at can be dismissed from "Needs you" (this browser only).
 * The key includes when it happened, so a new failure of the same run shows again. Approvals and
 * decisions still block their run and cannot be dismissed.
 */
const dismissKey = () =>
	`agent-workflow:dismissed-needs:${session?.project?.path ?? session?.project?.name ?? ""}`;
const needKey = (need, runId) =>
	[runId, need.kind, need.requestId ?? need.taskId ?? "", need.since].join("|");
function dismissedNeeds() {
	try {
		const value = JSON.parse(localStorage.getItem(dismissKey()) || "[]");
		return new Set(
			Array.isArray(value)
				? value.filter((key) => typeof key === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}
function saveDismissedNeeds(keys) {
	try {
		localStorage.setItem(dismissKey(), JSON.stringify([...keys].slice(-200)));
	} catch {
		// Storage unavailable: the dismissal lasts until the next repaint only.
	}
}
function allNeeds() {
	return runs.flatMap((r) =>
		(r.needsYou || []).map((n) => ({ ...n, run: r, key: needKey(n, r.runId) })),
	);
}
/*
 * 2026-11-12 (owner: one dismissal for every host): a failed run's "Needs you" item is dismissed
 * through the project's notice acknowledgements, the ones Pi, Claude Code and Codex reminders use,
 * so dismissing it here quiets it there too. Read-only dashboards, runs that are
 * not a notice, and a refused write fall back to this browser's own list (the previous behavior).
 */
let noticeState = { acknowledged: new Set(), states: new Map() };
async function refreshNotices() {
	if (!state.project || state.project === "all") return;
	try {
		const listed = (await api(projectRoute("notices"))).data;
		noticeState = {
			acknowledged: new Set(
				(listed.acknowledgements || [])
					.filter((entry) => entry.active)
					.map((entry) => entry.runId),
			),
			states: new Map(
				(listed.notices || []).map((entry) => [entry.runId, entry.sha256]),
			),
		};
	} catch {
		// Keep the last known notices: a failed read never shows a dismissed item again.
	}
}
const DISMISS_TITLE =
	"Dismiss everywhere: the dashboard and the Pi, Claude Code and Codex reminders (it shows again if the run changes)";
/** A decision blocks its run and stays; a failure or an unexpected stop can be dismissed. */
const dismissible = (need) => need.kind !== "decision";
/** A need other than an unexpected stop: the run reads "Needs you", not "Stopped". */
const needsAttention = (run) =>
	Boolean(run.needsYou?.some((need) => need.kind !== "stopped"));
const serverDismissed = (need) =>
	dismissible(need) && noticeState.acknowledged.has(need.run.runId);
function visibleNeeds() {
	const dismissed = dismissedNeeds();
	return allNeeds().filter(
		(need) =>
			!dismissible(need) ||
			(!dismissed.has(need.key) && !serverDismissed(need)),
	);
}
function setNeedDismissed(needs, dismissed) {
	// The rail changes at once; the shared acknowledgement is written after, and a refused write
	// falls back to this browser's list.
	const current = dismissedNeeds();
	const shared = [];
	for (const need of needs) {
		const runId = need.run.runId;
		const sha256 = noticeState.states.get(runId);
		if (dismissed) {
			if (!readonly() && sha256) {
				noticeState.acknowledged.add(runId);
				shared.push({ need, runId, sha256 });
			} else current.add(need.key);
		} else {
			current.delete(need.key);
			if (!readonly() && noticeState.acknowledged.has(runId)) {
				noticeState.acknowledged.delete(runId);
				shared.push({ need, runId });
			}
		}
	}
	saveDismissedNeeds(current);
	renderTop();
	renderRail();
	if (homeShown()) renderHome();
	if (!shared.length) return;
	Promise.all(
		shared.map(async ({ need, runId, sha256 }) => {
			try {
				await api(
					projectRoute(
						`notices/${encodeURIComponent(runId)}/${dismissed ? "acknowledge" : "clear"}`,
					),
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-AW-CSRF": session.csrf,
						},
						body: JSON.stringify(
							dismissed
								? { state: sha256, reason: "Dismissed in the dashboard" }
								: {},
						),
					},
				);
			} catch {
				if (!dismissed) return;
				const kept = dismissedNeeds();
				kept.add(need.key);
				saveDismissedNeeds(kept);
			}
		}),
	)
		.then(refreshNotices)
		.then(() => {
			renderTop();
			renderRail();
			if (homeShown()) renderHome();
		});
}

/**
 * One reason in one wording wherever a need shows (rail, overview): "Failed at candidate-findings".
 * A decision keeps its own sentence ("Controller needs a decision"); a failure without a task is
 * "Run failed".
 */
function needReason(need) {
	if (need.kind !== "failed") return need.title;
	const space = need.title.lastIndexOf(" ");
	const word = need.title.slice(space + 1);
	return need.taskId
		? `${word.charAt(0).toUpperCase()}${word.slice(1)} at ${need.title.slice(0, space)}`
		: `Run ${word}`;
}
/**
 * A need in the rail (2026-11-12, owner pass 2): on the run's own row, or alone when the run is
 * not listed. "Inspect" opens the run with the failing task selected; the x dismisses.
 */
function railNeed(need, alone = false) {
	const dismiss = () => {
		const rail = $("rail");
		const needs = [...rail.querySelectorAll(".need-item")];
		const index = needs.findIndex((item) =>
			item.querySelector(`[data-need="${CSS.escape(need.key)}"]`),
		);
		setNeedDismissed([need], true);
		const left = [...$("rail").querySelectorAll(".need")];
		(
			left[Math.min(index, left.length - 1)] ??
			$("rail").querySelector(".need-restore") ??
			$("rail").querySelector(`[data-run="${CSS.escape(need.run.runId)}"]`)
		)?.focus({ preventScroll: true });
	};
	return element(
		"div",
		{
			class: `need-item${alone ? " alone" : ""}`,
			// The row around it opens the run; this is its own control.
			onclick: (event) => event.stopPropagation(),
		},
		button(
			[
				element(
					"span",
					{ class: "need-head" },
					element("span", { class: "need-label" }, "Needs you"),
					element("span", { class: "need-action" }, "Inspect"),
				),
				element(
					"b",
					{ class: "need-title", title: needReason(need) },
					needReason(need),
				),
				alone
					? element("small", {}, `${need.run.name} ${ago(need.since)}`)
					: null,
			],
			() => openNeed(need),
			{ class: "need", "aria-label": `Inspect: ${needReason(need)}` },
		),
		dismissible(need)
			? button("×", dismiss, {
					class: "need-dismiss",
					"data-need": need.key,
					"aria-label": `Dismiss: ${needReason(need)}`,
					title: DISMISS_TITLE,
				})
			: null,
	);
}
function renderRail() {
	const focusedProject = document.activeElement === $("project-switcher");
	const actionsOpen = $("rail").querySelector(".run-actions")?.open;
	const focusedAction = document.activeElement?.closest(".run-actions")
		? document.activeElement.tagName.toLowerCase()
		: null;
	const focusedRun = document.activeElement?.closest(".run-row")?.dataset.run;
	const rail = $("rail"),
		scroll = rail.scrollTop;
	const needs = visibleNeeds();
	const hidden = allNeeds().filter(
		(need) => !needs.some((shown) => shown.key === need.key),
	);
	rail.replaceChildren();
	const switcher = element(
		"select",
		{
			id: "project-switcher",
			"aria-label": "Project",
			onchange: (event) => selectProject(event.target.value),
		},
		element("option", { value: "all" }, "All projects"),
		projects.map((project) =>
			element("option", { value: project.id }, project.name),
		),
	);
	switcher.value = state.project || "all";
	rail.append(
		element(
			"div",
			{ class: "project-switcher" },
			element("label", { for: "project-switcher" }, "Project"),
			switcher,
		),
	);
	rail.append(
		element(
			"nav",
			{ class: "management-nav", "aria-label": "Dashboard views" },
			["Overview", "Workflows", "Run history"].map((title) => {
				const view = title === "Run history" ? "runs" : title.toLowerCase();
				const params = new URLSearchParams();
				if (state.project) params.set("project", state.project);
				// 2026-11-12 (owner): Overview is the project's landing page (no run, no view);
				// Runs opens the latest run, as the dashboard did before.
				if (view !== "overview") params.set("view", view);
				const current = managementView()
					? state.view === view
					: view === "overview"
						? !state.run && state.view !== "runs"
						: view === "runs" && (Boolean(state.run) || state.view === "runs");
				return element(
					"a",
					{ href: `/?${params}`, "aria-current": current ? "page" : null },
					title,
				);
			}),
		),
	);
	const footer = element(
		"footer",
		{ class: "rail-footer" },
		element("h2", { class: "rail-heading" }, "Shared settings"),
		element(
			"nav",
			{ class: "management-nav", "aria-label": "Shared settings" },
			["profiles", "executors"].map((view) =>
				element(
					"a",
					{
						href: managementHref(view),
						"aria-current": state.view === view ? "page" : null,
					},
					humanize(view),
				),
			),
		),
	);
	// 2026-11-12 (owner, review P2-2): the overview lists the needs and the runs itself, so the rail
	// keeps only the project switcher and the nav there; the groups return with a run or a report.
	if (managementView() || homeShown()) {
		rail.append(footer);
		rail.scrollTop = scroll;
		if (focusedProject) switcher.focus({ preventScroll: true });
		return;
	}
	// 2026-11-12 (owner, pass 2): one run is one row. A need sits on its own run's row (below); a
	// "Needs you" group stays only for a need whose run is not in the list.
	const listed = new Set(runs.map((summary) => summary.runId));
	const orphans = needs.filter((need) => !listed.has(need.run.runId));
	if (orphans.length) {
		rail.append(element("h2", { class: "rail-heading" }, "Needs you"));
		for (const need of orphans) rail.append(railNeed(need, true));
	}
	const actions = state.project
		? element(
				"details",
				{
					class: "run-actions",
					onkeydown: (event) => {
						if (event.key === "Escape" && actions.open) {
							event.preventDefault();
							event.stopPropagation();
							actions.open = false;
							actions.querySelector("summary").focus({ preventScroll: true });
						}
					},
				},
				element(
					"summary",
					{ "aria-label": "Run list actions", title: "Run list actions" },
					"⋯",
				),
				element(
					"a",
					{
						href: managementHref("history"),
						"data-testid": "manage-run-deletion",
					},
					"Delete run records…",
				),
			)
		: null;
	if (actions) actions.open = Boolean(actionsOpen);
	rail.append(
		element(
			"div",
			{ class: "rail-run-heading" },
			element(
				"h2",
				{ class: "rail-heading" },
				element("span", {}, "Runs"),
				runs.length
					? element("span", { class: "rail-count" }, runs.length)
					: null,
			),
			actions,
		),
	);
	if (hidden.length)
		rail.append(
			button(
				`Show ${hidden.length} dismissed`,
				() => {
					setNeedDismissed(hidden, false);
					$("rail").querySelector(".need")?.focus({ preventScroll: true });
				},
				{ class: "need-restore link" },
			),
		);
	if (!runs.length)
		rail.append(element("p", { class: "muted" }, "No runs yet"));
	// Today / Earlier headings (2026-11-11, owner chose the compact rail), only when both occur.
	const today = new Date(now()).toDateString();
	const isToday = (summary) =>
		new Date(date(summary.createdAt)).toDateString() === today;
	const grouped = runs.some(isToday) && !runs.every(isToday);
	let group = null;
	for (const summary of runs) {
		const counts = summary.agentSummary || summary.taskSummary;
		const display = summary.runId === run?.runId ? run : summary;
		const live = liveRun(display);
		const own = needs.filter((need) => need.run.runId === summary.runId);
		// The need says it ("Failed at candidate-findings"); the meta line does not say it twice.
		const [tone, word] = own.length ? ["", ""] : railStatus(display);
		if (grouped && group !== isToday(summary)) {
			group = isToday(summary);
			rail.append(
				element("div", { class: "rail-group" }, group ? "Today" : "Earlier"),
			);
		}
		const row = element(
			"div",
			{
				class: "run-row",
				role: "button",
				tabindex: "0",
				"data-run": summary.runId,
				"aria-current": String(summary.runId === state.run),
				onclick: () => go({ run: summary.runId }),
				onkeydown: (event) => {
					if (
						event.target === event.currentTarget &&
						["Enter", " "].includes(event.key)
					) {
						event.preventDefault();
						go({ run: summary.runId });
					}
				},
			},
			element(
				"div",
				{ class: "row" },
				glyph(
					display.status === "failed" && !display.verdictGate
						? "failed"
						: needsAttention(display) ||
								display.status === "blocked" ||
								(!liveRun(display) && shortfall(display))
							? "blocked"
							: summary.status,
				),
				element(
					"span",
					{ class: "grow truncate", title: summary.name },
					summary.name,
				),
				// When it started, and below, the task it was given: four "deep-review" rows read
				// apart (owner, 2026-11-03).
				element(
					"span",
					{
						class: "run-started muted",
						title: `Started ${new Date(date(summary.createdAt)).toLocaleString()}`,
					},
					ago(summary.createdAt),
				),
				// Report replaces "3h ago" where it is wanted (hover, selected, keyboard).
				summary.status === "completed" && summary.reportAvailable
					? element(
							"a",
							{
								class: "run-report",
								href: `?run=${encodeURIComponent(summary.runId)}&view=report`,
								onclick: (event) => {
									event.preventDefault();
									event.stopPropagation();
									go({ run: summary.runId, view: "report" });
								},
							},
							"Report →",
						)
					: null,
			),
			summary.taskPreview
				? element(
						"p",
						{ class: "run-task", title: summary.taskPreview },
						summary.taskPreview,
					)
				: null,
			own.map((need) => railNeed(need)),
			// One quiet line: what to know (a verdict, a stop, a failure), the time, the agents.
			element(
				"div",
				{ class: "run-meta" },
				...[
					word ? element("span", { class: `run-word ${tone}` }, word) : null,
					element(
						"span",
						{ class: "run-count" },
						railCount(counts, Boolean(summary.agentSummary)),
					),
					element(
						"span",
						{ class: "elapsed", "data-run-elapsed": summary.runId },
						railElapsed(summary),
					),
				].filter(Boolean),
			),
			// The bar only while it moves; a finished run's full bar says nothing.
			live ? progress(counts.completed, counts.total, summary.status) : null,
		);
		rail.append(row);
	}
	rail.append(footer);
	if (focusedAction)
		actions?.querySelector(focusedAction)?.focus({ preventScroll: true });
	rail.scrollTop = scroll;
	if (focusedProject) switcher.focus({ preventScroll: true });
	if (focusedRun)
		rail
			.querySelector(`[data-run="${CSS.escape(focusedRun)}"]`)
			?.focus({ preventScroll: true });
}
function actionButton(text, dialog, cls = "") {
	return button(text, () => go({ dialog }), {
		class: cls,
		"data-action": dialog,
		disabled:
			readonly() || busy || (dialog === "stop" && stoppingRuns.has(run.runId)),
		title: readonly() ? "Read-only mode" : null,
	});
}
function sentenceParts() {
	const text = statusSentence(run, now(), stoppingRuns.has(run.runId));
	const end = text.indexOf(". ");
	return end < 0
		? [text]
		: [element("strong", {}, text.slice(0, end + 1)), text.slice(end + 1)];
}
/** Motion tokens (ms), the same as app.css's --t-* and --ease-out: one family of movement. */
const MOTION = {
	fast: 150,
	base: 220,
	layout: 280,
	graph: 460,
	ease: "cubic-bezier(.22,.61,.36,1)",
};
const reducedMotion = () =>
	matchMedia("(prefers-reduced-motion: reduce)").matches;
matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
	"change",
	(event) => {
		if (event.matches)
			for (const animation of document.getAnimations()) animation.cancel();
	},
);
const humanize = (name) => {
	const text = name.replace(/[-_]+/g, " ");
	return text.charAt(0).toUpperCase() + text.slice(1);
};
const agentTasks = (run) =>
	run.tasks.filter(
		(t) => !t.placeholder && !["support", "dynamic", "loop"].includes(t.kind),
	);
/**
 * A finished run's result (2026-11-03, owner: NEEDS_WORK is what the report concludes about the
 * work, not how the run went). The run itself — header, rail glyph, graph — shows the process:
 * a completed run is "Finished" with a green check. The verdict is the result: the Result block
 * leads with it ("Needs work" with an amber "!", a clean verdict with a check) and the rail line
 * names it. A verdict that says the run itself fell short — a gate the workflow made its success
 * condition (the run ends failed), or a partial/incomplete review — stays in the header. A run without a verdict whose agents left caveats is
 * "Finished" with a "With caveats" tag.
 */
const CLEAN_VERDICT =
	/^(?:pass(?:ed)?|ok|success|complete(?:d)?|review[ _-]?complete|ready)$/i;
function finishedOutcome(run) {
	const word = (text) => {
		const plain = verdictWord(text);
		return plain.charAt(0).toUpperCase() + plain.slice(1);
	};
	if (run.verdict && !CLEAN_VERDICT.test(run.verdict))
		return { clean: false, word: word(run.verdict) };
	if (run.verdictGate) return { clean: false, word: "Gate not passed" };
	if (run.tasks?.some((t) => t.outcome && t.outcome.tone !== "ok"))
		return { clean: false, caveats: true, word: "Finished with caveats" };
	return { clean: true, word: "Finished" };
}
const PROCESS_VERDICT = /partial|incomplete/i;
/** The run fell short of its own work (not: its work found problems). */
const shortfall = (run) =>
	run.verdictGate
		? !finishedOutcome(run).clean
		: run.status === "completed" && PROCESS_VERDICT.test(run.verdict || "");
function heroState(run) {
	if (run.status === "failed" && !run.verdictGate) return ["failed", "Failed"];
	if (shortfall(run)) return ["attention", finishedOutcome(run).word];
	if (run.status === "completed") return ["completed", "Finished"];
	if (run.status === "blocked" || needsAttention(run))
		return ["blocked", "Needs you"];
	return [run.status, labels[run.status] || "Waiting"];
}
function heroSubline() {
	const tasks = agentTasks(run),
		done = tasks.filter((t) => t.status === "completed").length;
	const noun = tasks.length === 1 ? "agent" : "agents";
	return `${run.name}, ${runElapsed(run)}, ${liveRun(run) ? `${done} of ${tasks.length} ${noun} done` : `${tasks.length} ${noun}`}`;
}
const badgeStates = new Map();
function renderBadge(status) {
	const tasks = agentTasks(run),
		done = tasks.filter((t) => t.status === "completed").length;
	const finished = status === "completed",
		offset =
			97.4 * (1 - (finished ? 1 : tasks.length ? done / tasks.length : 0));
	const ring = svg("circle", {
		class: "hero-ring",
		cx: 17,
		cy: 17,
		r: 15.5,
		transform: "rotate(-90 17 17)",
		"stroke-dasharray": 97.4,
		"stroke-dashoffset": offset,
	});
	const badge = svg(
		"svg",
		{
			class: `hero-badge ${status}`,
			viewBox: "0 0 34 34",
			width: 34,
			height: 34,
			role: "img",
			"aria-label": finished
				? "Finished"
				: status === "attention"
					? "Finished; needs attention"
					: `${done} of ${tasks.length} agents done`,
		},
		svg("circle", { class: "hero-track", cx: 17, cy: 17, r: 15.5 }),
		ring,
	);
	if (finished) {
		const check = svg("path", {
			class: "hero-check",
			d: "M11 17.5 L15.2 21.5 L23 13",
			"stroke-dasharray": 17,
			"stroke-dashoffset": 0,
		});
		badge.append(check);
		if (!reducedMotion() && badgeStates.get(run.runId) !== "completed") {
			ring.animate([{ strokeDashoffset: 18 }, { strokeDashoffset: 0 }], {
				duration: 250,
			});
			check.animate([{ strokeDashoffset: 17 }, { strokeDashoffset: 0 }], {
				duration: 380,
				delay: 220,
				fill: "backwards",
				easing: "ease-out",
			});
		}
	} else
		badge.append(
			svg(
				"text",
				{ x: 17, y: 21, "text-anchor": "middle", class: "hero-number" },
				status === "failed"
					? "✕"
					: status === "blocked" || status === "attention"
						? "!"
						: done,
			),
		);
	badgeStates.set(run.runId, status);
	return badge;
}
function renderHeader() {
	const [status, title] = heroState(run);
	const actions = element("div", { class: "actions" });
	if (liveRun(run))
		actions.append(
			actionButton(stoppingRuns.has(run.runId) ? "Stopping…" : "Stop…", "stop"),
		);
	if (needsResume(run))
		actions.append(actionButton("Resume…", "resume", "primary"));
	if (run.reportAvailable && !liveRun(run))
		actions.append(
			button("Open report", () => go({ view: "report" }), { class: "primary" }),
		);
	actions.append(
		button(
			"Run details ›",
			() => go({ view: "details", task: null, stage: null }),
			{ "aria-label": "Run details" },
		),
	);
	const context = element("div", { class: "run-context" });
	context.append(
		workflowTarget?.target?.workflowKey
			? element(
					"a",
					{
						href: workflowHref(workflowTarget.target.workflowKey),
						"data-testid": "run-workflow-link",
					},
					"Current Workflow settings (future Runs only)",
				)
			: element(
					"p",
					{ class: "muted", "data-testid": "run-workflow-unavailable" },
					`Workflow unavailable: ${workflowTarget?.reason || "checking source"}.`,
				),
	);
	const finished = !liveRun(run) && !needsResume(run);
	context.append(
		element(
			"p",
			{ class: "muted", "data-testid": "run-action-reason" },
			finished
				? "Finished."
				: readonly()
					? "Read-only: Stop/Resume unavailable."
					: needsResume(run)
						? "Review stopped work before resuming."
						: "Run in progress.",
		),
		moreDetails(
			"Run action policy",
			element(
				"p",
				{},
				finished
					? "No Stop/Resume: terminal; business verdicts are results, not resumable failures."
					: readonly()
						? "Read-only: no Stop/Resume. Server checks remain authoritative."
						: "Recorded-status eligibility; server capability/ownership checks may refuse.",
			),
		),
	);
	// Only a run that finished its work has a result; a failed or stopped run keeps "Status", so an
	// earlier stage's summary never reads as the outcome of a run that did not get there.
	const result =
		!liveRun(run) &&
		(run.status === "completed" || run.verdictGate) &&
		(run.verdict || run.summary || run.tasks.some((t) => t.outcome));
	const summary = runSummaryText(run);
	return element(
		"section",
		{ class: "run-header", id: "run-header", "data-status": status },
		element(
			"div",
			{ class: "row title-row" },
			renderBadge(status),
			element(
				"div",
				{ class: "hero-copy grow" },
				element("h1", {}, title),
				element("p", { class: "hero-sub", id: "hero-sub" }, heroSubline()),
				blockedChip(run.blockedActions),
			),
			actions,
		),
		element(
			"div",
			{ class: "result" },
			element(
				"div",
				{ class: "result-label" },
				result ? "Result" : liveRun(run) ? "Now" : "Status",
				result && finishedOutcome(run).caveats
					? element("span", { class: "incomplete" }, "With caveats")
					: null,
			),
			result && run.verdict
				? element(
						"p",
						{
							class: `result-verdict ${CLEAN_VERDICT.test(run.verdict) ? "clean" : "attention"}`,
							title: run.verdict,
						},
						glyph(CLEAN_VERDICT.test(run.verdict) ? "completed" : "attention"),
						element(
							"strong",
							{},
							(() => {
								const word = verdictWord(run.verdict);
								return word.charAt(0).toUpperCase() + word.slice(1);
							})(),
						),
					)
				: null,
			summary && result
				? element("p", { class: "result-summary" }, summary)
				: null,
			element(
				"p",
				{ class: "sentence", id: "status-sentence" },
				sentenceParts(),
			),
		),
		context,
		element(
			"span",
			{ id: "task-count", class: "sr-only" },
			`${run.taskSummary.completed} / ${run.taskSummary.total}`,
		),
	);
}
// Stage grouping, transitive reduction and layered layout follow F v9-O.
/**
 * `hideCode` (2026-11-03, owner's pick of the mock-ups): code steps leave the graph unless the
 * switch shows them; one that failed, runs, waits on a person or is the selected stage (`keep`)
 * stays in place. Its neighbours connect straight across it, so the graph never breaks.
 * `stages` keeps every stage (the inspector and Jump to find hidden ones too).
 */
export function deriveGraph(
	projection,
	{ hideCode = false, keep = null } = {},
) {
	const stages = new Map(),
		specStage = new Map();
	for (const task of projection.tasks) {
		specStage.set(task.specId, task.stageId);
		if (!stages.has(task.stageId))
			stages.set(task.stageId, {
				id: task.stageId,
				kind: task.kind,
				tasks: [],
				items: [],
				deps: new Set(),
				kids: new Set(),
			});
		const stage = stages.get(task.stageId);
		stage.tasks.push(task);
		// Controllers and loop gates are navigable tasks, not generated agents. Keeping a
		// suspended controller first made an active dynamic stage incorrectly say "Waiting".
		if (!task.placeholder && !["dynamic", "loop"].includes(task.kind))
			stage.items.push(task);
	}
	const priority = [
		"failed",
		"blocked",
		"running",
		"retry",
		"interrupted",
		"pending",
		"completed",
		"skipped",
	];
	for (const stage of stages.values()) {
		for (const task of stage.tasks)
			for (const dep of task.dependsOn || []) {
				const id = specStage.get(dep) || dep.split(".")[0];
				if (id !== stage.id && stages.has(id)) stage.deps.add(id);
			}
		const visible = stage.tasks.filter((task) => !task.placeholder);
		const states = (visible.length ? visible : stage.tasks).map(taskState);
		stage.status = states.every((s) => ["completed", "skipped"].includes(s))
			? states.every((s) => s === "skipped")
				? "skipped"
				: "completed"
			: priority.find((s) => states.includes(s)) || "pending";
		stage.done = stage.items.filter((t) => t.status === "completed").length;
		for (const dep of stage.deps) stages.get(dep).kids.add(stage.id);
	}
	// A dotted prefix every stage shares (`impact-analysis.` in a 13-stage review) says nothing
	// on a card: cards show the part that differs; titles, labels and the inspector keep the
	// full name.
	const prefix =
		stages.size > 1
			? commonPrefix([...stages.values()].map((s) => s.name || s.id))
			: "";
	for (const stage of stages.values())
		stage.short = prefix
			? (stage.name || stage.id).slice(prefix.length + 1)
			: stage.name || stage.id;
	const hidden = (stage) =>
		hideCode &&
		stage.kind === "support" &&
		stage.id !== keep &&
		["completed", "skipped", "pending"].includes(stage.status);
	const across = (ids, key, seen = new Set()) => {
		const out = new Set();
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			const stage = stages.get(id);
			if (hidden(stage))
				for (const next of across(stage[key], key, seen)) out.add(next);
			else out.add(id);
		}
		return out;
	};
	const codeSteps = [...stages.values()].filter((s) => s.kind === "support");
	const shown = codeSteps.some(hidden) ? new Map() : stages;
	if (shown !== stages)
		for (const stage of stages.values())
			if (!hidden(stage))
				shown.set(stage.id, {
					...stage,
					deps: across(stage.deps, "deps"),
					kids: across(stage.kids, "kids"),
				});
	const edges = [];
	for (const stage of shown.values())
		for (const dep of stage.deps) {
			const seen = new Set([dep]),
				stack = [...shown.get(dep).kids].filter((id) => id !== stage.id);
			let implied = false;
			while (stack.length) {
				const next = stack.pop();
				if (next === stage.id) {
					implied = true;
					break;
				}
				if (seen.has(next)) continue;
				seen.add(next);
				stack.push(...shown.get(next).kids);
			}
			if (!implied) edges.push({ from: dep, to: stage.id });
		}
	const levels = new Map(),
		visiting = new Set();
	const level = (id) => {
		if (levels.has(id)) return levels.get(id);
		if (visiting.has(id)) return 0; // A malformed/cyclic projection cannot lock up the host UI.
		visiting.add(id);
		const value = Math.max(
			0,
			...[...shown.get(id).deps].map((dep) => level(dep) + 1),
		);
		visiting.delete(id);
		levels.set(id, value);
		return value;
	};
	for (const stage of shown.values()) level(stage.id);
	// Stages that share the same inputs and the same outputs are parallel siblings: one stacked
	// card with a row per stage (GitHub Actions stacks such jobs the same way), so a fan-out/join
	// is one card and one edge instead of n×m crossing lines. Foreach and ghost stages
	// keep their own card.
	const nodes = new Map(),
		groups = new Map(),
		owner = new Map(),
		buckets = new Map();
	for (const stage of shown.values()) {
		const key =
			stage.kind === "foreach" || stage.ghost
				? null
				: `${levels.get(stage.id)}|${[...stage.deps].sort().join(",")}|${[...stage.kids].sort().join(",")}`;
		if (key === null) continue;
		if (!buckets.has(key)) buckets.set(key, []);
		buckets.get(key).push(stage);
	}
	let groupIndex = 0;
	for (const members of buckets.values()) {
		if (members.length < 2) continue;
		const id = `__group_${groupIndex++}`;
		const prefix = commonPrefix(members.map((s) => s.short));
		const states = members.map((s) => s.status);
		groups.set(id, {
			id,
			kind: "group",
			name: prefix,
			members,
			tasks: members.flatMap((s) => s.tasks),
			items: [],
			status: states.every((s) => ["completed", "skipped"].includes(s))
				? "completed"
				: priority.find((s) => states.includes(s)) || "pending",
			done: states.filter((s) => s === "completed").length,
			deps: new Set(),
			kids: new Set(),
		});
		for (const stage of members) owner.set(stage.id, id);
	}
	for (const stage of shown.values())
		if (!owner.has(stage.id)) owner.set(stage.id, stage.id);
	// Cards in spec order. A stage that stands alone is its own card; its deps/kids are
	// translated to card ids (a neighbour may now live inside a stacked card). The stage object
	// itself stays untouched.
	for (const stage of shown.values()) {
		const id = owner.get(stage.id);
		if (nodes.has(id)) continue;
		nodes.set(
			id,
			id === stage.id
				? {
						...stage,
						deps: new Set([...stage.deps].map((dep) => owner.get(dep))),
						kids: new Set([...stage.kids].map((kid) => owner.get(kid))),
					}
				: groups.get(id),
		);
	}
	const nodeEdges = [],
		seenEdges = new Set();
	for (const edge of edges) {
		const from = owner.get(edge.from),
			to = owner.get(edge.to);
		if (from === to || seenEdges.has(`${from}>${to}`)) continue;
		seenEdges.add(`${from}>${to}`);
		nodeEdges.push({ from, to });
	}
	for (const node of nodes.values())
		if (node.kind === "group") {
			for (const id of node.members[0].deps) node.deps.add(owner.get(id));
			for (const id of node.members[0].kids) node.kids.add(owner.get(id));
		}
	const layers = [];
	for (const node of nodes.values()) {
		const n = levels.get(node.kind === "group" ? node.members[0].id : node.id);
		(layers[n] ||= []).push(node);
	}
	return {
		stages,
		nodes,
		owner,
		layers: orderLayers(layers.filter(Boolean)),
		edges: nodeEdges,
		codeSteps: codeSteps.length,
		hiddenCode: stages.size - shown.size,
	};
}
/** Longest common dotted prefix of stage names (`a.b.c`, `a.b.d` → `a.b`), else empty. */
function commonPrefix(names) {
	const parts = names.map((name) => name.split("."));
	const shared = [];
	for (let i = 0; i < parts[0].length - 1; i++) {
		if (parts.every((p) => p.length > i + 1 && p[i] === parts[0][i]))
			shared.push(parts[0][i]);
		else break;
	}
	return shared.join(".");
}
/**
 * Fewer edge crossings: order each layer by the mean position of its neighbours in the layers
 * it connects to (barycenter sweeps down, then up); spec order breaks ties.
 */
function orderLayers(layers) {
	const position = new Map();
	const place = (layer) =>
		layer.forEach((stage, i) =>
			position.set(stage.id, layer.length > 1 ? i / (layer.length - 1) : 0.5),
		);
	const spec = new Map();
	layers.forEach((layer) => {
		layer.forEach((stage, i) => spec.set(stage.id, i));
		place(layer);
	});
	const sortBy = (layer, neighbours) => {
		const mean = (stage) => {
			const values = [...neighbours(stage)]
				.map((id) => position.get(id))
				.filter((value) => value !== undefined);
			return values.length
				? values.reduce((sum, value) => sum + value, 0) / values.length
				: position.get(stage.id);
		};
		const keys = new Map(layer.map((stage) => [stage.id, mean(stage)]));
		layer.sort(
			(a, b) =>
				keys.get(a.id) - keys.get(b.id) || spec.get(a.id) - spec.get(b.id),
		);
		place(layer);
	};
	for (let sweep = 0; sweep < 2; sweep++) {
		for (let n = 1; n < layers.length; n++)
			sortBy(layers[n], (stage) => stage.deps);
		for (let n = layers.length - 2; n >= 0; n--)
			sortBy(layers[n], (stage) => stage.kids);
	}
	return layers;
}
const activeAgents = (stage) =>
	stage.kind === "foreach" &&
	["running", "retry", "failed", "blocked"].includes(stage.status) &&
	stage.items.length;
function nodeHeight(stage) {
	if (stage.kind === "group") return 55 + stage.members.length * 25;
	if (stage.ghost) return 58;
	if (activeAgents(stage))
		return stage.items.length <= 6 ? 55 + stage.items.length * 25 : 76;
	// 2026-11-03 (owner's pick of the graph mock-ups): every stage is a full card with a second
	// line — code steps and waiting stages included; a many-agent stage adds its bar.
	return stage.kind === "foreach" && stage.items.length ? 76 : 58;
}
function stageLine(stage) {
	if (stage.kind === "dynamic" && stage.items.length > 1)
		return `${stage.done} of ${stage.items.length} agents done`;
	// 2026-11-03 (owner: "where did it fail?" — every node of a NEEDS_WORK review read "Done"): a
	// finished stage names the outcomes that leave work to do — "3 agents · 1 keep · 2 weaken",
	// "Needs work · 10s" — instead of only its agent count and time.
	if (stage.status === "pending") return "Waiting";
	if (stage.kind === "foreach" && stage.status === "completed") {
		const flagged = new Map();
		for (const task of stage.items)
			if (
				task.outcome?.status &&
				task.outcome.tone &&
				task.outcome.tone !== "ok"
			)
				flagged.set(
					task.outcome.status.toLowerCase(),
					(flagged.get(task.outcome.status.toLowerCase()) ?? 0) + 1,
				);
		const starts = stage.items.map((t) => date(t.startedAt)).filter(Boolean),
			ends = stage.items.map((t) => date(t.completedAt)).filter(Boolean);
		const took =
			starts.length && ends.length
				? duration(Math.max(...ends) - Math.min(...starts))
				: "";
		return (
			[...[...flagged].map(([status, count]) => `${count} ${status}`), took]
				.filter(Boolean)
				.join(", ") ||
			(stage.items.length ? `${stage.items.length} done` : "No agents ran")
		);
	}
	const only = stage.items[0];
	if (!only) return labels[stage.status] || "Waiting";
	if (only.status === "failed" && stage.kind === "support" && only.lastMessage)
		return `Failed: ${only.lastMessage}`;
	if (only.status !== "completed") return taskLine(only);
	const took =
		only.startedAt && only.completedAt
			? duration(
					only.elapsedMs ?? date(only.completedAt) - date(only.startedAt),
				)
			: "";
	// A check already says "done": the line says what came out — a warning's word, a code step's
	// short result (never a bare hash) — and how long it took.
	const said =
		only.outcome?.tone && only.outcome.tone !== "ok" && only.outcome.status
			? only.outcome.status
			: stage.kind === "support" &&
					only.outcome?.text &&
					!/^[0-9a-f]{16,}$|^#|##|^support helper completed\.?$/i.test(
						only.outcome.text.trim(),
					)
				? readablePairs(only.outcome.text.trim())
				: "";
	return [said, took].filter(Boolean).join(", ") || "Done";
}
/** "dedup: raw=3, unique=3, duplicates=0" → "raw 3 · unique 3 · duplicates 0" (code-step results). */
function readablePairs(text) {
	const body = text.replace(/^[\w-]+:\s*/, "");
	const pairs = body.split(/,\s*/);
	return pairs.length > 1 && pairs.every((pair) => /^[\w-]+=\S+$/.test(pair))
		? pairs.map((pair) => pair.replace("=", " ")).join(", ")
		: text;
}
function emptyForeach(stage) {
	return (
		stage?.kind === "foreach" &&
		!stage.items.length &&
		stage.tasks.every((task) => task.placeholder)
	);
}
function chooseStage(stage) {
	if (stage.ghost) return chooseStage(stage.parent);
	// 2026-11-03 (owner): a one-agent stage opens like a many-agent one — its readable result
	// first (renderSingle); "Open agent ›" leads to the raw output, logs and events.
	if (!stage.items.length && stage.tasks.length === 1 && !emptyForeach(stage))
		go({ task: stage.tasks[0].specId });
	else go({ stage: stage.id });
}
function selectedTask() {
	return run?.tasks.find(
		(t) => t.specId === state.task || t.taskId === state.task,
	);
}
function selectedStage() {
	return state.stage || selectedTask()?.stageId;
}
const graphViews = new Map();
const EDGE_STATES = ["done", "active", "blocked", "next", "later", "failed"];
/** Fit never zooms below this: boxes stay large enough for their 14px text (rows, bars). */
const FIT_MIN_ZOOM = 0.7;
const settledStage = (stage) => ["completed", "skipped"].includes(stage.status);
const activeStage = (stage) =>
	["running", "retry", "blocked"].includes(stage.status);
/** The stage a pending node is waiting on has started or finished: work heads here next. */
const nextStage = (stage) =>
	stage.status === "pending" &&
	!stage.ghost &&
	stage.deps.size > 0 &&
	[...stage.deps].every((id) => {
		const dep = graphModel.nodes.get(id);
		return settledStage(dep) || activeStage(dep);
	});
/** Axis-aligned polyline with rounded corners (radius shrinks on short segments). */
function roundedPath(points, radius = 10) {
	let d = `M${points[0][0]},${points[0][1]}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [px, py] = points[i - 1],
			[cx, cy] = points[i],
			[nx, ny] = points[i + 1];
		const inLength = Math.hypot(cx - px, cy - py),
			outLength = Math.hypot(nx - cx, ny - cy);
		const r = Math.min(radius, inLength / 2, outLength / 2);
		if (r < 0.5 || !inLength || !outLength) {
			d += ` L${cx},${cy}`;
			continue;
		}
		const ax = cx - ((cx - px) / inLength) * r,
			ay = cy - ((cy - py) / inLength) * r,
			bx = cx + ((nx - cx) / outLength) * r,
			by = cy + ((ny - cy) / outLength) * r;
		d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
	}
	const [ex, ey] = points.at(-1);
	return `${d} L${ex},${ey}`;
}
/**
 * Orthogonal edge (GitHub Actions style): a stem out of the source, a rail along the channel
 * between the two layers (one shared line per channel, so a fan-out/join reads as a bus), a
 * stem into the target. An edge that skips layers travels down the gap beside its source.
 * Coordinates are written for top-down; left-right swaps the axes.
 */
function edgePath(a, b, horizontal, railOut, railIn) {
	const flip = ([x, y]) => (horizontal ? [y, x] : [x, y]);
	const box = (p) => (horizontal ? { x: p.y, y: p.x, w: p.h, h: p.w } : p);
	const A = box(a),
		B = box(b);
	const x1 = A.x + A.w / 2,
		y1 = A.y + A.h,
		x2 = B.x + B.w / 2,
		y2 = B.y;
	let points;
	if (railOut === railIn) {
		points =
			Math.abs(x2 - x1) < 1
				? [
						[x1, y1],
						[x2, y2],
					]
				: [
						[x1, y1],
						[x1, railOut],
						[x2, railOut],
						[x2, y2],
					];
	} else {
		const gap = x2 >= x1 ? A.x + A.w + 9 : A.x - 9;
		points = [
			[x1, y1],
			[x1, railOut],
			[gap, railOut],
			[gap, railIn],
			[x2, railIn],
			[x2, y2],
		];
	}
	const start = flip(points[0]);
	return { d: roundedPath(points.map(flip)), x1: start[0], y1: start[1] };
}
/** How an edge reads: where work has been (done), is (active/blocked), goes next, or later. */
function edgeState(from, to) {
	if (to.status === "failed") return "failed";
	if (to.status === "blocked") return "blocked";
	if (activeStage(to)) return "active";
	if (settledStage(to) || to.status === "interrupted") return "done";
	return settledStage(from) || activeStage(from) ? "next" : "later";
}
function renderGraph(preview = null) {
	const model = preview?.model || graphModel;
	const layout = preview?.layout || state.layout;
	const expandedCode = preview ? preview.showCode : showCode;
	const views = preview?.views || graphViews;
	const lineFor = preview?.describe || stageLine;
	const openStage = preview?.select || chooseStage;
	const selectedId = preview?.selected || selectedStage;
	const prefix = preview ? "profile-flow-" : "";
	// First drawing of this run in this tab: replay how the work travelled (cards and edges
	// appear layer by layer). Redraws after a status change do not.
	const replay = !preview && graphControl?.runId !== run.runId;
	if (!preview) graphControl?.destroy();
	// Each graph shape keeps its own view: showing the code steps fits the taller graph anew.
	const viewKey = `${preview ? preview.key : run.runId}:${layout}:${expandedCode}`;
	const savedView = views.get(viewKey);
	// Run controls occupy their own rows, not the drawable/pannable viewport. Every
	// camera operation (including resize and keyboard reveal) measures only wrap.
	// Profile previews retain their independent layout and saved camera behavior.
	const shell = element("div", {
		class: preview ? "canvas profile-flow-canvas" : "canvas run-graph",
		id: preview ? null : "canvas",
	});
	const wrap = preview ? shell : element("div", { class: "graph-drawing" });
	if (!preview) shell.append(wrap);
	const drawing = svg("svg", {
		class: "graph",
		role: "group",
		"aria-label": preview
			? `Workflow ${preview.name} settings. Arrow keys move between stages; Enter edits.`
			: `Graph of ${run.name}. Arrow keys move between stages; Enter opens.`,
	});
	const viewport = svg("g"),
		edges = svg("g"),
		nodes = svg("g");
	// Arrowheads: one marker per edge state (the fill is a CSS rule); sized in apply() so they
	// keep a constant screen size at any zoom.
	const defs = svg(
		"defs",
		{},
		svg(
			"pattern",
			{
				id: `${prefix}failure-hatch`,
				width: 5,
				height: 5,
				patternUnits: "userSpaceOnUse",
				patternTransform: "rotate(135)",
			},
			svg("rect", { width: 5, height: 5, class: "hatch-base" }),
			svg("line", { x1: 0, x2: 0, y1: 0, y2: 5, class: "hatch-line" }),
		),
	);
	for (const state of EDGE_STATES)
		defs.append(
			svg(
				"marker",
				{
					id: `${prefix}arrow-${state}`,
					class: `arrow ${state}`,
					viewBox: "0 0 10 10",
					refX: 8.5,
					refY: 5,
					markerUnits: "userSpaceOnUse",
					markerWidth: 13,
					markerHeight: 13,
					orient: "auto",
				},
				svg("path", { d: "M1,1.5 L9,5 L1,8.5 Q3,5 1,1.5 z" }),
			),
		);
	viewport.append(edges, nodes);
	drawing.append(defs, viewport);
	wrap.append(drawing);
	const positions = new Map(),
		horizontal = layout === "lr";
	const widest = Math.max(...model.layers.map((layer) => layer.length));
	const width = widest >= 4 ? 300 : widest === 3 ? 340 : 440;
	let axis = 0;
	const layerOf = new Map(),
		rails = [];
	model.layers.forEach((layer, n) => {
		const total = horizontal
			? layer.reduce((sum, stage) => sum + nodeHeight(stage), 0) +
				(layer.length - 1) * 14
			: layer.length * width + (layer.length - 1) * 18;
		let side = -total / 2;
		const height = Math.max(...layer.map(nodeHeight));
		for (const stage of layer) {
			layerOf.set(stage.id, n);
			positions.set(stage.id, {
				x: horizontal ? axis : side,
				// Top-aligned in their layer (owner 2026-11-13): cards of different heights keep their
				// titles on one line; each edge still leaves from its own card's bottom.
				y: horizontal ? side : axis,
				w: width,
				h: nodeHeight(stage),
			});
			side += horizontal ? nodeHeight(stage) + 14 : width + 18;
		}
		// Room between layers so the edges and their arrowheads read as a path, not a seam; the
		// rail every edge of this channel shares runs through its middle.
		const gap = horizontal ? 80 : 34,
			end = axis + (horizontal ? width : height);
		rails.push(end + gap / 2);
		axis = end + gap;
	});
	const links = [];
	for (const edge of model.edges) {
		const a = positions.get(edge.from),
			b = positions.get(edge.to);
		const { d, x1, y1 } = edgePath(
			a,
			b,
			horizontal,
			rails[layerOf.get(edge.from)],
			rails[layerOf.get(edge.to) - 1],
		);
		const state = preview
			? "later"
			: edgeState(model.nodes.get(edge.from), model.nodes.get(edge.to));
		const link = svg(
			"g",
			{ class: `link ${state}`, "data-link": `${edge.from}>${edge.to}` },
			svg("path", {
				class: `edge ${state}`,
				d,
				"marker-end": `url(#${prefix}arrow-${state})`,
				"data-edge": `${edge.from}>${edge.to}`,
			}),
			svg("circle", { class: `port ${state}`, cx: x1, cy: y1, r: 3 }),
		);
		links.push({ from: edge.from, to: edge.to, link });
		edges.append(link);
	}
	// Hover or focus a card: its edges and neighbours stay lit, everything else steps back, so a
	// dense join still reads "this one feeds these".
	function trace(id) {
		drawing.classList.toggle("tracing", Boolean(id));
		const near = new Set([id]);
		for (const { from, to, link } of links) {
			const lit = Boolean(id) && (from === id || to === id);
			link.classList.toggle("lit", lit);
			if (lit) near.add(from).add(to);
		}
		for (const node of nodes.querySelectorAll(".node"))
			node.classList.toggle("lit", Boolean(id) && near.has(node.dataset.stage));
	}
	const priority = {
		running: 0,
		retry: 1,
		failed: 2,
		blocked: 3,
		completed: 4,
	};
	const mixed = [...model.nodes.values()].some((n) => n.kind === "support");
	for (const stage of model.nodes.values()) {
		const p = positions.get(stage.id);
		const group = stage.kind === "group";
		const title = group
			? `${stage.name ? `${stage.name}, ` : ""}${stage.members.length} in parallel`
			: humanize(stage.short || stage.name || stage.id);
		// Who did the work, at the card's right (owner's pick, 2026-11-03): "✦ agent" / "✦ 3 agents",
		// "</> code". With no code step in view every card is an agent's, so a lone "agent" goes.
		const blockedCount = stageBlockedCount(stage);
		const tag = blockedCount
			? `⚠ ${blockedCount} blocked`
			: group || stage.ghost
				? null
				: stage.kind === "support"
					? "code"
					: stage.kind === "foreach"
						? stage.items.length
							? `${stage.items.length} agent${stage.items.length === 1 ? "" : "s"}`
							: "agents"
						: mixed
							? "agent"
							: null;
		const node = svg("g", {
			class: `node ${preview ? "settings" : stage.status}${stage.ghost ? " ghost" : ""}${stage.kind === "support" ? " support" : ""}${group ? " group" : ""}${!preview && nextStage(stage) ? " next" : ""}`,
			transform: `translate(${p.x},${p.y})`,
			tabindex: "0",
			role: "button",
			"data-stage": stage.id,
			...(group
				? { "data-members": stage.members.map((s) => s.id).join(",") }
				: {}),
			"aria-label": preview
				? group
					? `${title}, select a stage`
					: `${stage.name || stage.id}, ${lineFor(stage)}`
				: `${group ? title : stage.name || stage.id}, ${labels[stage.status] || "Waiting"}${blockedCount ? `, ${blockedCount} actions blocked` : ""}`,
		});
		node.append(
			svg("rect", { class: "outline", width: p.w, height: p.h, rx: 10 }),
			svg(
				"title",
				{},
				group
					? title
					: `${title}${stage.kind === "support" ? ", code step (no model)" : ""}`,
			),
			// 2026-11-03 (owner): the graph shows the process; what agents concluded ("2 weaken ·
			// 1 keep", "Needs work") stays in the card's text and in the result, not in its mark.
			preview
				? kindIcon(stage.kind === "support" ? "code" : "agent", 12, 12)
				: markIcon(stage.status, 12, 12),
			svg(
				"text",
				{
					x: 36,
					y: 24,
					class: "node-name",
					"data-fit": p.w - 48 - (tag ? tag.length * 7 + 30 : 0),
				},
				title,
			),
			tag
				? svg(
						"g",
						{
							class: `node-kind${blockedCount ? " blocked-actions-chip" : ""} ${stage.kind === "support" ? "code" : "agent"}`,
						},
						blockedCount
							? null
							: kindIcon(
									stage.kind === "support" ? "code" : "agent",
									p.w - 14 - tag.length * 7 - 20,
									13,
								),
						svg("text", { x: p.w - 14, y: 24, "text-anchor": "end" }, tag),
					)
				: null,
		);
		node.addEventListener("mouseenter", () => trace(stage.id));
		node.addEventListener("mouseleave", () => trace(null));
		node.addEventListener("focusin", () => trace(stage.id));
		node.addEventListener("focusout", (event) => {
			if (!node.contains(event.relatedTarget)) trace(null);
		});
		// The card opens its stage (a group card: its first stage; each row opens its own).
		const open = () => openStage(group ? stage.members[0] : stage);
		node.addEventListener("click", open);
		node.addEventListener("keydown", (event) => {
			if (["Enter", " "].includes(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				open();
			} else if (
				["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)
			) {
				event.preventDefault();
				event.stopPropagation();
				const list = [...nodes.querySelectorAll(".node, .agent-row")],
					i = list.indexOf(event.target);
				const target =
					list[
						Math.max(
							0,
							Math.min(
								list.length - 1,
								i + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1),
							),
						)
					];
				target?.focus();
				const id = target?.closest(".node")?.dataset.stage;
				if (id) reveal(id);
			}
		});
		if (group) {
			stage.members.forEach((member, i) => {
				const y = 48 + i * 25,
					name = stage.name
						? member.short.slice(stage.name.length + 1)
						: member.short;
				const row = svg("g", {
					class: "agent-row stage-row",
					role: "button",
					tabindex: "0",
					"data-stage": member.id,
					"aria-label": `${member.name || member.id}, ${preview ? lineFor(member) : labels[member.status] || "Waiting"}`,
				});
				row.append(
					svg("rect", {
						x: 8,
						y: y - 17,
						width: p.w - 16,
						height: 25,
						fill: "transparent",
					}),
					preview
						? kindIcon(
								member.kind === "support" ? "code" : "agent",
								15,
								y - 11,
								13,
							)
						: markIcon(member.status, 15, y - 11, 13),
					svg(
						"text",
						{
							x: 36,
							y,
							class: "agent-name",
							"data-fit": preview ? p.w / 2 - 45 : p.w - 150,
						},
						humanize(name),
					),
					svg(
						"text",
						{
							x: p.w - 14,
							y,
							class: "agent-state",
							"text-anchor": "end",
							"data-stage-line": member.id,
							...(preview ? { "data-fit": p.w / 2 - 25 } : {}),
						},
						lineFor(member),
					),
				);
				row.addEventListener("click", (event) => {
					event.stopPropagation();
					openStage(member);
				});
				row.addEventListener("keydown", (event) => {
					if (["Enter", " "].includes(event.key)) {
						event.preventDefault();
						event.stopPropagation();
						openStage(member);
					}
				});
				node.append(row);
			});
			if (!preview) {
				const barWidth = p.w - 92,
					completedWidth = (stage.done / stage.members.length) * barWidth;
				node.append(
					svg("rect", {
						x: 12,
						y: p.h - 14,
						width: barWidth,
						height: 3,
						rx: 1.5,
						class: "track",
					}),
					svg("rect", {
						x: 12,
						y: p.h - 14,
						width: completedWidth,
						height: 3,
						rx: 1.5,
						class: "bar",
					}),
					svg(
						"text",
						{
							x: p.w - 14,
							y: p.h - 10,
							"text-anchor": "end",
							class: "fraction",
						},
						`${stage.done}/${stage.members.length}`,
					),
				);
			}
			nodes.append(node);
			continue;
		}
		if (activeAgents(stage) && stage.items.length <= 6) {
			[...stage.items]
				.sort(
					(a, b) =>
						(priority[taskState(a)] ?? 5) - (priority[taskState(b)] ?? 5),
				)
				.forEach((task, i) => {
					const y = 48 + i * 25,
						status = taskState(task),
						name = task.specId.slice(stage.id.length + 1);
					const row = svg("g", {
						class: "agent-row",
						role: "button",
						tabindex: "0",
						"data-task": task.specId,
						"aria-label": `${name}, ${labels[status] || "Waiting"}`,
					});
					row.append(
						svg("rect", {
							x: 8,
							y: y - 17,
							width: p.w - 16,
							height: 25,
							fill: "transparent",
						}),
						markIcon(status, 15, y - 11, 13),
						svg(
							"text",
							{ x: 36, y, class: "agent-name", "data-fit": p.w - 165 },
							name,
						),
						svg(
							"text",
							{
								x: p.w - 14,
								y,
								class: "agent-state",
								"text-anchor": "end",
								"data-agent-state": task.specId,
							},
							agentState(task),
						),
					);
					row.addEventListener("click", (event) => {
						event.stopPropagation();
						go({ task: task.specId });
					});
					row.addEventListener("keydown", (event) => {
						if (["Enter", " "].includes(event.key)) {
							event.preventDefault();
							event.stopPropagation();
							go({ task: task.specId });
						}
					});
					node.append(row);
				});
		} else if (activeAgents(stage)) {
			const count = (status) =>
				stage.items.filter((t) => taskState(t) === status).length;
			node.append(
				svg(
					"text",
					{ x: 36, y: 44, class: "sub", "data-fit": p.w - 48 },
					stage.items.length > 48
						? `${stage.items.length} agents, inspect items`
						: `${stage.done} of ${stage.items.length} done, ${count("running")} running`,
				),
			);
		} else if (!group)
			node.append(
				svg(
					"text",
					{
						x: 36,
						y: 44,
						class: "sub",
						"data-fit": p.w - 48,
						"data-stage-line": stage.id,
					},
					lineFor(stage),
				),
			);
		if (
			stage.kind === "foreach" &&
			stage.items.length > 0 &&
			stage.items.length <= 48
		) {
			const gap = 3,
				width =
					(p.w - 48 - gap * (stage.items.length - 1)) / stage.items.length;
			stage.items.forEach((task, i) => {
				const status = taskState(task),
					tone =
						status === "failed" ? "err" : status === "completed" ? "ok" : "";
				node.append(
					svg(
						"rect",
						{
							x: 36 + i * (width + gap),
							y: p.h - 13,
							width,
							height: 5,
							rx: 1,
							class: `segment ${status} ${tone} stagger-${i % 6}`,
							...(tone === "err"
								? { fill: `url(#${prefix}failure-hatch)` }
								: {}),
							"data-segment": task.specId,
							"aria-label": `${task.title || task.specId}, ${labels[status] || "Waiting"}${tone === "err" ? ", failed" : task.outcome?.status && task.outcome.tone !== "ok" ? `, ${task.outcome.status}` : ""}`,
						},
						svg(
							"title",
							{},
							`${task.title || task.specId}, ${task.outcome?.status || labels[status] || "Waiting"}`,
						),
					),
				);
			});
		} else if (stage.kind === "foreach" && stage.items.length) {
			// More than 48 agents: one bar and a count. A stage whose agents are not generated yet
			// has neither (they sat on its "Waiting" line; owner, 2026-11-03).
			const barWidth = p.w - 92,
				completedWidth = stage.items.length
					? (stage.done / stage.items.length) * barWidth
					: 0;
			node.append(
				svg("rect", {
					x: 12,
					y: p.h - 14,
					width: barWidth,
					height: 3,
					rx: 1.5,
					class: "track",
				}),
				svg("rect", {
					x: 12,
					y: p.h - 14,
					width: completedWidth,
					height: 3,
					rx: 1.5,
					class: "bar",
				}),
				svg(
					"text",
					{ x: p.w - 14, y: p.h - 10, "text-anchor": "end", class: "fraction" },
					`${stage.done}/${stage.items.length}`,
				),
			);
			if (stage.items.some((t) => t.status === "running"))
				node.append(
					svg("rect", {
						x: 12 + Math.min(barWidth - 2, completedWidth),
						y: p.h - 14,
						width: 2,
						height: 3,
						class: "running-marker",
					}),
				);
		}
		nodes.append(node);
	}
	let disposed = false;
	let view = savedView ? { ...savedView } : { x: 0, y: 0, k: 1 },
		dragged = null;
	function bounds() {
		const values = [...positions.values()];
		if (!values.length) return undefined;
		const x0 = Math.min(...values.map((p) => p.x)) - 8,
			y0 = Math.min(...values.map((p) => p.y)) - 8;
		return {
			x0,
			y0,
			w: Math.max(...values.map((p) => p.x + p.w)) + 8 - x0,
			h: Math.max(...values.map((p) => p.y + p.h)) + 8 - y0,
		};
	}
	function previewInset() {
		return preview &&
			matchMedia("(max-width: 800px), (pointer: coarse)").matches
			? 44
			: 0;
	}
	// The graph can never be panned out of sight: a graph smaller than the canvas stays inside
	// it, a larger one stops when its far edge reaches the canvas edge.
	function clamp() {
		const b = bounds();
		if (!b || !wrap.clientWidth || !wrap.clientHeight) return;
		const range = (lead, trail, size, start, length) => {
			const near = lead - start * view.k,
				far = size - trail - (start + length) * view.k;
			return [Math.min(near, far), Math.max(near, far)];
		};
		// Keep the original gutter even when the graph overflows. Reduce it only
		// if this viewport cannot fit a single full card plus the bounds' 8px
		// padding on each side (notably a 440px card at the readable phone floor).
		const cardWidth = Math.max(...[...positions.values()].map((p) => p.w));
		const spare = wrap.clientWidth - (cardWidth + 16) * view.k;
		const margin = preview ? 16 : Math.min(16, Math.max(0, spare / 2));
		const [xMin, xMax] = range(margin, margin, wrap.clientWidth, b.x0, b.w);
		// The overflowing branch caps Fit at the near edge; reserve the chip here too.
		const [yMin, yMax] = range(
			16 + previewInset(),
			preview ? 76 : 16,
			wrap.clientHeight,
			b.y0,
			b.h,
		);
		view.x = Math.min(xMax, Math.max(xMin, view.x));
		view.y = Math.min(yMax, Math.max(yMin, view.y));
	}
	// Off-screen hints: when part of the graph is outside the canvas, a pill on that side says how
	// many stages are there (accent when one of them is where the work is); clicking pans there.
	const sides = {
		left: "\u2190",
		right: "\u2192",
		top: "\u2191",
		bottom: "\u2193",
	};
	const hints = Object.fromEntries(
		Object.keys(sides).map((side) => [
			side,
			button("", () => pan(side), {
				class: `more ${side}`,
				hidden: "",
				"data-more": side,
			}),
		]),
	);
	function pan(side) {
		view.manual = true;
		const dx = wrap.clientWidth * 0.8,
			dy = (wrap.clientHeight - (preview ? 76 : 0)) * 0.8;
		if (side === "left") view.x += dx;
		else if (side === "right") view.x -= dx;
		else if (side === "top") view.y += dy;
		else view.y -= dy;
		apply();
	}
	function updateHints() {
		const W = wrap.clientWidth,
			H = wrap.clientHeight - (preview ? 60 : 0);
		const count = { left: 0, right: 0, top: 0, bottom: 0 },
			live = { left: false, right: false, top: false, bottom: false };
		for (const stage of model.nodes.values()) {
			const p = positions.get(stage.id);
			const x0 = p.x * view.k + view.x,
				x1 = (p.x + p.w) * view.k + view.x,
				y0 = p.y * view.k + view.y,
				y1 = (p.y + p.h) * view.k + view.y;
			const side =
				x1 < 0
					? "left"
					: x0 > W
						? "right"
						: y1 < 0
							? "top"
							: y0 > H
								? "bottom"
								: null;
			if (!side) continue;
			count[side] += 1;
			if (activeStage(stage) || stage.status === "failed") live[side] = true;
		}
		for (const [side, hint] of Object.entries(hints)) {
			hint.hidden = !count[side];
			const text = `${count[side]} more${live[side] ? ", active" : ""}`;
			hint.textContent =
				side === "left" || side === "top"
					? `${sides[side]} ${text}`
					: `${text} ${sides[side]}`;
			hint.classList.toggle("live", live[side]);
			hint.setAttribute(
				"aria-label",
				`${count[side]} stages ${side === "left" ? "to the left" : side === "right" ? "to the right" : side === "top" ? "above" : "below"}; pan there`,
			);
		}
	}
	function apply() {
		clamp();
		view.width = wrap.clientWidth;
		view.height = wrap.clientHeight;
		views.set(viewKey, { ...view });
		viewport.setAttribute(
			"transform",
			`translate(${view.x},${view.y}) scale(${view.k})`,
		);
		updateHints();
		// Arrowheads keep ~13px on screen whatever the zoom.
		for (const marker of defs.querySelectorAll("marker")) {
			marker.setAttribute("markerWidth", 13 / view.k);
			marker.setAttribute("markerHeight", 13 / view.k);
		}
		// A card's "✦ agent" / "</> code" sits at its right edge, sized like the other small text;
		// the name gets what is left of the line.
		for (const kind of nodes.querySelectorAll(".node-kind")) {
			if (kind.closest(".morph-old")) continue;
			const label = kind.querySelector("text"),
				icon = kind.querySelector("svg");
			const size = Math.max(12, 12 / Math.max(view.k, FIT_MIN_ZOOM));
			// A class rule would override the presentation attribute: size a nested span.
			if (!label.dataset.full) label.dataset.full = label.textContent;
			label.replaceChildren(
				svg("tspan", { "font-size": size }, label.dataset.full),
			);
			const width = label.getComputedTextLength(),
				iconSize = size * 1.1;
			icon.setAttribute("width", iconSize);
			icon.setAttribute("height", iconSize);
			const card = Number(
				kind.parentNode
					.querySelector(":scope > .outline")
					?.getAttribute("width"),
			);
			icon.setAttribute("x", card - 14 - width - 5 - iconSize);
			icon.setAttribute("y", 24 - iconSize * 0.85);
			const name = kind.parentNode.querySelector(":scope > .node-name");
			if (card && name)
				name.dataset.fit = card - 36 - 14 - (width + 5 + iconSize) - 12;
		}
		// SVG presentation attributes keep text >=14px at Fit without inline CSS. Below the Fit
		// floor (an explicit zoom-out) the text shrinks with the boxes instead of spilling over them.
		for (const text of nodes.querySelectorAll("text")) {
			if (text.closest(".morph-old, .node-kind")) continue; // a fading copy keeps its fitted text
			const size = text.classList.contains("node-name") ? 15 : 14;
			const fontSize = Math.max(size, size / Math.max(view.k, FIT_MIN_ZOOM));
			text.setAttribute("font-size", fontSize);
			// A class rule would override the presentation attribute: use a nested text span.
			if (!text.dataset.full) text.dataset.full = text.textContent;
			text.replaceChildren(
				svg("tspan", { "font-size": fontSize }, text.dataset.full),
			);
			const max = Number(text.dataset.fit);
			const span = text.firstChild;
			if (max && text.getComputedTextLength() > max) {
				let low = 0,
					high = text.dataset.full.length;
				while (low < high) {
					const mid = (low + high + 1) >> 1;
					span.textContent = `${text.dataset.full.slice(0, mid)}…`;
					if (text.getComputedTextLength() <= max) low = mid;
					else high = mid - 1;
				}
				span.textContent = `${text.dataset.full.slice(0, low)}…`;
			}
		}
		// A card's second line keeps a line's distance below the name at any zoom (the text keeps
		// >=14 px while the card scales).
		for (const node of nodes.querySelectorAll(":scope > .node")) {
			const name = node.querySelector(":scope > .node-name");
			const nameSize = Number(name?.getAttribute("font-size")) || 15;
			const sub = node.querySelector(":scope > .sub");
			if (sub) sub.setAttribute("y", Math.max(44, 24 + nameSize * 1.3));
		}
	}
	function fit() {
		const b = bounds();
		if (!b) return;
		const { x0, y0, w, h } = b;
		// Reserve room for the code-step chip only in narrow profile previews.
		const inset = previewInset();
		const top = preview ? 44 + inset : 16;
		const available = Math.max(
			preview ? 100 : 1,
			wrap.clientHeight - (preview ? 140 : 32),
		);
		// Never shrink boxes below what their text needs; a big graph pans (clamped) instead.
		const k = Math.max(
			FIT_MIN_ZOOM,
			Math.min((wrap.clientWidth - 40) / w, available / h, 1.05),
		);
		// A graph that overflows at the floor starts at its beginning (top / left); Focus and the
		// clamped pan reach the rest.
		view = {
			k,
			x:
				w * k > wrap.clientWidth - 40
					? 20 - x0 * k
					: wrap.clientWidth / 2 - (x0 + w / 2) * k,
			y:
				h * k > available
					? top - y0 * k
					: top + (available - h * k) / 2 - y0 * k,
		};
		apply();
	}
	function reveal(stageId, focus = false) {
		const id = model.owner.get(stageId) ?? stageId;
		const p = positions.get(id);
		if (!p) return;
		// In short Run windows the shell can scroll its chrome. Keyboard/Focus
		// reveal must bring the drawing back as well as moving its camera.
		if (!preview) wrap.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (
			!focus &&
			p.x * view.k + view.x >= 0 &&
			p.y * view.k + view.y >= 0 &&
			(p.x + p.w) * view.k + view.x < wrap.clientWidth &&
			(p.y + p.h) * view.k + view.y < wrap.clientHeight - (preview ? 60 : 0)
		)
			return;
		view.manual = true;
		if (focus) view.k = Math.min(1.15, (wrap.clientWidth - 32) / p.w);
		view.x = wrap.clientWidth / 2 - (p.x + p.w / 2) * view.k;
		view.y =
			(wrap.clientHeight - (preview ? 60 : 0)) / 2 - (p.y + p.h / 2) * view.k;
		apply();
	}
	wrap.addEventListener(
		"wheel",
		(event) => {
			event.preventDefault();
			view.manual = true;
			if (event.ctrlKey || event.metaKey) {
				const rect = wrap.getBoundingClientRect(),
					x = event.clientX - rect.left,
					y = event.clientY - rect.top;
				const k = Math.max(
					0.4,
					Math.min(2, view.k * Math.exp(-event.deltaY * 0.01)),
				);
				view = {
					manual: true,
					k,
					x: x - ((x - view.x) * k) / view.k,
					y: y - ((y - view.y) * k) / view.k,
				};
			} else {
				view.x -= event.deltaX;
				view.y -= event.deltaY;
			}
			apply();
		},
		{ passive: false },
	);
	wrap.addEventListener("pointerdown", (event) => {
		if (event.target.closest(".node,button,.toolbar")) return;
		dragged = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
		wrap.setPointerCapture(event.pointerId);
	});
	wrap.addEventListener("pointermove", (event) => {
		// A press that barely moves is a click, not a pan (it keeps the view as it was).
		if (
			dragged &&
			Math.hypot(event.clientX - dragged.x, event.clientY - dragged.y) >= 4
		)
			dragged.moved = true;
		if (dragged?.moved) {
			view.manual = true;
			view.x = dragged.vx + event.clientX - dragged.x;
			view.y = dragged.vy + event.clientY - dragged.y;
			apply();
		}
	});
	wrap.addEventListener("pointerup", () => {
		// 2026-11-04 (owner): a click on the empty canvas closes the open inspector (a stage, an
		// agent or Run details); a drag only pans.
		if (dragged && !dragged.moved) {
			if (preview) preview.clear();
			else if (!$("inspector").hidden) closeInspector();
		}
		dragged = null;
	});
	wrap.addEventListener("pointercancel", () => {
		dragged = null;
	});
	// Code steps are hidden unless this switch shows them (owner's pick, 2026-11-03).
	if (model.codeSteps)
		shell.append(
			element(
				"button",
				{
					type: "button",
					class: "code-switch",
					role: "switch",
					"aria-checked": String(expandedCode),
					title: expandedCode
						? "Hide the steps the engine runs itself"
						: "Show the steps the engine runs itself (no model)",
				},
				element("span", { class: "track", "aria-hidden": "true" }),
				kindIcon("code"),
				element(
					"span",
					{
						class: "code-switch-count",
						"data-short": expandedCode
							? `${model.codeSteps} shown`
							: model.hiddenCode
								? `${model.hiddenCode} hidden`
								: "Code",
					},
					expandedCode
						? `${model.codeSteps} code step${model.codeSteps === 1 ? "" : "s"} shown`
						: model.hiddenCode
							? `${model.hiddenCode} code step${model.hiddenCode === 1 ? "" : "s"} hidden`
							: "Code steps",
				),
				element(
					"span",
					{ class: "code-switch-action" },
					expandedCode ? "Hide" : "Show",
				),
			),
		);
	if (!preview && model.codeSteps)
		shell.prepend(shell.querySelector(".code-switch"));
	shell
		.querySelector(".code-switch")
		?.addEventListener("click", preview ? preview.toggleCode : toggleCode);
	shell.append(
		element(
			"div",
			{ class: "toolbar", role: "toolbar", "aria-label": "Graph view" },
			button([markIcon("fit"), "Fit"], fit, {
				title: preview ? "Fit graph" : "Fit graph (F)",
			}),
			button("Focus", () => {
				const id =
					selectedId() ||
					[...model.nodes.values()].find((s) =>
						["running", "retry", "blocked", "failed"].includes(s.status),
					)?.id ||
					(preview
						? [...model.nodes.keys()][0]
						: [...model.nodes.keys()].at(-1));
				reveal(id, true);
			}),
			...(preview ? preview.controls() : viewButtons()),
			preview
				? null
				: button("?", openStatusKey, { "aria-label": "Status key" }),
		),
	);
	function resize() {
		if (disposed || !wrap.clientWidth || !wrap.clientHeight) return;
		if (!view.manual) return fit();
		view.x += (wrap.clientWidth - (view.width || wrap.clientWidth)) / 2;
		view.y += (wrap.clientHeight - (view.height || wrap.clientHeight)) / 2;
		apply();
	}
	if (preview) wrap.append(...Object.values(hints));
	else
		shell.insertBefore(
			element("div", { class: "graph-hints" }, ...Object.values(hints)),
			shell.querySelector(".toolbar"),
		);
	const observer = new ResizeObserver(resize);
	// The journey, replayed: layer n's cards fade in at n·step, the edges leaving them draw
	// themselves toward the next layer right after. Web Animations only — no inline styles.
	function playReplay() {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const step = 170;
		const fade = (target, delay, duration = 260) =>
			target.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration,
				delay,
				fill: "backwards",
				easing: "ease-out",
			});
		for (const node of nodes.querySelectorAll(".node"))
			fade(node, layerOf.get(node.dataset.stage) * step);
		for (const { from, link } of links) {
			const delay = layerOf.get(from) * step + 110;
			fade(link, delay, 160);
			const path = link.querySelector(".edge");
			// Solid edges draw themselves along their length; dashed states keep their pattern
			// (a stylesheet dash array would override the attribute anyway) and only fade in.
			if (
				!path.classList.contains("done") &&
				!path.classList.contains("failed")
			)
				continue;
			const length = path.getTotalLength();
			if (!length) continue;
			path.setAttribute("stroke-dasharray", String(length));
			const draw = path.animate(
				[{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
				{ duration: 320, delay, fill: "backwards", easing: "ease-in-out" },
			);
			draw.onfinish = () => path.removeAttribute("stroke-dasharray");
			draw.oncancel = draw.onfinish;
		}
	}
	// Packets are evidence of a handoff, never decoration on a finished graph. Web Animations
	// only — no inline styles. Geometry stays in SVG coordinates, including orthogonal rails.
	const packets = new Set();
	function handoff(events) {
		if (
			reducedMotion() ||
			document.hidden ||
			$("dialog").open ||
			!wrap.isConnected ||
			!wrap.getClientRects().length
		)
			return;
		for (const event of events) {
			const id = model.owner.get(event.stageId);
			for (const { from, to, link } of links) {
				if ((event.kind === "start" ? to : from) !== id || packets.size >= 24)
					continue;
				const path = link.querySelector(".edge"),
					length = path.getTotalLength();
				if (!length) continue;
				const dot = svg("circle", {
					class: `handoff-packet ${event.tone}`,
					r: 3,
					"data-handoff": event.kind,
					"aria-hidden": "true",
				});
				const frames = Array.from({ length: 41 }, (_, i) => {
					const p = path.getPointAtLength((length * i) / 40);
					return { transform: `translate(${p.x}px, ${p.y}px)` };
				});
				link.append(dot);
				const animation = dot.animate(frames, {
					duration: 800,
					easing: "ease-in-out",
				});
				packets.add(animation);
				animation.onfinish = animation.oncancel = () => {
					dot.remove();
					packets.delete(animation);
				};
			}
		}
	}
	requestAnimationFrame(() => {
		if (!disposed && wrap.isConnected) {
			resize();
			observer.observe(wrap);
			if (replay) playReplay();
		}
	});
	/**
	 * Move cards and edges from the previous drawing's geometry to this one (FLIP). Runs in the
	 * frame callback after this redraw's own resize/apply, so it knows the new view; a view that
	 * re-centred the smaller graph is folded into each start position (screen continuity).
	 */
	/**
	 * Move from the previous drawing to this one (FLIP). Runs in the frame callback after this
	 * redraw's own resize/apply, so it knows the new view. 2026-11-03 (owner: showing and hiding the
	 * code steps jumped): the view itself glides from the old zoom/pan to the new one while cards
	 * move to their new places, cards that leave fade out where they were, and new ones settle in.
	 */
	function morph(previous) {
		if (reducedMotion()) return;
		requestAnimationFrame(() => {
			if (!wrap.isConnected) return;
			const motion = { duration: MOTION.graph, easing: MOTION.ease };
			const parse = (value) => {
				const m =
					/translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(
						value || "",
					);
				return m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null;
			};
			const before = parse(previous.view),
				after = parse(viewport.getAttribute("transform"));
			const css = (v) => `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
			if (
				before &&
				after &&
				(Math.abs(before.x - after.x) > 0.5 ||
					Math.abs(before.y - after.y) > 0.5 ||
					Math.abs(before.k - after.k) > 0.001)
			)
				viewport.animate(
					[{ transform: css(before) }, { transform: css(after) }],
					motion,
				);
			for (const node of nodes.querySelectorAll(":scope > .node[data-stage]")) {
				const now = positions.get(node.dataset.stage),
					was = previous.nodes.get(node.dataset.stage);
				if (!now) continue;
				if (!was) {
					node.animate(
						[
							{
								opacity: 0,
								transform: `translate(${now.x}px, ${now.y - 8}px)`,
							},
							{
								opacity: 0,
								transform: `translate(${now.x}px, ${now.y - 8}px)`,
								offset: 0.35,
							},
							{ opacity: 1, transform: `translate(${now.x}px, ${now.y}px)` },
						],
						motion,
					);
					continue;
				}
				if (Math.abs(was.x - now.x) > 0.5 || Math.abs(was.y - now.y) > 0.5)
					node.animate(
						[
							{ transform: `translate(${was.x}px, ${was.y}px)` },
							{ transform: `translate(${now.x}px, ${now.y}px)` },
						],
						motion,
					);
				if (was.w === now.w && was.h === now.h) continue;
				node.querySelector(":scope > rect.outline")?.animate(
					[
						{ width: `${was.w}px`, height: `${was.h}px` },
						{ width: `${now.w}px`, height: `${now.h}px` },
					],
					motion,
				);
				// Old content fades out while the new fades in, so the card is never an empty box.
				for (const child of node.children)
					if (!child.matches("rect.outline, title"))
						child.animate(
							[{ opacity: 0 }, { opacity: 0, offset: 0.15 }, { opacity: 1 }],
							motion,
						);
				const ghost = staleCopy(was.content);
				if (ghost) {
					node.insertBefore(
						ghost,
						node.querySelector(":scope > rect.outline")?.nextSibling ?? null,
					);
					ghost.animate(
						[{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }],
						motion,
					).onfinish = () => ghost.remove();
				}
			}
			// Cards and edges that are gone fade out where they were (a hidden code step, a group
			// that split) instead of vanishing.
			const leave = (element, layer) => {
				const copy = exitCopy(element);
				layer.append(copy);
				copy.animate([{ opacity: 1 }, { opacity: 0 }], {
					duration: MOTION.base,
					easing: "ease-out",
					fill: "forwards",
				}).onfinish = () => copy.remove();
			};
			for (const [id, was] of previous.nodes)
				if (!positions.has(id) && was.element) leave(was.element, nodes);
			for (const [id, link] of previous.links ?? [])
				if (!edges.querySelector(`path.edge[data-edge="${CSS.escape(id)}"]`))
					leave(link, edges);
			const shape = (value) => value?.replace(/[-\d.e]+/g, "#");
			for (const path of edges.querySelectorAll("path.edge[data-edge]")) {
				const was = previous.edges.get(path.dataset.edge),
					d = path.getAttribute("d"),
					link = path.closest(".link");
				if (was === d || path.closest(".morph-old")) continue;
				if (was && shape(was) === shape(d)) {
					// Same path shape: bend from the old path to the new one.
					path.animate(
						[{ d: `path("${was}")` }, { d: `path("${d}")` }],
						motion,
					);
					for (const child of link?.children ?? [])
						if (child !== path)
							child.animate(
								[{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }],
								motion,
							);
				} else
					link?.animate(
						[{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }],
						motion,
					);
			}
		});
	}
	function refreshSettings() {
		if (!preview) return;
		for (const text of nodes.querySelectorAll("[data-stage-line]")) {
			const stage = model.stages.get(text.dataset.stageLine);
			if (stage) {
				text.dataset.full = lineFor(stage);
				text.textContent = text.dataset.full;
			}
		}
		const selected = selectedId();
		const owner = model.owner.get(selected) || selected;
		const related = preview.related();
		for (const node of nodes.querySelectorAll(":scope > .node")) {
			const stage = model.nodes.get(node.dataset.stage);
			node.classList.toggle("selected", node.dataset.stage === owner);
			node.classList.toggle(
				"shared-setting",
				stage.kind === "group"
					? stage.members.some((member) => related.has(member.id))
					: related.has(stage.id),
			);
			if (stage.kind !== "group") {
				node.setAttribute("aria-label", `${stage.id}, ${lineFor(stage)}`);
				// The graph is the only task picker, so its selection must be announced.
				node.setAttribute(
					"aria-pressed",
					String(node.dataset.stage === selected),
				);
			}
		}
		for (const row of nodes.querySelectorAll(".stage-row")) {
			row.classList.toggle("selected", row.dataset.stage === selected);
			row.setAttribute("aria-pressed", String(row.dataset.stage === selected));
			row.classList.toggle(
				"shared-setting",
				row.dataset.stage !== selected && related.has(row.dataset.stage),
			);
			row.setAttribute(
				"aria-label",
				`${row.dataset.stage}, ${lineFor(model.stages.get(row.dataset.stage))}`,
			);
		}
		if (wrap.isConnected && wrap.clientWidth) apply();
	}
	const control = {
		destroy: () => {
			disposed = true;
			observer.disconnect();
			for (const animation of packets) animation.cancel();
		},
		fit,
		reveal,
		handoff,
		morph,
		refresh: refreshSettings,
	};
	if (preview) {
		refreshSettings();
		preview.control(control);
	} else graphControl = control;
	return shell;
}
/** An inert, display-only copy of a card's previous content (no focus, events or hooks). */
function staleCopy(children) {
	if (!children?.length) return null;
	const group = svg("g", { class: "morph-old", "aria-hidden": "true" });
	for (const child of children) group.append(child.cloneNode(true));
	for (const el of [group, ...group.querySelectorAll("*")]) {
		for (const name of [...el.getAttributeNames()])
			if (/^(?:id|tabindex|role|data-.*|aria-(?!hidden).*)$/.test(name))
				el.removeAttribute(name);
		el.classList?.remove("agent-row", "stage-row");
	}
	group.querySelectorAll("title, foreignObject").forEach((el) => el.remove());
	return group;
}
/** An inert copy of a card or edge that is leaving the graph, faded out where it was. */
function exitCopy(element) {
	const copy = element.cloneNode(true);
	for (const el of [copy, ...copy.querySelectorAll("*")]) {
		for (const name of [...el.getAttributeNames()])
			if (/^(?:id|tabindex|role|data-.*|aria-(?!hidden).*)$/.test(name))
				el.removeAttribute(name);
		el.classList?.remove("selected", "lit", "next", "agent-row", "stage-row");
	}
	copy.classList.add("morph-old", "leaving");
	copy.setAttribute("aria-hidden", "true");
	copy.querySelectorAll("title, foreignObject").forEach((el) => el.remove());
	return copy;
}
/** Card boxes and edge paths of the drawn graph (user units), for a morphing redraw. */
function graphGeometry() {
	const canvas = $("canvas");
	if (!canvas) return null;
	const nodes = new Map(),
		edges = new Map();
	for (const node of canvas.querySelectorAll(".node[data-stage]")) {
		const at = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(
			node.getAttribute("transform") || "",
		);
		const outline = node.querySelector(":scope > rect.outline");
		if (at && outline)
			nodes.set(node.dataset.stage, {
				x: Number(at[1]),
				y: Number(at[2]),
				w: Number(outline.getAttribute("width")),
				h: Number(outline.getAttribute("height")),
				content: [...node.children].filter(
					(child) => !child.matches("rect.outline, title"),
				),
				element: node,
			});
	}
	const links = new Map();
	for (const path of canvas.querySelectorAll("path.edge[data-edge]")) {
		edges.set(path.dataset.edge, path.getAttribute("d"));
		if (path.closest(".link"))
			links.set(path.dataset.edge, path.closest(".link"));
	}
	const view = canvas.querySelector("svg.graph > g")?.getAttribute("transform");
	return { nodes, edges, links, view };
}
function agentState(task) {
	if (task.blockedActions?.count)
		return `⚠ ${task.blockedActions.count} blocked`;
	return taskState(task) === "retry"
		? task.retry?.nextRetryAt
			? `retry in ${countdown(task.retry.nextRetryAt)}`
			: "waiting to retry"
		: task.status === "completed"
			? "done"
			: (labels[task.status] || "Waiting").toLowerCase();
}
/** The graph's code-step switch: off by default, remembered in this browser. */
const CODE_KEY = "agent-workflow:code-steps";
let showCode = (() => {
	try {
		return localStorage.getItem(CODE_KEY) === "shown";
	} catch {
		return false;
	}
})();
/** The run's views: the graph top-down or left-right, or the timeline (2026-11-12). */
function viewButtons() {
	return [
		["td", "Top-down"],
		["lr", "Left-right"],
		["timeline", "Timeline"],
	].map(([layout, name]) =>
		button(markIcon(layout), () => changeLayout(layout), {
			"aria-label": name,
			title: name,
			"aria-pressed": String(state.layout === layout),
		}),
	);
}
/** "0s", "45s", "1m", "1m 30s", "1h", "1h 05m": a mark on the timeline's axis. */
function tickLabel(seconds) {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60),
		rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
	const left = minutes % 60;
	return `${Math.floor(minutes / 60)}h${left ? ` ${String(left).padStart(2, "0")}m` : ""}`;
}
const TICK_STEPS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200,
];
/**
 * The timeline's rows (2026-11-12, owner: "실행 타임라인"): each stage, then, for a stage of
 * several agents, each agent. `span` is [start, end] in ms from the run's start (a task still
 * at work ends at `until`); null when it has not started. `cost` is null when no task of the
 * row reported one, never 0.
 */
export function timelineRows(projection, stages, until) {
	const t0 = date(projection.createdAt);
	const spanOf = (task) => {
		const start = date(task.startedAt);
		// A launch claim can stamp a start on a task still waiting: it has not run yet.
		if (!start || task.status === "pending") return null;
		const end =
			date(task.completedAt) ||
			(!["completed", "failed", "interrupted", "skipped"].includes(task.status)
				? until
				: task.elapsedMs != null
					? start + task.elapsedMs
					: start);
		return [start - t0, Math.max(start, end) - t0];
	};
	// 2026-11-12 (owner): code steps never report cost, so the ratio counts agents only.
	const costOf = (tasks) => {
		const known = tasks.filter((task) => task.usage?.costUsd != null);
		const agents = tasks.filter(
			(task) => !["support", "dynamic", "loop"].includes(task.kind),
		);
		return known.length
			? {
					usd: known.reduce((sum, task) => sum + task.usage.costUsd, 0),
					of: agents.filter((task) => task.usage?.costUsd != null).length,
					tasks: agents.length,
				}
			: null;
	};
	const rows = [];
	for (const stage of stages) {
		const tasks = stage.tasks.filter((task) => !task.placeholder);
		const spans = tasks.map(spanOf).filter(Boolean);
		const span = spans.length
			? [
					Math.min(...spans.map((each) => each[0])),
					Math.max(...spans.map((each) => each[1])),
				]
			: null;
		rows.push({ stage, span, status: stage.status, cost: costOf(tasks) });
		if (stage.items.length > 1)
			for (const task of stage.items)
				rows.push({
					stage,
					task,
					span: spanOf(task),
					status: taskState(task),
					cost: costOf([task]),
					stageStart: span?.[0],
				});
	}
	return rows;
}
function renderTimeline() {
	const t0 = date(run.createdAt);
	const until = liveRun(run) ? now() : Math.max(date(run.updatedAt), t0);
	const rows = timelineRows(run, [...graphModel.stages.values()], until);
	const total = Math.max(
		1000,
		until - t0,
		...rows.map((row) => row.span?.[1] ?? 0),
	);
	const step =
		TICK_STEPS.find((each) => total / 1000 / each <= 6) ?? TICK_STEPS.at(-1);
	const ticks = [];
	for (let at = 0; at * 1000 <= total; at += step) ticks.push(at);
	const at = (ms) => `${((ms / total) * 100).toFixed(3)}%`;
	const money = (value) =>
		value == null
			? "n/a"
			: `$${value.usd.toFixed(value.usd < 0.1 ? 4 : 2)}${value.of < value.tasks ? "+" : ""}`;
	const axis = svg("svg", { class: "tl-axis", "aria-hidden": "true" });
	for (const tick of ticks)
		axis.append(
			svg(
				"text",
				{
					x: at(tick * 1000),
					y: 20,
					"text-anchor": tick === 0 ? "start" : "middle",
				},
				tickLabel(tick),
			),
		);
	const list = element(
		"div",
		{ class: "tl-scroll" },
		element(
			"div",
			{ class: "tl-head" },
			element("span", {}, "Stage"),
			axis,
			element("span", { class: "num" }, "Time"),
			element("span", { class: "num tl-cost" }, "Cost"),
		),
	);
	for (const row of rows) {
		const { stage, task, span } = row;
		const code = stage.kind === "support";
		const lane = svg("svg", { class: "tl-lane", "aria-hidden": "true" });
		for (const tick of ticks)
			lane.append(
				svg("line", {
					class: "tl-grid",
					x1: at(tick * 1000),
					x2: at(tick * 1000),
					y1: 0,
					y2: "100%",
				}),
			);
		// An agent that started after its stage did: the wait is drawn dotted.
		if (
			task &&
			span &&
			row.stageStart != null &&
			span[0] - row.stageStart >= Math.max(5000, total * 0.03)
		)
			lane.append(
				svg("line", {
					class: "tl-wait",
					x1: at(row.stageStart),
					x2: at(span[0]),
					y1: 16,
					y2: 16,
				}),
			);
		if (span)
			lane.append(
				svg("rect", {
					class: `tl-bar ${row.status}${code ? " code" : ""}`,
					x: at(span[0]),
					width: at(span[1] - span[0]),
					y: code ? 14 : 11,
					height: code ? 4 : 10,
					rx: code ? 2 : 3,
				}),
			);
		const name = task
			? task.title || task.specId.slice(stage.id.length + 1) || task.specId
			: humanize(stage.short || stage.name || stage.id);
		const took = span ? duration(span[1] - span[0]) : "";
		const key = task ? `task:${task.specId}` : `stage:${stage.id}`;
		list.append(
			button(
				[
					element(
						"span",
						{ class: "tl-name" },
						glyph(row.status),
						code && !task ? kindIcon("code") : null,
						element("span", { class: "tl-label", title: name }, name),
						!task && stage.items.length > 1
							? element("span", { class: "tl-count" }, `×${stage.items.length}`)
							: null,
					),
					lane,
					element("span", { class: "num" }, took),
					element(
						"span",
						{
							class: "num tl-cost",
							title:
								row.cost && row.cost.of < row.cost.tasks
									? `${row.cost.of} of ${row.cost.tasks} reported a cost`
									: null,
						},
						money(row.cost),
					),
				],
				() => (task ? go({ task: task.specId }) : chooseStage(stage)),
				{
					class: `tl-row${task ? " tl-child" : ""}${span ? "" : " tl-waiting"}`,
					"data-row": key,
					"aria-label": `${name}, ${labels[row.status] || "Waiting"}${took ? `, ${took}` : ""}${row.cost ? `, ${money(row.cost)}` : ""}`,
				},
			),
		);
	}
	list.append(
		element(
			"p",
			{ class: "tl-note" },
			"From the run's start. A dotted line is an agent that started after its stage did. n/a means not reported.",
		),
	);
	return element(
		"div",
		{
			class: "timeline",
			id: "timeline",
			role: "region",
			"aria-label": `Timeline of ${run.name}`,
		},
		list,
		element(
			"div",
			{ class: "toolbar", role: "toolbar", "aria-label": "Run view" },
			...viewButtons(),
		),
	);
}
/** The timeline row of the open stage or agent is marked current. */
function markTimelineSelection() {
	const task = selectedTask()?.specId;
	const key = task ? `task:${task}` : state.stage ? `stage:${state.stage}` : "";
	for (const row of document.querySelectorAll(".tl-row"))
		if (row.dataset.row === key) row.setAttribute("aria-current", "true");
		else row.removeAttribute("aria-current");
}
/** Redraw the timeline in place (a live run's bars grow), keeping its scroll and focus. */
function refreshTimeline() {
	const current = $("timeline");
	if (!current) return;
	const scroll = current.querySelector(".tl-scroll")?.scrollTop ?? 0;
	const focused = document.activeElement?.closest(".tl-row")?.dataset.row;
	const next = renderTimeline();
	current.replaceWith(next);
	next.querySelector(".tl-scroll").scrollTop = scroll;
	markTimelineSelection();
	if (focused)
		next
			.querySelector(`[data-row="${CSS.escape(focused)}"]`)
			?.focus({ preventScroll: true });
}
function toggleCode() {
	showCode = !showCode;
	if (
		!showCode &&
		selectedStage() &&
		!deriveGraph(run, { hideCode: true }).nodes.has(selectedStage())
	)
		go({ stage: null, task: null });
	try {
		if (showCode) localStorage.setItem(CODE_KEY, "shown");
		else localStorage.removeItem(CODE_KEY);
	} catch {}
	renderRun();
	$("canvas")?.querySelector(".code-switch")?.focus();
}
function changeLayout(layout) {
	state.layout = layout;
	urlState();
	renderRun();
}
/**
 * Everything that decides the graph's DOM: layout, each card's status/shape/rows, each edge's
 * state. While it is unchanged, a run update keeps the drawn graph (its flow animation keeps
 * its phase, hover/focus survive) and only the header and the live texts change.
 */
function stageBlockedCount(stage) {
	return (
		stage.kind === "group"
			? stage.members.flatMap((member) => member.tasks)
			: stage.tasks || []
	).reduce((sum, task) => sum + (task.blockedActions?.count || 0), 0);
}
function graphSignature(model, layout) {
	return JSON.stringify([
		layout,
		showCode,
		[...model.nodes.values()].map((node) => [
			node.id,
			node.status,
			nextStage(node),
			nodeHeight(node),
			node.done,
			node.items[0]?.outcome?.tone,
			stageBlockedCount(node),
			node.kind === "group"
				? node.members.map((m) => [m.id, m.status])
				: node.items.map((t) => [
						t.specId,
						taskState(t),
						t.outcome?.tone,
						t.outcome?.status,
						t.title,
					]),
		]),
		model.edges.map((edge) => `${edge.from}>${edge.to}`),
	]);
}
function renderRun() {
	const active = document.activeElement;
	const focusStage = active?.closest(".node")?.dataset.stage,
		focusTask = active?.closest(".agent-row")?.dataset.task,
		focusMember = active?.closest(".stage-row")?.dataset.stage;
	const headerKey = (node) =>
		node.dataset.action || node.getAttribute("aria-label") || node.textContent;
	const focusedHeader = active?.matches("#run-header button")
		? headerKey(active)
		: null;
	graphModel = deriveGraph(run, {
		hideCode: !showCode,
		keep: selectedStage(),
	});
	if (state.view === "report") {
		renderReportPage();
		renderSelection();
		renderModal();
		return;
	}
	const signature = graphSignature(graphModel, state.layout);
	const canvas = $("canvas");
	const keepGraph =
		canvas &&
		graphControl?.signature === signature &&
		graphControl.runId === run.runId;
	if (state.layout === "timeline") {
		// The timeline instead of the graph (2026-11-12): redrawn in place, keeping its scroll.
		graphControl?.destroy();
		graphControl = null;
		if ($("timeline")) {
			for (const child of [...$("center").children])
				if (child.id !== "timeline") child.remove();
			$("center").prepend(renderHeader());
			refreshTimeline();
		} else $("center").replaceChildren(renderHeader(), renderTimeline());
	} else if (keepGraph) {
		// The canvas stays in place (removing and re-adding it would restart its animations).
		for (const child of [...$("center").children])
			if (child !== canvas) child.remove();
		$("center").prepend(renderHeader());
		refreshGraphTexts();
	} else {
		// A status change that reshapes the graph (a card collapses, rows appear) moves the cards
		// from where they were instead of jumping: remember the drawn boxes before replacing them.
		const previous =
			canvas && graphControl?.runId === run.runId ? graphGeometry() : null;
		$("center").replaceChildren(renderHeader());
		$("center").append(renderGraph());
		graphControl.signature = signature;
		graphControl.runId = run.runId;
		if (previous) graphControl.morph(previous);
	}
	renderSelection();
	renderModal();
	if (focusedHeader)
		[...document.querySelectorAll("#run-header button:not(:disabled)")]
			.find((node) => headerKey(node) === focusedHeader)
			?.focus({ preventScroll: true });
	if (focusTask)
		document
			.querySelector(`[data-task="${CSS.escape(focusTask)}"]`)
			?.focus({ preventScroll: true });
	else if (focusMember)
		document
			.querySelector(`.stage-row[data-stage="${CSS.escape(focusMember)}"]`)
			?.focus({ preventScroll: true });
	else if (focusStage)
		document
			.querySelector(`[data-stage="${CSS.escape(focusStage)}"]`)
			?.focus({ preventScroll: true });
}
function inspectorHeader(name, status, children = []) {
	return element(
		"div",
		{ class: "inspector-head" },
		element(
			"div",
			{ class: "row" },
			status ? glyph(status) : null,
			element("h2", { class: "grow" }, name),
			button("×", closeInspector, {
				class: "close",
				"aria-label": "Close inspector",
			}),
		),
		children,
	);
}
function closeInspector() {
	const id = selectedStage();
	go({ task: null, stage: null, view: null });
	if (id)
		document
			.querySelector(`[data-stage="${CSS.escape(id)}"]`)
			?.focus({ preventScroll: true });
}
function definition(rows) {
	return element(
		"dl",
		{},
		rows
			.filter((row) => row && row[1] != null)
			.map(([label, value]) => [
				element("dt", {}, label),
				element("dd", {}, value),
			]),
	);
}
function usageRows(usage, agents) {
	// "Total tokens" only when the executor reported a total; a missing total next to reported
	// input/output counts is "not reported", not "not collected".
	const reportedParts = usage?.input != null || usage?.output != null;
	return [
		["Cost", cost(usage)],
		[
			"Total tokens",
			usage?.total != null
				? usage.total.toLocaleString()
				: reportedParts
					? "Not reported"
					: "Not collected",
		],
		usage?.input != null
			? ["Input tokens", usage.input.toLocaleString()]
			: null,
		usage?.output != null
			? ["Output tokens", usage.output.toLocaleString()]
			: null,
		usage?.cacheRead != null
			? ["Cached input tokens", usage.cacheRead.toLocaleString()]
			: null,
		// 2026-11-12 (owner): code steps never report cost, so the ratio counts agents only.
		agents
			? [
					"Coverage",
					`${agents.agentsReporting} / ${agents.agentTotal} agents reporting`,
				]
			: usage?.tasksReporting != null
				? [
						"Coverage",
						`${usage.tasksReporting} / ${usage.taskCount} tasks reporting`,
					]
				: null,
		usage?.note ? ["Note", usage.note] : null,
	];
}
function commandBlock(command) {
	return element(
		"div",
		{ class: "command" },
		element("pre", {}, command),
		button("Copy", () => copy(command)),
	);
}
const shellArg = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
/** No task is shown: its log and result requests stop. */
function stopTaskLoads() {
	logController?.abort();
	logGeneration++;
	logKey = "";
	logLoading = false;
	resultController?.abort();
	resultGeneration++;
	resultKey = "";
	resultLoading = false;
}
function blockedChip(blocked) {
	return blocked?.count
		? element(
				"span",
				{ class: "incomplete blocked-actions-chip" },
				`⚠ ${blocked.count} action${blocked.count === 1 ? "" : "s"} blocked`,
			)
		: null;
}
function blockedSamples(task) {
	if (!task.blockedActions?.count) return null;
	return element(
		"div",
		{ class: "details-section blocked-actions" },
		element("h3", {}, `${task.specId}: blocked actions`),
		blockedChip(task.blockedActions),
		(task.blockedActions.samples || []).map((sample) =>
			element(
				"p",
				{},
				`${sample.tool}${sample.command ? `: ${sample.command}` : ""}, ${sample.reason}${sample.source ? ` (${sample.source} policy)` : " (source unknown)"}`,
			),
		),
		commandBlock(
			`agent-workflow logs ${shellArg(run.runId)} --task ${shellArg(task.taskId)} --stream events`,
		),
	);
}
function renderSelection() {
	// The first drawing of a page puts the panels in place; only later changes move.
	if (!document.body.dataset.ready)
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				document.body.dataset.ready = "1";
			}),
		);
	if (!run) return;
	const selected = selectedTask(),
		selectedGroup = graphModel?.stages.get(selected?.stageId),
		task = emptyForeach(selectedGroup) ? null : selected,
		stage =
			graphModel?.stages.get(state.stage) ||
			(emptyForeach(selectedGroup) ? selectedGroup : null);
	const visible =
		state.view !== "report" && (!!task || !!stage || state.view === "details");
	const inspector = $("inspector"),
		key = `${run.runId}:${state.task}:${state.stage}:${state.view}`;
	const same = inspector.dataset.key === key,
		scroll = same ? inspector.scrollTop : 0;
	const previousItems = same ? itemPositions(inspector) : new Map();
	const focusedItem = same
		? document.activeElement?.closest("[data-item]")?.dataset.item
		: null;
	const focusedFilter = same
		? document.activeElement?.closest("[data-filter]")?.dataset.filter
		: null;
	const detailsOpen = same && inspector.querySelector("details")?.open;
	const logScroll = same ? inspector.querySelector(".log")?.scrollTop || 0 : 0;
	const focusedField =
		same &&
		inspector.contains(document.activeElement) &&
		document.activeElement.matches("input,select")
			? {
					label: document.activeElement.getAttribute("aria-label"),
					start: document.activeElement.selectionStart,
					end: document.activeElement.selectionEnd,
				}
			: null;
	const focusedTab = inspector.contains(document.activeElement)
		? document.activeElement?.dataset.tab
		: null;
	// The inspector opens and closes like the rail: its column grows or narrows (CSS). Closing
	// keeps its last content while it fades; a new subject in an open inspector slides in.
	const swapped = !same && visible && !inspector.hidden;
	inspector.dataset.key = key;
	inspector.hidden = !visible;
	inspector.inert = !visible;
	$("body").classList.toggle("inspecting", visible);
	applyRail();
	for (const node of $("canvas")?.querySelectorAll(".node") || [])
		node.classList.toggle(
			"selected",
			node.dataset.stage === selectedStage() ||
				(node.dataset.members?.split(",") ?? []).includes(selectedStage()),
		);
	for (const row of $("canvas")?.querySelectorAll(".stage-row") || [])
		row.classList.toggle("selected", row.dataset.stage === selectedStage());
	markTimelineSelection();
	if (!visible) return stopTaskLoads();
	if (swapped && !reducedMotion())
		inspector.animate(
			[
				{ opacity: 0, transform: "translateX(8px)" },
				{ opacity: 1, transform: "none" },
			],
			{ duration: MOTION.base, easing: MOTION.ease },
		);
	inspector.replaceChildren();
	if (state.view === "details") {
		inspector.append(
			inspectorHeader("Run details"),
			element(
				"div",
				{ class: "details-section" },
				element("h3", {}, "Task"),
				element("p", {}, run.task || "No task text collected"),
				...(run.launch?.command?.trim()
					? [
							element("h3", {}, "Launch command"),
							commandBlock(run.launch.command),
						]
					: []),
				definition([
					["Host", run.launch?.host || run.host || "Not collected"],
					["Permission mode", run.permissionMode || "Not collected"],
					...usageRows(run.usage, run.cost),
				]),
			),
		);
		inspector.append(
			element(
				"section",
				{ class: "details-section", "data-testid": "captured-run-plan" },
				element("h3", {}, "Captured requested/resolved plan"),
				element(
					"p",
					{},
					"Recorded launch-time plan, not today's settings or provider-observed execution.",
				),
				run.configuration
					? readableDiagnostic(run.configuration)
					: element("p", {}, "Unknown: no captured configuration recorded."),
			),
		);
		for (const affected of run.tasks.filter(
			(task) => task.blockedActions?.count,
		))
			inspector.append(blockedSamples(affected));
	} else if (task) {
		const status = taskState(task);
		const name =
			task.kind === "foreach"
				? task.specId.slice(task.stageId.length + 1)
				: task.specId;
		const reasons = {
			executor_needs_decision:
				"The executor could not confirm whether the earlier attempt ran; review before resuming.",
		};
		const reason =
			task.retry?.reason ||
			reasons[task.statusDetail] ||
			(["failed", "interrupted", "blocked"].includes(status)
				? task.lastMessage ||
					"Cause not recorded. Inspect the logs and stopped work before resuming."
				: null);
		const executorLine =
			task.kind === "support"
				? "Code step · no model call"
				: `Executor: ${task.executor || run.executor || "unknown"}, Recorded model: ${task.model || "unknown"}, Executor-reported model: ${task.reportedModel || "unknown / not reported"}, Recorded effort: ${task.effort || "unknown"}`;
		inspector.append(
			...[siblingNav(task)].filter(Boolean),
			inspectorHeader(task.title || name, status, [
				taskAnnotation(task),
				blockedChip(task.blockedActions),
				element(
					"p",
					{ class: "task-status", id: "task-status" },
					taskLine(task),
				),
				reason ? element("p", { class: "task-reason" }, reason) : null,
				executorLine
					? element("p", { class: "executor-line" }, executorLine)
					: null,
			]),
		);
		if (reasons[task.statusDetail])
			inspector.append(
				element(
					"div",
					{ class: "details-section" },
					actionButton("Review & resume…", "resume"),
				),
			);
		if (task.blockedActions?.count) inspector.append(blockedSamples(task));
		const tab = state.tab || defaultTaskTab(task);
		// Another tab of the same task: its panel fades in (live updates of a tab do not).
		const tabSwapped =
			same && inspector.dataset.panel && inspector.dataset.panel !== tab;
		inspector.dataset.panel = tab;
		inspector.append(
			element(
				"div",
				{ class: "tabs", role: "tablist", "aria-label": "Task logs" },
				TASK_TABS.map((stream) =>
					button(
						stream[0].toUpperCase() + stream.slice(1),
						() => go({ tab: stream }),
						{
							role: "tab",
							id: `tab-${stream}`,
							"data-tab": stream,
							"aria-selected": String(tab === stream),
							"aria-controls": "log-panel",
							tabindex: tab === stream ? "0" : "-1",
							onkeydown: (event) => {
								if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
									event.preventDefault();
									const tabs = TASK_TABS;
									go({
										tab: tabs[
											(tabs.indexOf(stream) +
												(event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
												tabs.length
										],
									});
									document.querySelector(`[data-tab="${state.tab}"]`)?.focus();
								}
							},
						},
					),
				),
			),
		);
		inspector.append(
			element(
				"div",
				{
					class: `output${tabSwapped ? " swap" : ""}`,
					id: "log-panel",
					role: "tabpanel",
					"aria-labelledby": `tab-${tab}`,
				},
				element(
					"div",
					{ class: "output-label" },
					"untrusted output",
					button("Copy", () => copy(logText(tab))),
				),
				element("div", {
					class: "task-result",
					id: "result-view",
					tabindex: "0",
					hidden: tab !== "result" ? "" : null,
				}),
				element("pre", {
					class: "log",
					id: "log-text",
					tabindex: "0",
					hidden: tab === "result" ? "" : null,
				}),
				element("p", { class: "log-notice", id: "log-notice" }),
			),
		);
		const details = element(
			"details",
			{ class: "task-details" },
			element("summary", {}, "Details"),
			definition([
				["Task", task.specId],
				task.agent ? ["Agent", task.agent] : null,
				task.retry
					? [
							"Attempts",
							`Attempt ${task.retry.attempt}${task.retry.maxAttempts ? ` of ${task.retry.maxAttempts}` : ""}${task.retry.nextRetryAt ? `, scheduled ${task.retry.nextRetryAt}` : ""}`,
						]
					: null,
				["Started", task.startedAt || "Not started"],
				task.completedAt ? ["Ended", task.completedAt] : null,
				...usageRows(task.usage),
				["Depends on", task.dependsOn?.join(", ") || "None"],
				task.worktree
					? [
							"Worktree",
							[task.worktree.branch, task.worktree.path]
								.filter(Boolean)
								.join(", ") || "Not collected",
						]
					: null,
			]),
			element("h3", {}, "Logs in terminal"),
			commandBlock(
				`agent-workflow logs ${shellArg(run.runId)} --task ${shellArg(task.specId)} --stream ${tab === "result" ? "output" : tab}`,
			),
		);
		details.open = !!detailsOpen;
		inspector.append(details);
		const key = `${run.runId}:${task.taskId}`;
		if (key !== logKey) {
			logKey = key;
			logData = null;
			logError = "";
			loadLogs();
		}
		const resultStamp = `${key}:${taskState(task)}`;
		if (tab === "result" && resultStamp !== resultKey) {
			resultKey = resultStamp;
			resultData = null;
			resultError = "";
			loadResult();
		}
		paintLogs();
	} else if (stage) renderItems(inspector, stage, previousItems);
	if (!task) stopTaskLoads();
	inspector.scrollTop = scroll;
	if (inspector.querySelector(".log"))
		inspector.querySelector(".log").scrollTop = logScroll;
	if (focusedField) {
		const field = inspector.querySelector(
			`[aria-label="${CSS.escape(focusedField.label)}"]`,
		);
		field?.focus({ preventScroll: true });
		if (field?.setSelectionRange && focusedField.start != null)
			field.setSelectionRange(focusedField.start, focusedField.end);
	}
	if (focusedFilter)
		inspector
			.querySelector(`[data-filter="${CSS.escape(focusedFilter)}"]`)
			?.focus({ preventScroll: true });
	if (focusedItem)
		inspector
			.querySelector(`[data-item="${CSS.escape(focusedItem)}"]`)
			?.focus({ preventScroll: true });
	if (focusedTab)
		document
			.querySelector(`[data-tab="${CSS.escape(focusedTab)}"]`)
			?.focus({ preventScroll: true });
}
// Activity is optional until the runtime branch supplies it; text always enters as text nodes.
function taskAnnotation(task) {
	if (task.status === "running")
		return element(
			"div",
			{ class: "agent-sub activity", "data-activity": task.specId },
			element("span", {}, task.activity?.label || "Starting…"),
		);
	if (task.status === "failed")
		return element(
			"div",
			{ class: "agent-sub tone-err" },
			task.lastMessage || task.statusDetail || "A task failed.",
		);
	if (task.status === "completed" && task.outcome)
		return element(
			"div",
			{ class: "agent-sub outcome" },
			element(
				"b",
				{ class: `tone-${task.outcome.tone}` },
				humanize(
					task.outcome.status ||
						(task.outcome.tone === "ok"
							? "Done"
							: task.outcome.tone === "warn"
								? "Needs a look"
								: "Couldn't check"),
				),
			),
			task.outcome.text ? `: ${task.outcome.text}` : null,
		);
	if (taskState(task) === "retry")
		return element("div", { class: "agent-sub" }, taskLine(task));
	if (task.status === "blocked")
		return element(
			"div",
			{ class: "agent-sub tone-warn" },
			task.lastMessage || "Needs you",
		);
	return null;
}
const itemFilters = new Map();
const itemGroup = (task) =>
	task.status === "running"
		? "running"
		: ["failed", "blocked", "interrupted"].includes(task.status) ||
				(task.status === "completed" &&
					["warn", "err"].includes(task.outcome?.tone))
			? "look"
			: ["completed", "skipped"].includes(task.status)
				? "done"
				: "waiting";
function itemTime(task) {
	if (task.status === "running")
		return task.startedAt
			? `${Math.max(0, Math.floor((now() - date(task.startedAt)) / 1000))}s`
			: "0s";
	if (!["completed", "failed", "interrupted", "skipped"].includes(task.status))
		return "";
	const ms =
		task.elapsedMs ??
		(task.startedAt && task.completedAt
			? date(task.completedAt) - date(task.startedAt)
			: undefined);
	return ms == null ? "" : `${Math.max(0, Math.round(ms / 1000))}s`;
}
function itemPositions(inspector) {
	return new Map(
		[...inspector.querySelectorAll("[data-item]")].map((row) => [
			row.dataset.item,
			{ top: row.getBoundingClientRect().top, group: row.dataset.rowGroup },
		]),
	);
}
/**
 * A stage's agents open in place (2026-11-03, owner's pick after comparing tabs, a list beside the
 * detail, and expanding in place on real runs): a row expands to show that agent's result — the
 * digest and the analysis as text-only Markdown — or, before it finishes, its state; "Open agent ›"
 * leads to the full view (logs, events, details). Open rows survive live updates; results are
 * fetched once per agent state.
 */
const expandedItems = new Set();
let justExpanded = null; // the row opened by this click: only its result animates in
const itemResults = new Map();
function itemResult(task) {
	const key = `${run.runId}:${task.taskId}:${task.status}:${task.attempt ?? ""}`;
	if (!itemResults.has(key))
		itemResults.set(
			key,
			api(
				`/api/runs/${encodeURIComponent(run.runId)}/tasks/${encodeURIComponent(task.taskId)}/result`,
				{ signal: AbortSignal.timeout(20000) },
			).then(
				(data) => ({ data: Object.keys(data || {}).length ? data : null }),
				(error) => {
					itemResults.delete(key);
					return { error: `Result unavailable: ${error.message}` };
				},
			),
		);
	return itemResults.get(key);
}
function itemExpansion(task, id, entering = false, variant = "") {
	const open = button(
		task.kind === "support" ? "Open task ›" : "Open agent ›",
		() => go({ task: task.specId }),
		{
			class: "item-open",
		},
	);
	const body = element("div", {
		class: `item-expand${entering ? " entering" : ""}${variant ? ` ${variant}` : ""}`,
		id,
		role: "region",
		"aria-label": `Result of ${task.title || task.specId}`,
	});
	if (taskState(task) !== "completed") {
		body.append(
			element(
				"p",
				{ class: "muted" },
				task.status === "failed"
					? task.lastMessage || "A task failed. Open the agent for its logs."
					: `${taskLine(task)}, no result yet.`,
			),
			open,
		);
		return body;
	}
	body.append(element("p", { class: "muted" }, "Loading…"));
	itemResult(task).then(({ data, error }) => {
		if (!body.isConnected) return;
		const parts = [];
		if (error) parts.push(element("p", { class: "muted" }, error));
		else if (!data)
			parts.push(
				element("p", { class: "muted" }, "No result files for this task."),
			);
		else {
			if (data.digest)
				parts.push(element("p", { class: "result-digest" }, data.digest));
			if (data.analysis) {
				const analysis = element("div", { class: "result-analysis" });
				renderTextMarkdown(analysis, data.analysis);
				parts.push(analysis);
			}
		}
		body.replaceChildren(...parts, open);
	});
	return body;
}
const ITEM_GROUPS = [
	["running", "Running"],
	["look", "Needs a look"],
	["waiting", "Waiting"],
	["done", "Done"],
];
/** The stage's agents in the order its list shows them: the list's filter, then its groups. */
function listedItems(stage, ignoreFilter = false) {
	const filter = ignoreFilter
		? { query: "", status: "all" }
		: itemFilters.get(`${run.runId}:${stage.id}`) || {
				query: "",
				status: "all",
			};
	const query = filter.query.toLowerCase();
	const matches = stage.items.filter(
		(task) =>
			`${task.specId} ${task.title || ""}`.toLowerCase().includes(query) &&
			(filter.status === "all" || taskState(task) === filter.status),
	);
	return ITEM_GROUPS.flatMap(([group]) =>
		matches.filter((task) => itemGroup(task) === group),
	);
}
/**
 * An agent of a many-agent stage gets a way back to the list and to its neighbours (2026-11-03,
 * owner: open, back, open, back was tedious). ‹ / › and the j / k keys follow the list's order
 * and filter and replace the history entry, so the browser's Back still returns to the list.
 */
function siblingNav(task) {
	const stage = graphModel?.stages.get(task.stageId);
	if (!stage?.items || stage.items.length < 2) return null;
	let order = listedItems(stage);
	if (!order.some((item) => item.specId === task.specId))
		order = listedItems(stage, true);
	const index = order.findIndex((item) => item.specId === task.specId);
	if (index < 0) return null;
	const step = (delta, nav) => () => {
		const next = order[index + delta];
		if (!next) return;
		go({ task: next.specId }, true);
		$("inspector").querySelector(`[data-nav="${nav}"]`)?.focus();
	};
	return element(
		"nav",
		{ class: "item-nav", "aria-label": "Agents in this stage" },
		button(
			`‹ ${humanize(stage.id)}, ${stage.items.length} agents`,
			() => go({ stage: stage.id }),
			{ class: "item-back", "data-nav": "list" },
		),
		element("span", { class: "grow" }),
		button("‹", step(-1, "previous"), {
			"data-nav": "previous",
			"aria-label": "Previous agent (k)",
			title: "Previous agent (k)",
			disabled: index === 0,
		}),
		element("span", { class: "item-pos" }, `${index + 1} / ${order.length}`),
		button("›", step(1, "next"), {
			"data-nav": "next",
			"aria-label": "Next agent (j)",
			title: "Next agent (j)",
			disabled: index === order.length - 1,
		}),
	);
}
/** A one-agent stage: what it is doing or concluded, its result as text, then the raw agent. */
function renderSingle(inspector, stage) {
	const task = stage.items[0];
	inspector.append(
		// Running: what it is doing; failed: why. A finished agent's outcome is its result below.
		inspectorHeader(humanize(stage.short || stage.id), taskState(task), [
			task.status === "completed" ? null : taskAnnotation(task),
			blockedChip(task.blockedActions),
		]),
		element(
			"p",
			{ class: "agents-meta" },
			[
				taskLine(task),
				...(task.kind === "support"
					? ["Code step · no model call"]
					: [
							`Executor: ${task.executor || run.executor || "unknown"}`,
							`Recorded model: ${task.model || "unknown"}`,
							`Recorded effort: ${task.effort || "unknown"}`,
							`Executor-reported model: ${task.reportedModel || "unknown / not reported"}`,
						]),
			]
				.filter(Boolean)
				.join(", "),
		),
		itemExpansion(task, "stage-result", false, "single"),
	);
}
function renderItems(inspector, stage, previous = new Map()) {
	if (emptyForeach(stage)) {
		const completed =
			stage.status === "completed" &&
			stage.tasks.every((task) => task.statusDetail === "foreach_empty");
		inspector.append(
			inspectorHeader(humanize(stage.id), stage.status),
			element(
				"p",
				{ class: "agents-meta" },
				completed
					? "No applicable items. No agents ran."
					: `${humanize(stage.status)}. No generated agents yet. This stage has not completed an empty pass.`,
			),
			...(!completed
				? stage.tasks.map((task) => taskAnnotation(task)).filter(Boolean)
				: []),
		);
		return;
	}
	if (stage.kind !== "foreach" && stage.items.length === 1)
		return renderSingle(inspector, stage);
	inspector.append(
		inspectorHeader(humanize(stage.id), stage.status),
		element(
			"p",
			{ class: "agents-meta" },
			`${stage.items.length} agents, ${stage.done} done`,
		),
	);
	const key = `${run.runId}:${stage.id}`,
		filter = itemFilters.get(key) || { query: "", status: "all" };
	const input = element("input", {
		type: "search",
		placeholder: `Filter ${stage.items.length} agents…`,
		"aria-label": "Find an agent",
		value: filter.query,
	});
	const filters = element("div", {
		class: "item-filters",
		"aria-label": "Filter agents by status",
	});
	const list = element("div", { class: "item-list", "aria-label": "Agents" });
	function paint(before = itemPositions(inspector)) {
		filter.query = input.value;
		itemFilters.set(key, filter);
		filters.replaceChildren(
			...[
				"all",
				"completed",
				"running",
				"retry",
				"failed",
				"blocked",
				"pending",
				"interrupted",
				"skipped",
			].flatMap((status) => {
				const count =
					status === "all"
						? stage.items.length
						: stage.items.filter((task) => taskState(task) === status).length;
				// Keep the selected filter when its last item settles: otherwise an SSE
				// update removes the focused button and leaves no selected filter at all.
				if (!count && status !== "all" && filter.status !== status) return [];
				return [
					button(
						status === "all"
							? `All ${count}`
							: `${labels[status] || "Waiting"} ${count}`,
						() => {
							filter.status = status;
							paint();
							filters.querySelector(`[data-filter="${status}"]`)?.focus();
						},
						{
							"data-filter": status,
							"aria-pressed": String(filter.status === status),
						},
					),
				];
			}),
		);
		const matches = listedItems(stage);
		list.replaceChildren();
		for (const [group, title] of ITEM_GROUPS) {
			const tasks = matches.filter((task) => itemGroup(task) === group);
			if (!tasks.length) continue;
			list.append(
				element(
					"h3",
					{ class: `agent-group ${group}`, "data-group": group },
					title,
					element("span", {}, tasks.length),
				),
			);
			for (const task of tasks) {
				const status = taskState(task),
					tone =
						task.status === "failed"
							? "err"
							: task.status === "completed"
								? task.outcome?.tone || "ok"
								: "";
				// A finished agent shows its one-line outcome when it has one, so the list can be
				// scanned without opening every agent.
				const annotation =
					group === "done"
						? task.outcome?.text
							? taskAnnotation(task)
							: null
						: taskAnnotation(task);
				const content = element(
					"span",
					{ class: "agent-content" },
					blockedChip(task.blockedActions),
					element(
						"span",
						{ class: `agent-icon tone-${tone}`, "aria-hidden": "true" },
						status === "running"
							? "●"
							: tone === "err"
								? "✕"
								: tone === "warn" || status === "blocked"
									? "!"
									: group === "done"
										? "✓"
										: "○",
					),
					element(
						"span",
						{ class: "agent-index" },
						stage.items.indexOf(task) + 1,
					),
					element(
						"span",
						{ class: "agent-title" },
						task.title || task.specId.slice(stage.id.length + 1) || task.specId,
					),
					element(
						"span",
						{ class: "agent-time", "data-item-time": task.specId },
						itemTime(task),
					),
					annotation,
				);
				const expandKey = `${run.runId}:${task.specId}`,
					expanded = expandedItems.has(expandKey),
					regionId = `expand-${stage.items.indexOf(task)}`;
				list.append(
					button(
						content,
						() => {
							// Closing folds the result away the way it unfolded, then the list closes up.
							const region = document.getElementById(regionId);
							if (
								expandedItems.has(expandKey) &&
								region &&
								!region.classList.contains("leaving") &&
								!reducedMotion()
							) {
								region.classList.add("leaving");
								region.animate(
									[
										{ opacity: 1, transform: "none" },
										{ opacity: 0, transform: "translateY(-4px)" },
									],
									{ duration: 160, easing: "ease-in", fill: "forwards" },
								).onfinish = () => {
									expandedItems.delete(expandKey);
									paint();
									list
										.querySelector(`[data-item="${CSS.escape(task.specId)}"]`)
										?.focus({ preventScroll: true });
								};
								return;
							}
							if (expandedItems.has(expandKey)) expandedItems.delete(expandKey);
							else {
								expandedItems.add(expandKey);
								justExpanded = expandKey;
							}
							paint();
							justExpanded = null;
							list
								.querySelector(`[data-item="${CSS.escape(task.specId)}"]`)
								?.focus({ preventScroll: true });
						},
						{
							"aria-expanded": String(expanded),
							"aria-controls": regionId,
							class: `agent-item ${status}`,
							"data-item": task.specId,
							"data-row-group": group,
							title: `${task.title || task.specId}, ${taskLine(task)}${task.outcome?.text ? `, ${task.outcome.text}` : ""}`,
							"aria-label": `${task.title || task.specId}, ${taskLine(task)}`,
						},
					),
				);
				if (expanded)
					list.append(
						itemExpansion(task, regionId, expandKey === justExpanded),
					);
			}
		}
		if (!matches.length)
			list.append(
				element(
					"p",
					{ class: "muted" },
					stage.items.length
						? "No matching agents"
						: "Items appear when this stage expands.",
				),
			);
		if (!reducedMotion())
			for (const row of list.querySelectorAll("[data-item]")) {
				const was = before.get(row.dataset.item);
				if (!was) continue;
				const delta = was.top - row.getBoundingClientRect().top;
				// Content moves inside its clipped, normal-flow slot, so the hint stays within the slot
				// (a full-distance FLIP would start outside the clip and flash an empty list). A row that
				// changed group fades in from its direction of travel; rows that only shifted settle.
				const nudge = Math.max(-10, Math.min(10, delta));
				if (was.group !== row.dataset.rowGroup)
					row.firstElementChild.animate(
						[
							{
								transform: `translateY(${Math.sign(delta) * 6}px)`,
								opacity: 0,
							},
							{ transform: "translateY(0)", opacity: 1 },
						],
						{ duration: MOTION.base, easing: MOTION.ease },
					);
				else if (nudge)
					row.firstElementChild.animate(
						[
							{ transform: `translateY(${nudge}px)` },
							{ transform: "translateY(0)" },
						],
						{ duration: MOTION.base, easing: MOTION.ease },
					);
			}
	}
	input.addEventListener("input", () => paint());
	inspector.append(
		filters,
		element("div", { class: "items-tools" }, input),
		list,
	);
	paint(previous);
}

const TASK_TABS = ["result", "output", "stderr", "events"];
/** Failed/retrying → stderr; finished → result; otherwise the live output. */
function defaultTaskTab(task) {
	const status = taskState(task);
	if (["retry", "failed"].includes(status)) return "stderr";
	return status === "completed" ? "result" : "output";
}
function logText(tab) {
	if (tab === "result")
		return [resultData?.digest, resultData?.analysis]
			.filter(Boolean)
			.join("\n\n");
	const stream = logData?.streams?.find((s) => s.kind === tab);
	return stream?.lines?.join("\n") || "";
}
function paintResult() {
	const view = $("result-view");
	if (!view) return;
	const task = selectedTask();
	if (!resultData) {
		view.replaceChildren(
			element(
				"p",
				{ class: "muted" },
				resultError ||
					(resultLoading
						? "Loading…"
						: taskState(task) === "completed"
							? "No result files for this task."
							: "No result yet. The task has not finished."),
			),
		);
		return;
	}
	const children = [];
	if (resultData.digest)
		children.push(element("p", { class: "result-digest" }, resultData.digest));
	if (resultData.analysis) {
		const analysis = element("div", { class: "result-analysis" });
		renderTextMarkdown(analysis, resultData.analysis);
		children.push(analysis);
		if (resultData.analysisTruncated)
			children.push(
				element("p", { class: "muted" }, "Analysis truncated by the host."),
			);
	}
	if (resultData.refs?.length)
		children.push(
			element("h4", {}, "References"),
			element(
				"ol",
				{ class: "result-refs" },
				...resultData.refs.map((ref) =>
					element(
						"li",
						{},
						ref.title ? element("strong", {}, ref.title) : null,
						ref.url ? element("code", {}, ref.url) : null,
						ref.note ? element("span", { class: "muted" }, ref.note) : null,
					),
				),
			),
			resultData.refsTruncated
				? element("p", { class: "muted" }, "More references in refs.json.")
				: null,
		);
	if (resultData.control) {
		const control = element(
			"details",
			{ class: "result-control" },
			element("summary", {}, "Control JSON"),
			element("pre", { class: "log" }, resultData.control),
		);
		children.push(control);
	}
	view.replaceChildren(...children.filter(Boolean));
}
async function loadResult() {
	const task = selectedTask();
	if (!task || !run) return;
	// Only a finished task has result files; others say so without a request.
	if (taskState(task) !== "completed") {
		resultData = null;
		resultError = "";
		resultLoading = false;
		paintResult();
		return;
	}
	resultController?.abort();
	resultController = new AbortController();
	const generation = ++resultGeneration,
		key = resultKey,
		id = run.runId;
	resultLoading = true;
	paintResult();
	try {
		const data = await api(
			`/api/runs/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task.taskId)}/result`,
			{
				signal: AbortSignal.any([
					resultController.signal,
					AbortSignal.timeout(20000),
				]),
			},
		);
		if (generation !== resultGeneration || key !== resultKey) return;
		resultData = Object.keys(data || {}).length > 0 ? data : null;
		resultError = "";
	} catch (error) {
		if (generation !== resultGeneration || error.name === "AbortError") return;
		resultError = `Result unavailable: ${error.message}`;
	}
	if (generation === resultGeneration) {
		resultLoading = false;
		paintResult();
	}
}
function paintLogs() {
	if (!$("log-text")) return;
	const task = selectedTask(),
		tab = state.tab || defaultTaskTab(task);
	if (tab === "result") {
		paintResult();
		$("log-notice").textContent = "";
		return;
	}
	const stream = logData?.streams?.find((s) => s.kind === tab);
	const text = logText(tab);
	$("log-text").textContent =
		text ||
		logError ||
		(logLoading
			? "Loading…"
			: task.hasLogs
				? "No output captured for this stream."
				: "No logs yet. This task has not started.");
	$("log-notice").textContent = [
		stream?.truncated || logData?.truncated
			? "Showing the bounded tail; earlier lines were truncated."
			: "",
		stream?.refused || logData?.refused
			? "The host refused this log stream."
			: "",
		text && logError ? logError : "",
	]
		.filter(Boolean)
		.join(" ");
}
async function loadLogs() {
	const task = selectedTask();
	if (!task || !task.hasLogs || !run) return;
	logController?.abort();
	logController = new AbortController();
	const generation = ++logGeneration,
		key = logKey,
		id = run.runId;
	logLoading = true;
	paintLogs();
	try {
		const data = await api(
			`/api/runs/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task.taskId)}/logs?stream=all&lines=400`,
			{
				signal: AbortSignal.any([
					logController.signal,
					AbortSignal.timeout(20000),
				]),
			},
		);
		if (generation !== logGeneration || key !== logKey) return;
		logData = data;
		logError = "";
	} catch (error) {
		if (generation !== logGeneration || error.name === "AbortError") return;
		logError = `Logs unavailable: ${error.message}`;
	}
	if (generation === logGeneration) {
		logLoading = false;
		paintLogs();
	}
}
function openDialog(key, children, className = "") {
	const dialog = $("dialog");
	if (!dialog.open) returnFocus = document.activeElement;
	dialog.className = className;
	delete dialog.dataset.page;
	dialog.replaceChildren(...children);
	modalKey = key;
	if (!dialog.open) dialog.showModal();
	(
		dialog.querySelector("[data-cancel]") ||
		dialog.querySelector("input") ||
		dialog.querySelector("button")
	)?.focus();
}
function dismissDialog(update = true) {
	$("dialog").close();
	modalKey = "";
	if (update && state.dialog) {
		state.dialog = null;
		urlState();
	}
	if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
function renderModal() {
	if (!run) return;
	if (!state.dialog) {
		if (modalKey && !["palette", "key"].includes(modalKey))
			dismissDialog(false);
		return;
	}
	const kind = state.dialog;
	if (
		!["stop", "resume"].includes(kind) ||
		(kind === "stop" && !liveRun(run)) ||
		(kind === "resume" && !needsResume(run))
	) {
		state.dialog = null;
		urlState(true);
		if (modalKey) dismissDialog(false);
		return;
	}
	const key = `${run.runId}:${kind}`;
	if (modalKey === key) {
		for (const confirm of $("dialog").querySelectorAll("[data-mutation]"))
			confirm.disabled = readonly() || busy;
		return;
	}
	let title, content, confirm;
	const counts = run.taskSummary;
	if (kind === "stop") {
		title = `Stop ${run.name}?`;
		confirm = "Stop run";
		content = [
			element(
				"p",
				{},
				`${counts.running || 0} running and ${counts.pending || 0} waiting tasks will be interrupted.`,
			),
			element(
				"ul",
				{},
				element(
					"li",
					{},
					`${counts.running || 0} running tasks will be interrupted`,
				),
				element(
					"li",
					{},
					`${counts.pending || 0} pending tasks will not start; scheduled retries will be cancelled`,
				),
				element(
					"li",
					{},
					`${counts.completed || 0} completed tasks keep their outputs`,
				),
			),
			element(
				"p",
				{},
				"Records a durable stop intent, then waits for the active supervisor to confirm (up to 15 s). Stop requested: waiting for supervisor confirmation, then Stopped. In-flight usage may not be collected.",
			),
		];
	} else if (kind === "resume") {
		title = `Resume ${run.name}?`;
		confirm = "Resume run";
		content = [
			element(
				"p",
				{},
				"Resets failed, interrupted and resumable blocked tasks, then continues. Tasks may execute again and repeat side effects. Completed tasks are not relaunched.",
			),
			element(
				"p",
				{ class: "muted" },
				`${counts.completed || 0} completed tasks are kept. The run uses the same executor, profile and permissions.`,
			),
		];
		if (run.tasks.some((t) => t.statusDetail === "executor_needs_decision"))
			content.push(
				element(
					"p",
					{},
					"The executor could not confirm whether the earlier attempt ran; relaunching may repeat its side effects.",
				),
			);
	}
	const runId = run.runId;
	openDialog(key, [
		element("h2", { id: "dialog-title" }, title),
		...content,
		element(
			"footer",
			{},
			element(
				"span",
				{ class: "muted" },
				readonly() ? "Read-only: actions are off" : "Esc to cancel",
			),
			button("Cancel", () => dismissDialog(), { "data-cancel": "true" }),
			button(confirm, () => mutate(runId, kind), {
				id: "confirm-action",
				class: "primary",
				disabled: readonly() || busy,
				"data-mutation": "true",
			}),
		),
	]);
}
async function mutate(runId, kind) {
	if (readonly() || busy) return;
	busy = true;
	const actionModal = modalKey;
	renderModal();
	const action = kind;
	try {
		const result = await api(
			`/api/runs/${encodeURIComponent(runId)}/${action}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AW-CSRF": session.csrf,
				},
				body: JSON.stringify({}),
			},
		);
		if (kind === "stop" && result.pending) stoppingRuns.add(runId);
		notice(result.text || "Action recorded.");
		if (modalKey === actionModal) dismissDialog();
		const refreshes = await Promise.allSettled([
			state.run === runId ? refreshRun() : Promise.resolve(),
			refreshRuns(),
		]);
		const failure = refreshes.find(
			(refresh) =>
				refresh.status === "rejected" && refresh.reason.name !== "AbortError",
		);
		if (failure)
			notice(
				`${result.text || "Action recorded."}\nThe latest state could not be refreshed: ${failure.reason.message}`,
			);
	} catch (error) {
		notice(`Action failed: ${error.message}`);
	} finally {
		busy = false;
		if (run) {
			const old = $("run-header");
			old?.replaceWith(renderHeader());
			renderModal();
		}
	}
}
/**
 * Evidence words as a glyph and a plain word (2026-11-03, owner's design rules from the dashboard
 * briefs: status lives in glyph + short text, colour only on the glyph and only where it changes a
 * decision, no tinted chips, no status codes in reading text). The raw word stays as the title.
 */
const STATUS_WORDS = {
	verified: ["✓", "Verified", "done"],
	filled: ["✓", "Covered", "done"],
	partially_supported: ["◐", "Partly supported", "warn"],
	partial: ["◐", "Partly covered", "warn"],
	unsupported: ["✕", "Unsupported", "bad"],
	conflicting: ["≠", "Sources disagree", "bad"],
	verification_blocked: ["⊘", "Not checked", "bad"],
	missing: ["✕", "Not covered", "bad"],
	unverified: ["○", "Unverified", "neutral"],
	derived: ["○", "Proposal", "neutral"],
	high: ["", "High", "neutral"],
	medium: ["", "Medium", "neutral"],
	low: ["", "Low", "neutral"],
};
function statusBadge(word) {
	const raw = word.trim();
	const known = STATUS_WORDS[raw.toLowerCase()];
	if (!known) return null;
	const [glyph, label, tone] = known;
	return element(
		"span",
		{
			class: "md-status",
			"data-tone": tone,
			"data-glyph": glyph || null,
			title: raw,
		},
		label,
	);
}
/**
 * Untrusted Markdown as text nodes: headings (by level), bullet and numbered lists (an indented
 * bullet nests under the item above, a list keeps its first number), pipe tables, rules, paragraphs
 * whose single line breaks are kept, inline `**bold**` / `*emphasis*` / `` `code` `` and backslash
 * escapes. No links, HTML, images or content-derived URLs: a Markdown link shows its text with the
 * address as plain text, an image only its alt text (report and task result).
 * Fenced code blocks show verbatim (whitespace kept, no Markdown inside); a list item that is one
 * flat JSON object reads as its main text and "key: value" fields.
 * Reading aids (2026-11-03): a line that starts with a short English field label ("Sources:") shows
 * the label quietly, evidence words read as glyph + word, list items that start with the same bold
 * label ("**Gap:**") are grouped under that label once, a numbered heading hangs its number, and a
 * long double-quoted passage reads as a quote.
 */
/**
 * Workflow verdict codes inside reading text (NEEDS_WORK, BLOCKED, WEAKEN) read in sentence case;
 * other capitals (API, SSRF) stay. Used for bold text and group labels.
 */
const VERDICT_CODES =
	/\b(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|BLOCKED|READY|COMPLETE|INCOMPLETE|UNKNOWN|PASSED|FAILED|KEEP|WEAKEN|DROP|PARTIAL)\b/g;
function readableCodes(value) {
	return value.replace(VERDICT_CODES, (code) => verdictWord(code));
}
/**
 * Code colouring for fenced blocks with Shiki (2026-11-03, owner decision after a side-by-side
 * with the earlier built-in tokenizer). Shiki is vendored under ./vendor/shiki/ by
 * tools/release/vendor-shiki.mjs and imported only when a page has a fenced block; each grammar
 * is its own lazily loaded chunk. Like the reference UIs (opencode session-ui markdown.worker.ts
 * codeToTokens), tokens become text spans — never markup. A span's light and dark theme colours
 * are classes from vendor/shiki/colours.css (.shl-<hex>, .shd-<hex>: no inline styles), and the
 * page's colour scheme picks one. The text shows plain until the tokens arrive, and stays plain
 * for an unknown language or any failure.
 */
let shikiModule = null;
function colourCode(container) {
	const blocks = [...container.querySelectorAll("pre.md-code[data-lang]")];
	if (!blocks.length) return;
	shikiModule ??= import("./vendor/shiki/highlight.js").catch(() => null);
	shikiModule.then(async (shiki) => {
		if (!shiki) return;
		for (const pre of blocks) {
			const code = pre.firstElementChild;
			const text = code?.textContent ?? "";
			if (!shiki.language(pre.dataset.lang) || text.length > 50_000) continue;
			let lines;
			try {
				lines = await shiki.tokens(text, pre.dataset.lang);
			} catch {
				continue;
			}
			if (!lines || !pre.isConnected || code.textContent !== text) continue;
			code.replaceChildren(
				...lines.flatMap((line, index) => [
					...line.map((token) => {
						const span = document.createElement("span");
						span.textContent = token.content;
						for (const [name, prefix] of [
							["--shiki-light", "shl"],
							["--shiki-dark", "shd"],
						]) {
							const hex = /^#([0-9a-f]{3,8})$/i.exec(
								token.htmlStyle?.[name] ?? "",
							)?.[1];
							if (hex) span.classList.add(`${prefix}-${hex.toLowerCase()}`);
						}
						return span;
					}),
					...(index < lines.length - 1 ? ["\n"] : []),
				]),
			);
			pre.dataset.coloured = "true";
		}
	});
}
/** Keys that name a report row's main text (same order as the impact-review report helper). */
const ROW_MAIN_KEYS = [
	"text",
	"issue",
	"title",
	"summary",
	"description",
	"detail",
	"question",
	"item",
	"note",
	"check",
	"action",
	"validation",
	"assumption",
	"area",
];
function renderTextMarkdown(container, text, headingBase = 3) {
	// Escaped punctuation is parked in the private-use area so it is never read as Markdown.
	const park = (value) =>
		value.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, (_, c) =>
			String.fromCharCode(0xe000 + c.charCodeAt(0)),
		);
	// Report renderers write &, < and > as entities (2026-11-03: "cd sample &amp;&amp; npm test"
	// showed literally); they become plain characters again — still text nodes, never markup.
	const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
	const unpark = (value) =>
		value
			.replace(/[\ue000-\ue07f]/g, (c) =>
				String.fromCharCode(c.charCodeAt(0) - 0xe000),
			)
			.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => entities[name]);
	const inline = (raw) => {
		const value = park(raw);
		const nodes = [];
		const re =
			/!\[([^\]]*)\]\(<?[^)>\s]*>?\)|\[([^\]]+)\]\(<?([^)>\s]+)>?\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*|"([^"]{8,})"/g;
		let last = 0;
		for (const m of value.matchAll(re)) {
			if (m.index > last) nodes.push(unpark(value.slice(last, m.index)));
			if (m[0].startsWith("!"))
				nodes.push(
					element(
						"span",
						{ class: "muted" },
						`[image${m[1] ? `: ${unpark(m[1])}` : ""}]`,
					),
				);
			else if (m[2] !== undefined) {
				// A link named by its host reads as host + quiet path ("arxiv.org/abs/2307.03172");
				// any other link keeps its whole address in brackets.
				const label = unpark(m[2]),
					target = unpark(m[3]);
				let address = ` (${target})`;
				try {
					const url = new URL(target);
					if (url.host.replace(/^www\./, "") === label.replace(/^www\./, ""))
						address = `${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
				} catch {
					// Not an absolute URL: keep it as written.
				}
				nodes.push(
					label,
					target !== label && address
						? element("span", { class: "md-url" }, address)
						: null,
				);
			} else if (m[4] !== undefined) {
				const bold = unpark(m[4]);
				const readable = readableCodes(bold);
				nodes.push(
					statusBadge(bold) ??
						element(
							"strong",
							{ title: readable === bold ? null : bold },
							readable,
						),
				);
			} else if (m[5] !== undefined)
				nodes.push(element("code", {}, unpark(m[5])));
			else if (m[6] !== undefined) nodes.push(element("em", {}, unpark(m[6])));
			else
				nodes.push(element("span", { class: "md-quote" }, `"${unpark(m[7])}"`));
			last = m.index + m[0].length;
		}
		if (last < value.length) nodes.push(unpark(value.slice(last)));
		return nodes;
	};
	// "Evidence status: verified", "Sources: …": a short English label, then its value.
	const field = (raw) => {
		const m = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}):(?:\s+(.*))?$/.exec(raw);
		if (!m) return inline(raw);
		const value = (m[2] ?? "").trim();
		const plain = unpark(park(value.replace(/^\*\*(.+)\*\*$/, "$1")));
		return [
			element("span", { class: "md-label" }, `${m[1]}:`),
			value ? " " : null,
			value ? (statusBadge(plain) ?? inline(value)) : null,
		];
	};
	// An older report row written as one flat JSON object ({"item":…,"owner":…}) reads as its main
	// text, then "key: value" fields (2026-11-03; current report helpers already write rows so).
	const jsonRow = (raw) => {
		const textValue = unpark(park(raw)).trim();
		if (!/^\{.*\}$/.test(textValue)) return null;
		let row;
		try {
			row = JSON.parse(textValue);
		} catch {
			return null;
		}
		const scalar = (value) =>
			["string", "number", "boolean"].includes(typeof value);
		if (
			!row ||
			Array.isArray(row) ||
			typeof row !== "object" ||
			!Object.values(row).every(
				(value) =>
					scalar(value) || (Array.isArray(value) && value.every(scalar)),
			)
		)
			return null;
		const main = ROW_MAIN_KEYS.find(
			(key) => typeof row[key] === "string" && row[key].trim(),
		);
		const fields = Object.keys(row)
			.filter((key) => key !== main)
			.flatMap((key, index) => [
				index ? "; " : main ? ", " : "",
				element("span", { class: "md-label" }, `${key}:`),
				" ",
				Array.isArray(row[key]) ? row[key].join(", ") : String(row[key]),
			]);
		return [main ? inline(row[main]) : null, ...fields];
	};
	let list = null;
	let paragraph = null;
	let table = null;
	// Consecutive "- **Gap:** …" items: the label is said once, above them, with a count.
	let group = null;
	// A fenced block (```ts … ```) is shown verbatim, whitespace kept, no Markdown inside.
	let fence = null;
	const closeFence = () => {
		container.append(
			element(
				"pre",
				{ class: "md-code", "data-lang": fence.lang || null },
				element("code", {}, fence.lines.join("\n")),
			),
		);
		fence = null;
	};
	for (const line of text.split("\n")) {
		const fenceMark = /^\s*(`{3,}|~{3,})\s*([\w+.#-]*)\s*$/.exec(line);
		if (fence) {
			if (
				fenceMark &&
				!fenceMark[2] &&
				fenceMark[1][0] === fence.mark[0] &&
				fenceMark[1].length >= fence.mark.length
			)
				closeFence();
			else fence.lines.push(line);
			continue;
		}
		if (fenceMark) {
			list = null;
			paragraph = null;
			table = null;
			fence = { mark: fenceMark[1], lang: fenceMark[2], lines: [] };
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line),
			item = /^\s*[-*+]\s+(.+)$/.exec(line),
			numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line),
			rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line),
			row = /^\s*\|(.+)\|\s*$/.exec(line);
		if (row) {
			// Pipe tables: a separator row (|---|:--:|) is skipped; cells are text nodes.
			list = null;
			paragraph = null;
			const cells = row[1].split("|").map((c) => c.trim());
			if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
			if (!table) {
				table = element("table", { class: "report-table" });
				container.append(table);
			}
			const tag = table.childElementCount === 0 ? "th" : "td";
			table.append(
				element(
					"tr",
					{},
					...cells.map((c) =>
						element(
							tag,
							{},
							...(tag === "td"
								? [statusBadge(unpark(park(c))) ?? inline(c)]
								: inline(c)),
						),
					),
				),
			);
			continue;
		}
		table = null;
		if (rule) {
			list = null;
			paragraph = null;
			container.append(element("hr"));
		} else if (heading) {
			list = null;
			paragraph = null;
			const level = Math.min(6, headingBase + heading[1].length - 1);
			const numberedHeading = /^(\d+)\.\s+(.+)$/.exec(heading[2]);
			container.append(
				element(
					`h${level}`,
					{ class: `md-h${heading[1].length}` },
					numberedHeading
						? [
								element("span", { class: "md-index" }, numberedHeading[1]),
								inline(numberedHeading[2]),
							]
						: inline(heading[2]),
				),
			);
		} else if (item || numbered) {
			paragraph = null;
			const tag = item ? "ul" : "ol";
			const labelled =
				item && !/^\s{2,}/.test(line)
					? /^\*\*([^*]{1,40}):\*\*\s*(.*)$/.exec(item[1])
					: null;
			if (labelled) {
				if (!group || group.label !== labelled[1] || list !== group.list) {
					const count = element("span", { class: "md-count" });
					container.append(
						element(
							"p",
							{ class: "md-group" },
							readableCodes(labelled[1]),
							" ",
							count,
						),
					);
					list = element("ul", { class: "md-grouped" });
					container.append(list);
					group = { label: labelled[1], list, count, size: 0 };
				}
				group.count.textContent = String(++group.size);
				list.append(element("li", {}, ...inline(labelled[2])));
				continue;
			}
			const entry = element(
				"li",
				{},
				...(jsonRow((item ?? numbered)[1]) ?? field((item ?? numbered)[1])),
			);
			const parent = list?.lastElementChild;
			if (/^\s{2,}/.test(line) && parent) {
				// An indented item nests under the item above (the numbered list keeps counting).
				let nested = parent.lastElementChild;
				if (nested?.tagName.toLowerCase() !== tag) {
					nested = element(tag);
					parent.append(nested);
				}
				nested.append(entry);
				continue;
			}
			if (!list || list.tagName.toLowerCase() !== tag || list === group?.list) {
				list = element(tag, {
					start: numbered ? /^\s*(\d+)/.exec(line)[1] : null,
				});
				container.append(list);
			}
			list.append(entry);
		} else if (!line.trim()) {
			list = null;
			paragraph = null;
		} else {
			list = null;
			// A paragraph keeps its line breaks: generated reports put one fact per line.
			if (!paragraph) {
				paragraph = element("p");
				container.append(paragraph);
			} else paragraph.append(element("br"));
			append(paragraph, field(line.trimEnd()));
		}
	}
	if (fence) closeFence();
	for (const table of container.querySelectorAll("table.report-table"))
		stackWideTable(table);
	colourCode(container);
}
/**
 * A table of four or more columns reads as one entry per row (2026-11-03, owner: the report's
 * evidence table — long links, Korean wrapping in narrow columns, the last column cut off — was
 * hard to read): the first cell is the entry's title with any status word beside it, the other
 * columns follow as label and value, link lists last with one source per line.
 */
function stackWideTable(table) {
	const rows = [...table.rows];
	const head = [...(rows[0]?.cells ?? [])].map((cell) =>
		cell.textContent.trim(),
	);
	if (head.length < 4 || rows.length < 2) return;
	const list = element("div", { class: "report-rows" });
	for (const row of rows.slice(1)) {
		const cells = [...row.cells];
		const status = (cell) =>
			cell.childNodes.length === 1 && cell.firstChild.matches?.(".md-status");
		const links = (cell) => cell.querySelectorAll(".md-url").length > 0;
		const fields = cells
			.slice(1)
			.map((cell, index) => ({ cell, label: head[index + 1] }))
			.filter(({ cell }) => !status(cell) && cell.textContent.trim())
			.sort((a, b) => Number(links(a.cell)) - Number(links(b.cell)));
		list.append(
			element(
				"section",
				{ class: "report-row" },
				element(
					"p",
					{ class: "report-row-title" },
					...cells[0].childNodes,
					...cells
						.slice(1)
						.filter(status)
						.flatMap((cell) => [...cell.childNodes]),
				),
				fields.length
					? element(
							"dl",
							{ class: "report-row-fields" },
							fields.flatMap(({ cell, label }) => [
								element("dt", {}, label),
								element(
									"dd",
									{},
									links(cell) ? sourceLines(cell) : [...cell.childNodes],
								),
							]),
						)
					: null,
			),
		);
	}
	table.replaceWith(list);
}
/** "host/path, host/path" → one source per line (the separators go). */
function sourceLines(cell) {
	const lines = [[]];
	for (const node of [...cell.childNodes]) {
		if (
			node.nodeType === Node.TEXT_NODE &&
			/^\s*[,;]\s*$/.test(node.textContent)
		)
			lines.push([]);
		else lines.at(-1).push(node);
	}
	return lines
		.filter((line) => line.length)
		.map((line) => element("span", { class: "md-source" }, ...line));
}
/**
 * Each `###` part of the report (a finding, a summary part) is one section, set apart by a hairline
 * and space — not a filled card (owner's rules: no filled cards, no status-coloured edges).
 */
function reportBlocks(container) {
	let block = null;
	for (const node of [...container.children]) {
		if (node.matches(".finding-card")) {
			block = null;
			continue;
		}
		if (node.matches(".md-h1, .md-h2, nav")) block = null;
		else if (node.matches(".md-h3")) {
			block = element("section", { class: "md-block" });
			node.before(block);
		}
		if (block && node !== block) block.append(node);
	}
}
/**
 * Report page colour (2026-11-03, owner: white text on black is hard to read at length): the
 * report can be read on a light page while the dashboard stays dark, or the other way round.
 * Kept in this browser; without a choice the page follows the dashboard theme.
 */
const REPORT_PAGE_KEY = "agent-workflow:report-page";
function storedReportPage() {
	try {
		const value = localStorage.getItem(REPORT_PAGE_KEY);
		return value === "light" || value === "dark" ? value : null;
	} catch {
		return null; // Storage unavailable: follow the dashboard.
	}
}
/** The dashboard's own scheme: the chosen theme, else the system's. */
const appScheme = () => {
	const theme = document.documentElement.dataset.theme;
	if (theme === "light" || theme === "dark") return theme;
	return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
function reportPage(view) {
	const page = view.dataset.page;
	return page === "light" || page === "dark" ? page : appScheme();
}
/** Called once the report page is drawn. */
function reportPageButton(view) {
	const stored = storedReportPage();
	if (stored) view.dataset.page = stored;
	const control = button(
		"",
		() => {
			const next = reportPage(view) === "dark" ? "light" : "dark";
			// 2026-11-12 (review, P3-6): choosing the dashboard's own scheme is no pin: the page
			// follows the dashboard again, so there is always a way back.
			const follow = next === appScheme();
			try {
				if (follow) localStorage.removeItem(REPORT_PAGE_KEY);
				else localStorage.setItem(REPORT_PAGE_KEY, next);
			} catch {
				// The choice then lasts for this report only.
			}
			if (follow) delete view.dataset.page;
			else view.dataset.page = next;
			label();
		},
		{ class: "report-page" },
	);
	const label = () => {
		control.textContent =
			reportPage(view) === "dark" ? "Light page" : "Dark page";
	};
	label();
	return control;
}
/**
 * 2026-11-12 (owner): the report is a page of its own, not a modal (`?run=…&view=report`: it can
 * be shared and the back button leaves it). Its structure is only what the report text says.
 * A deep-review style report writes each finding as `### finding-001 — title` with `Severity:` and
 * `Verifier verdict:` lines and a Locations table; those parts become a card. Any other report
 * (or any other part of this one) stays plain rendered Markdown, so nothing is ever invented.
 */
const FINDING_HEADING = /^(finding-\d+)\s+[—–-]+\s+(.+)$/;
const LABEL_LINE = /^([A-Z][A-Za-z-]*(?:(?: \/ | |\/)[A-Za-z-]+){0,4}):\s*$/;
/** Markdown escapes and entities, as plain text (for chips, never for rendering). */
const plainMd = (value) =>
	value
		.replace(/\\([\\`*_{}[\]()#+\-.!|<>~&])/g, "$1")
		.replace(
			/&(amp|lt|gt|quot|#39);/g,
			(_, name) =>
				({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name],
		)
		.replace(/\*\*([^*]+)\*\*/g, "$1");
/** The report as plain Markdown parts and finding parts, in order (fenced code is never split). */
export function splitReport(text) {
	const segments = [];
	let current = { kind: "markdown", lines: [] };
	let fence = null;
	const finish = () => {
		if (current.kind === "finding" || current.lines.some((line) => line.trim()))
			segments.push(current);
	};
	for (const line of text.split("\n")) {
		const mark = /^\s*(`{3,}|~{3,})\s*([\w+.#-]*)\s*$/.exec(line);
		if (fence) {
			if (
				mark &&
				!mark[2] &&
				mark[1][0] === fence[0] &&
				mark[1].length >= fence.length
			)
				fence = null;
			current.lines.push(line);
			continue;
		}
		if (mark) {
			fence = mark[1];
			current.lines.push(line);
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading && heading[1].length <= 3) {
			const finding =
				heading[1].length === 3 ? FINDING_HEADING.exec(heading[2]) : null;
			if (finding) {
				finish();
				current = {
					kind: "finding",
					id: finding[1],
					title: finding[2],
					heading: line,
					lines: [],
				};
				continue;
			}
			if (current.kind === "finding") {
				finish();
				current = { kind: "markdown", lines: [] };
			}
		}
		current.lines.push(line);
	}
	finish();
	return segments;
}
/** A finding part: severity, verifier verdict, location rows and its labelled blocks. */
export function parseFinding(segment) {
	const head = [],
		blocks = [];
	let block = null,
		fence = null;
	for (const line of segment.lines) {
		const mark = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (
				mark &&
				mark[1][0] === fence[0] &&
				mark[1].length >= fence.length &&
				!line.replace(/^\s*[`~]+/, "").trim()
			)
				fence = null;
			(block?.lines ?? head).push(line);
			continue;
		}
		if (mark) {
			fence = mark[1];
			(block?.lines ?? head).push(line);
			continue;
		}
		const label = LABEL_LINE.exec(line.trim());
		if (label) {
			block = { label: label[1], lines: [] };
			blocks.push(block);
			continue;
		}
		(block?.lines ?? head).push(line);
	}
	const pick = (name) =>
		new RegExp(`^${name}:\\s*\\**([A-Za-z\\\\_-]+)\\**`, "m").exec(
			head.join("\n"),
		)?.[1];
	const locations = (
		blocks.find((item) => item.label === "Locations")?.lines ?? []
	)
		.map((line) => /^\s*\|(.+)\|\s*$/.exec(line))
		.filter(Boolean)
		.map((match) => match[1].split("|").map((cell) => cell.trim()))
		.filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)))
		.slice(1)
		.map(([file, line, symbol]) => ({
			file: plainMd(file ?? "").replace(/^`|`$/g, ""),
			line: plainMd(line ?? ""),
			symbol: plainMd(symbol ?? "").replace(/^`|`$/g, ""),
		}));
	return {
		id: segment.id,
		title: segment.title,
		severity: pick("Severity")?.replaceAll("\\", ""),
		verdict: pick("Verifier verdict")?.replaceAll("\\", ""),
		locations,
		intro: head
			.filter(
				(line) => !/^(?:Severity|Verifier verdict|Root cause):/.test(line),
			)
			.join("\n"),
		blocks: blocks.filter((item) => item.label !== "Locations"),
		raw: `${segment.heading}\n${segment.lines.join("\n")}`.trimEnd(),
	};
}
const SEVERITIES = {
	critical: ["failed", "Critical"],
	high: ["failed", "High"],
	medium: ["attention", "Medium"],
	low: ["pending", "Low"],
};
/** Severity as glyph + word. An unknown word is shown as written. */
function severityInfo(word) {
	const key = String(word ?? "").toLowerCase();
	return [key, ...(SEVERITIES[key] ?? ["pending", verdictWord(key)])];
}
const VERDICTS = {
	keep: ["kept", "completed", "Kept"],
	kept: ["kept", "completed", "Kept"],
	weaken: ["weakened", "attention", "Weakened"],
	weakened: ["weakened", "attention", "Weakened"],
	drop: ["dropped", "skipped", "Dropped"],
	dropped: ["dropped", "skipped", "Dropped"],
	needs_human: ["needs-human", "blocked", "Needs human"],
};
/**
 * The verifier's word for a finding. A deep-review report prints "Verifier verdict:" only for a
 * finding that is not kept, and says its ledger holds "kept or weakened findings": a card without
 * the line is Kept only in a report that says so; otherwise it has no verifier pill.
 */
function verifierInfo(word, ledgerKept) {
	if (!word) return ledgerKept ? VERDICTS.keep : null;
	const key = word.toLowerCase();
	return (
		VERDICTS[key] ?? [key.replace(/_/g, "-"), "pending", verdictWord(word)]
	);
}
function findingCard(finding, ledgerKept) {
	const [severity, , severityWord] = severityInfo(finding.severity);
	const verifier = verifierInfo(finding.verdict, ledgerKept);
	const title = element("div");
	renderTextMarkdown(title, `### ${finding.title}`, 1);
	const heading = title.firstElementChild;
	heading?.classList.add("finding-title");
	const text = (lines) => {
		const box = element("div", { class: "finding-text" });
		renderTextMarkdown(box, lines, 4);
		return box;
	};
	// 2026-11-12 (owner, review P3-1): what is wrong and what to do come first, directly under the
	// title; the evidence and caveat folds follow them.
	const folded = (block) => /evidence|caveat|counter/i.test(block.label);
	const parts = finding.blocks
		.filter((block) => block.lines.some((line) => line.trim()))
		.sort((a, b) => Number(folded(a)) - Number(folded(b)))
		.map((block) => {
			const body = block.lines.join("\n");
			const count = block.lines.filter((line) =>
				/^\s*(?:```|~~~|[-*+]\s)/.test(line),
			).length;
			// A code block has two fences; a list one mark per item.
			const size = /^\s*(?:```|~~~)/m.test(body) ? Math.ceil(count / 2) : count;
			const label = `${block.label}${folded(block) && size ? ` (${size})` : ""}`;
			// Short source blocks are readable without a disclosure, independent of viewport.
			const long =
				body.trim().length > 600 || body.trim().split("\n").length > 8;
			if (!folded(block) || !long)
				return element(
					"section",
					{ class: "finding-part" },
					element("h4", { class: "part-label" }, label),
					text(body),
				);
			return element(
				"details",
				{ class: "finding-part finding-fold" },
				element("summary", {}, label),
				text(body),
			);
		});
	return {
		severity,
		verdict: verifier?.[0] ?? "",
		card: element(
			"article",
			{
				class: "finding-card",
				"data-severity": severity,
				"data-verdict": verifier?.[0] ?? "",
				"aria-label": finding.id,
			},
			element(
				"div",
				{ class: "finding-head" },
				element(
					"span",
					{ class: `severity-chip ${severity}`, title: finding.severity },
					// 2026-11-12 (review, P2-10): a dot, so a cross only ever means "failed".
					element("span", { class: `outline-dot ${severity}` }),
					severityWord,
				),
				verifier
					? element(
							"span",
							{ class: `verifier-pill ${verifier[0]}`, title: finding.verdict },
							glyph(verifier[1]),
							verifier[2],
						)
					: null,
				element("span", { class: "finding-id" }, finding.id),
			),
			heading,
			finding.locations.length
				? element(
						"div",
						{ class: "finding-locations" },
						finding.locations.map((where) =>
							element(
								"span",
								{ class: "location-chip" },
								element("b", {}, `${where.file}:${where.line}`),
								// "—" is how a report's table says "no symbol"; it is data, not text of ours.
								where.symbol && where.symbol !== "—"
									? element("span", { class: "location-symbol" }, where.symbol)
									: null,
							),
						),
					)
				: null,
			finding.intro.trim() ? text(finding.intro) : null,
			parts,
			element(
				"div",
				{ class: "finding-foot" },
				button("Copy fix prompt", () => copy(finding.raw), {
					class: "small",
					"data-copy-finding": finding.id,
				}),
			),
		),
	};
}
/** Render the report into `container`; returns its finding cards (none for a plain report). */
function renderReport(container, text) {
	const ledgerKept = /kept or weakened findings/i.test(text);
	const found = [];
	for (const segment of splitReport(text)) {
		const finding = segment.kind === "finding" ? parseFinding(segment) : null;
		// A finding heading without its own "Severity:" line (another workflow's report) is not a
		// card: it stays Markdown, as written.
		if (finding?.severity) {
			const built = findingCard(finding, ledgerKept);
			found.push(built);
			container.append(built.card);
		} else
			renderTextMarkdown(
				container,
				(finding ? [segment.heading, ...segment.lines] : segment.lines).join(
					"\n",
				),
				2,
			);
	}
	reportBlocks(container);
	return found;
}
/**
 * The sticky outline, "On this page" (2026-11-12, review P2-6): the report's `##` headings and its
 * findings, each on one line (a finding by its title, its id in the tooltip). Sub-sections of a
 * section are left out; a `### finding-NNN — title` heading that is not a card still counts.
 */
function reportOutline(content, scroller) {
	const targets = [...content.querySelectorAll(".md-h2, .md-h3, .finding-card")]
		.filter(
			(node) =>
				!node.matches(".finding-title") &&
				(!node.matches(".md-h3") || FINDING_HEADING.test(node.textContent)),
		)
		.map((node) => {
			const card = node.matches(".finding-card");
			const text = card
				? node.querySelector(".finding-title")?.textContent
				: [...node.childNodes]
						.map((child) =>
							child.classList?.contains("md-index")
								? `${child.textContent}. `
								: child.textContent,
						)
						.join("");
			const found = card ? null : FINDING_HEADING.exec(text);
			return {
				node,
				level: card || found ? 1 : 0,
				label: found ? found[2] : text,
				title: card ? `${node.getAttribute("aria-label")}: ${text}` : text,
				severity: node.dataset?.severity,
			};
		});
	if (!targets.length) return null;
	// The entry the reader clicked stays current until they scroll by hand (review, P2-1): the
	// scroll a click starts must not hand the highlight to a neighbour.
	let pinned = null;
	const links = targets.map((target) =>
		element(
			"a",
			{
				class: `outline-link level-${target.level}`,
				href: "#",
				title: target.title,
				onclick: (event) => {
					event.preventDefault();
					toggle(false);
					pinned = target;
					current(target);
					target.node.scrollIntoView({
						block: "start",
						behavior: reducedMotion() ? "auto" : "smooth",
					});
				},
			},
			target.severity
				? element("span", { class: `outline-dot ${target.severity}` })
				: null,
			element("span", { class: "outline-text" }, target.label),
		),
	);
	const nav = element(
		"nav",
		{ class: "report-outline", "aria-label": "Report outline" },
		button("On this page", () => toggle(), {
			class: "outline-toggle",
			"aria-expanded": "false",
		}),
		element(
			"p",
			{ class: "outline-title", "aria-hidden": "true" },
			"On this page",
		),
		element("div", { class: "outline-links" }, links),
	);
	const toggle = (open = !nav.classList.contains("open")) => {
		nav.classList.toggle("open", open);
		nav
			.querySelector(".outline-toggle")
			.setAttribute("aria-expanded", String(open));
	};
	const current = (target) => {
		links.forEach((link, index) => {
			const on = targets[index] === target;
			link.classList.toggle("current", on);
			if (on) {
				link.setAttribute("aria-current", "location");
				// A long outline scrolls by itself, so the current entry is never out of sight (the
				// page is not moved: only the outline's own scroll is set).
				if (nav.scrollHeight > nav.clientHeight) {
					const box = nav.getBoundingClientRect();
					const at = link.getBoundingClientRect();
					const top = at.top - box.top + nav.scrollTop;
					if (top < nav.scrollTop) nav.scrollTop = top;
					else if (top + at.height > nav.scrollTop + nav.clientHeight)
						nav.scrollTop = top + at.height - nav.clientHeight;
				}
			} else link.removeAttribute("aria-current");
		});
	};
	// The section being read: the last shown heading above a line a third of the way down the
	// page (at most 160px); at the very end of the page, the last shown one, which could never
	// reach that line.
	const update = () => {
		const shown = targets.filter(
			(target) => target.node.getClientRects().length,
		);
		const edge =
			scroller.getBoundingClientRect().top +
			Math.min(160, scroller.clientHeight / 3);
		const atEnd =
			scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
		let at = pinned ?? (atEnd ? shown.at(-1) : null);
		if (!at)
			for (const target of shown) {
				at ??= target;
				if (target.node.getBoundingClientRect().top <= edge) at = target;
			}
		current(at);
	};
	for (const type of ["wheel", "touchmove", "keydown", "pointerdown"])
		scroller.addEventListener(
			type,
			() => {
				pinned = null;
			},
			{ passive: true },
		);
	// A filtered-out card or section leaves the outline too.
	content.addEventListener("report-filter", () => {
		links.forEach((link, index) => {
			link.hidden = !targets[index].node.getClientRects().length;
		});
		if (pinned && !pinned.node.getClientRects().length) pinned = null;
		update();
	});
	let frame = 0;
	scroller.addEventListener("scroll", () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(update);
	});
	requestAnimationFrame(update);
	return nav;
}
/** Severity and verifier count chips that filter the finding cards. */
function findingFilters(content, found, empty) {
	if (!found.length) return null;
	const filters = { severity: "", verdict: "" };
	const tally = (key) => {
		const counts = new Map();
		for (const item of found)
			if (item[key]) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
		return counts;
	};
	// A heading whose whole section is finding cards disappears with them.
	const sections = [];
	let section = null;
	for (const node of content.children) {
		if (node.matches(".md-h1, .md-h2")) {
			section = { heading: node, cards: [], plain: false };
			sections.push(section);
		} else if (node.matches(".finding-card")) section?.cards.push(node);
		else if (section) section.plain = true;
	}
	const apply = (reveal = false) => {
		let shown = 0;
		for (const { card } of found) {
			card.hidden =
				(filters.severity && card.dataset.severity !== filters.severity) ||
				(filters.verdict && card.dataset.verdict !== filters.verdict);
			if (!card.hidden) shown++;
		}
		for (const item of sections)
			item.heading.hidden =
				item.cards.length > 0 &&
				!item.plain &&
				item.cards.every((card) => card.hidden);
		empty.hidden = shown > 0;
		// 2026-11-12 (review, P2-5): say what the filter did, and show it (the cards are far down).
		const on = Boolean(filters.severity || filters.verdict);
		status.textContent = on ? `Showing ${shown} of ${found.length}` : "";
		clear.hidden = !on;
		content.dispatchEvent(new Event("report-filter"));
		if (reveal && on && shown)
			found
				.find((item) => !item.card.hidden)
				?.card.scrollIntoView({
					block: "start",
					behavior: reducedMotion() ? "auto" : "smooth",
				});
		for (const chip of chips.querySelectorAll("[data-filter-key]"))
			chip.setAttribute(
				"aria-pressed",
				String(filters[chip.dataset.filterKey] === chip.dataset.filterValue),
			);
	};
	const chip = (key, value, text) =>
		button(
			text,
			() => {
				filters[key] = filters[key] === value ? "" : value;
				apply(true);
			},
			{
				class: "filter-chip",
				"data-filter-key": key,
				"data-filter-value": value,
				"aria-pressed": "false",
			},
		);
	const order = ["critical", "high", "medium", "low"];
	const severities = [...tally("severity")].sort(
		(a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9),
	);
	const verdicts = [...tally("verdict")].sort(
		(a, b) =>
			(["kept", "weakened", "needs-human", "dropped"].indexOf(a[0]) + 1 || 9) -
			(["kept", "weakened", "needs-human", "dropped"].indexOf(b[0]) + 1 || 9),
	);
	const word = (value) =>
		Object.values(VERDICTS).find((item) => item[0] === value)?.[2] ??
		verdictWord(value);
	const status = element("span", {
		class: "muted filter-count",
		role: "status",
	});
	const clear = button(
		"Clear",
		() => {
			filters.severity = filters.verdict = "";
			apply();
		},
		{ class: "link filter-clear", hidden: true },
	);
	const chips = element(
		"div",
		{ class: "filter-chips", role: "group", "aria-label": "Filter findings" },
		severities.length
			? element("span", { class: "chip-label" }, "Severity")
			: null,
		severities.map(([value, count]) =>
			chip(
				"severity",
				value,
				`${count} ${severityInfo(value)[2].toLowerCase()}`,
			),
		),
		verdicts.length
			? element("span", { class: "chip-label" }, "Verifier")
			: null,
		verdicts.map(([value, count]) =>
			chip("verdict", value, `${count} ${word(value).toLowerCase()}`),
		),
		status,
		clear,
	);
	return chips;
}
/** What the finished run is, as one badge (the rail and the result card use the same words). */
function resultBadge(summary) {
	if (summary.status === "interrupted") return ["interrupted", "Stopped"];
	if (summary.status === "failed" && !summary.verdictGate)
		return ["failed", "Failed"];
	if (summary.status === "blocked") return ["blocked", "Needs you"];
	if (summary.status === "running") return ["running", "Running"];
	if (summary.status === "pending") return ["pending", "Waiting"];
	const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
	if (summary.verdict)
		return [
			CLEAN_VERDICT.test(summary.verdict) ? "completed" : "attention",
			sentence(verdictWord(summary.verdict)),
		];
	const outcome = finishedOutcome(summary);
	return [outcome.clean ? "completed" : "attention", outcome.word];
}
/** A cut-off summary ("… the new graceMs lo…") reads up to its last whole sentence. */
function leadSentence(text) {
	if (!text?.endsWith("…")) return text;
	const whole = text.slice(0, -1);
	const end = [...whole.matchAll(/[.!?](?=\s)/g)].at(-1);
	return end && end.index >= 20 ? whole.slice(0, end.index + 1) : text;
}
/** One sentence on what the run found: its own summary, else its last step's result. */
function runSummaryText(r) {
	return (
		r.summary ||
		[...(r.tasks ?? [])]
			.reverse()
			.find(
				(t) => t.outcome?.text && t.kind !== "foreach" && t.kind !== "support",
			)?.outcome?.text
	);
}
/**
 * Cost with how many agents reported it (2026-11-12, owner). Code steps never report cost, so only
 * agents are counted ("8 of 8 agents reported"); a partial sum has a "+", and an unknown cost is
 * "n/a", never $0. `costs` is a list of a run's `cost` (a project's runs add up).
 */
function formatUsd(value) {
	return `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
}
function costLabel(costs) {
	if (!costs.length)
		return { text: "n/a", ratio: "", title: "Cost not reported", runs: 0 };
	const known = costs.filter((entry) => entry?.costUsd != null);
	const total = costs.reduce((sum, entry) => sum + (entry?.agentTotal ?? 0), 0);
	const reporting = costs.reduce(
		(sum, entry) => sum + (entry?.agentsReporting ?? 0),
		0,
	);
	const partial = costs.some(
		(entry) => (entry?.agentsReporting ?? 0) < (entry?.agentTotal ?? 0),
	);
	const ratio = `${reporting} of ${total} agent${total === 1 ? "" : "s"} reported`;
	if (!known.length)
		return {
			text: "n/a",
			ratio,
			title: total ? `No cost reported (${ratio})` : "No agents ran",
			runs: 0,
		};
	const sum = known.reduce((acc, entry) => acc + entry.costUsd, 0);
	return {
		text: `${formatUsd(sum)}${partial ? "+" : ""}`,
		ratio,
		title: partial
			? `${ratio} cost. The true total may be higher.`
			: `${ratio} cost`,
		runs: known.length,
	};
}
/** "Dark page"/"Light page" and the run's meta line sit in the header; this draws the whole page. */
function renderReportPage() {
	const key = `${run.runId}:${run.updatedAt}:${run.status}`;
	const old = $("report-view");
	if (old?.dataset.key === key) return;
	const generation = ++reportGeneration;
	const scroll = old?.dataset.run === run.runId ? old.scrollTop : 0;
	const [tone, word] = resultBadge(run);
	const summary = runSummaryText(run);
	const cost = costLabel(run.cost ? [run.cost] : []);
	const meta = [
		element("span", {}, run.name),
		element(
			"span",
			{ title: `Finished ${new Date(date(run.updatedAt)).toLocaleString()}` },
			liveRun(run) ? "Not finished" : `Finished ${ago(run.updatedAt)}`,
		),
		element(
			"span",
			{
				title:
					"Active time: when agents and steps were working, not the time the run sat waiting",
			},
			run.activeMs != null ? `${duration(run.activeMs)} active` : elapsed(run),
		),
		run.agentSummary
			? element(
					"span",
					{},
					`${run.agentSummary.completed} of ${run.agentSummary.total} agents`,
				)
			: null,
		element(
			"span",
			{ class: "report-cost", title: cost.title },
			run.cost?.costUsd != null
				? `${cost.text}, ${cost.ratio}`
				: `Cost ${cost.text}`,
		),
	];
	let loaded = "";
	const copyButton = button("Copy as Markdown", () => loaded && copy(loaded), {
		class: "copy-report",
		disabled: true,
	});
	const openButton = button("Open run", () => go({ view: null }), {
		class: "primary",
		"data-action": "open-run",
	});
	const content = element(
		"article",
		{ class: "report-content", id: "report-content" },
		run.reportAvailable ? "Loading report…" : "This run has no report.",
	);
	const chips = element("div", { class: "report-filters" });
	const empty = element(
		"p",
		{ class: "muted filter-empty", hidden: true },
		"No findings match these filters.",
	);
	const outline = element("div", { class: "outline-slot" });
	const actions = element("div", { class: "actions" }, copyButton, openButton);
	const view = element(
		"div",
		{
			class: "report-view",
			id: "report-view",
			"data-key": key,
			"data-run": run.runId,
			// 2026-11-12 (review, P3-7): focus starts on the page itself, so the first Tab reaches
			// the actions before the filters.
			tabindex: "-1",
			role: "region",
			"aria-label": `${run.name} report`,
		},
		element(
			"div",
			{ class: "report-layout" },
			element(
				"header",
				{ class: "report-head" },
				element(
					"div",
					{ class: "report-title-row" },
					element(
						"span",
						{ class: `result-badge ${tone}`, "data-tone": tone },
						glyph(tone),
						element("strong", {}, word),
					),
					actions,
				),
				element(
					"h1",
					{ class: "report-summary" },
					leadSentence(summary) || `${run.name} report`,
				),
				// 2026-11-12 (owner, pass 2): the items are spaced by the layout, not by a mark between them.
				element("p", { class: "report-meta" }, meta.filter(Boolean)),
				chips,
			),
			outline,
			element("div", { class: "report-body" }, empty, content),
		),
	);
	actions.insertBefore(reportPageButton(view), openButton);
	const center = $("center");
	graphControl?.destroy();
	graphControl = null;
	center.replaceChildren(view);
	view.scrollTop = scroll;
	if (!old || old.dataset.run !== run.runId)
		view.focus({ preventScroll: true });
	if (!run.reportAvailable) return;
	api(`/api/runs/${encodeURIComponent(run.runId)}/report`)
		.then((data) => {
			if (generation !== reportGeneration || !view.isConnected) return;
			content.replaceChildren();
			loaded = data.text;
			copyButton.disabled = false;
			const found = renderReport(content, data.text);
			const filters = findingFilters(content, found, empty);
			if (filters) chips.replaceChildren(filters);
			const nav = reportOutline(content, view);
			if (nav) outline.replaceWith(nav);
			view.scrollTop = scroll;
			if (data.truncated)
				content.append(
					element("p", { class: "muted" }, "Report truncated by the host."),
				);
		})
		.catch((error) => {
			if (generation === reportGeneration)
				content.textContent = `Report unavailable: ${error.message}`;
		});
}
function openStatusKey() {
	openDialog("key", [
		element("h2", { id: "dialog-title" }, "Status key"),
		...[
			"completed",
			"running",
			"retry",
			"blocked",
			"failed",
			"pending",
			"interrupted",
		].map((status) =>
			element(
				"p",
				{ class: "row" },
				glyph(status),
				status === "retry"
					? "Auto-retry, no action"
					: status === "blocked"
						? "Needs you"
						: labels[status],
			),
		),
		element(
			"p",
			{ class: "muted" },
			"Amber marks executor decisions. Red marks failures.",
		),
		element(
			"p",
			{ class: "muted" },
			"A card titled “n in parallel” stacks stages that share the same inputs and outputs; each row is one stage. Hover or focus a card to light its connections.",
		),
		element("h3", {}, "Arrows"),
		...[
			["active", "Work is flowing into this stage now"],
			["next", "Where work goes next (dashed outline: the next stage)"],
			[
				"done",
				"Already travelled. Dots appear only when agents hand off work.",
			],
			["later", "Later"],
		].map(([state, text]) =>
			element(
				"p",
				{ class: "row" },
				svg(
					"svg",
					{
						class: "edge-sample",
						width: 44,
						height: 12,
						viewBox: "0 0 44 12",
						"aria-hidden": "true",
					},
					svg("path", { class: `edge ${state}`, d: "M1,6 H34" }),
					svg("path", {
						class: `arrow-sample ${state}`,
						d: "M33,1.5 L42,6 L33,10.5 Q35.5,6 33,1.5 z",
					}),
				),
				text,
			),
		),
		button("Close", () => dismissDialog(false), { "data-cancel": "true" }),
	]);
}
function openPalette() {
	if (!session) return;
	const input = element("input", {
		class: "palette-input",
		type: "search",
		placeholder: "Search runs and stages…",
		role: "combobox",
		"aria-label": "Command palette",
		"aria-expanded": "true",
		"aria-controls": "palette-results",
	});
	const list = element("div", {
		class: "palette-list",
		id: "palette-results",
		role: "listbox",
	});
	let selected = 0,
		matches = [];
	// 2026-11-12 (QA): a run reads as its workflow and task (not a bare id), with its state and age;
	// the task is searchable too. Names that start with the query come first, so "triage" + Enter
	// still opens the triage stage.
	const entries = [
		...runs.map((r) => {
			const [, word] = railStatus(r);
			return {
				group: "Runs",
				label: r.name,
				detail: r.taskPreview || r.runId,
				meta: [word || labels[r.status] || r.status, ago(r.createdAt)]
					.filter(Boolean)
					.join(", "),
				search: `${r.name} ${r.taskPreview || ""} ${r.runId} ${r.status}`,
				choose: () => go({ run: r.runId, dialog: null, view: null }),
			};
		}),
		...[...(graphModel?.stages.values() || [])]
			.filter((s) => !s.ghost)
			.map((s) => ({
				group: "Stages in this run",
				label: humanize(s.id),
				detail: s.id,
				meta: "",
				search: `${s.id} ${humanize(s.id)}`,
				choose: () => {
					state.dialog = null;
					chooseStage(s);
				},
			})),
	];
	function paint() {
		const query = input.value.trim().toLowerCase();
		const rank = (entry) =>
			!query ||
			entry.label.toLowerCase().startsWith(query) ||
			entry.detail.toLowerCase().startsWith(query)
				? 0
				: entry.label.toLowerCase().includes(query)
					? 1
					: 2;
		matches = entries
			.filter((entry) => entry.search.toLowerCase().includes(query))
			.map((entry, order) => ({ entry, order }))
			.sort((a, b) => rank(a.entry) - rank(b.entry) || a.order - b.order)
			.map(({ entry }) => entry);
		selected = Math.max(0, Math.min(selected, matches.length - 1));
		list.replaceChildren();
		let group = null;
		matches.forEach((entry, i) => {
			if (!query && entry.group !== group) {
				group = entry.group;
				list.append(
					element(
						"div",
						{ class: "palette-group", role: "presentation" },
						group,
					),
				);
			}
			list.append(
				button(
					[
						element(
							"span",
							{ class: "palette-main" },
							element("span", { class: "palette-label" }, entry.label),
							element("span", { class: "palette-detail" }, entry.detail),
						),
						entry.meta
							? element("span", { class: "palette-meta" }, entry.meta)
							: null,
					],
					() => {
						dismissDialog(false);
						entry.choose();
					},
					{
						role: "option",
						id: `palette-${i}`,
						"aria-selected": String(i === selected),
						tabindex: "-1",
					},
				),
			);
		});
		if (!matches.length)
			list.append(element("p", { class: "muted" }, "No matches"));
		input.setAttribute(
			"aria-activedescendant",
			matches.length ? `palette-${selected}` : "",
		);
		document
			.getElementById(`palette-${selected}`)
			?.scrollIntoView({ block: "nearest" });
	}
	input.addEventListener("input", () => {
		selected = 0;
		paint();
	});
	input.addEventListener("keydown", (event) => {
		if (["ArrowDown", "ArrowUp"].includes(event.key)) {
			event.preventDefault();
			selected += event.key === "ArrowDown" ? 1 : -1;
			paint();
		}
		if (event.key === "Enter" && matches[selected]) {
			event.preventDefault();
			const entry = matches[selected];
			dismissDialog(false);
			entry.choose();
		}
	});
	openDialog("palette", [
		element("h2", { id: "dialog-title" }, "Jump to run, stage"),
		input,
		list,
	]);
	paint();
	input.focus();
}
async function refreshRuns() {
	const data = await api("/api/runs");
	syncClock(data.serverTime);
	runs = data.runs;
	if (allNeeds().some(dismissible)) await refreshNotices();
	renderTop();
	renderRail();
	if (homeShown()) renderHome();
}
function acceptRun(data) {
	if (data.runId !== state.run) return;
	if (
		run &&
		(date(data.updatedAt) < date(run.updatedAt) ||
			JSON.stringify(data) === JSON.stringify(run))
	)
		return;
	const handoffs = taskHandoffs(run, data);
	const first = !run;
	runRevision++;
	run = data;
	// Only a fresh, implicit entry chooses a landing. SSE completion never navigates.
	if (
		first &&
		!runLandingSeen.has(`${state.project}:${data.runId}`) &&
		!state.view &&
		!state.task &&
		!state.stage &&
		!state.tab &&
		!new URLSearchParams(location.search).has("layout")
	) {
		if (data.status === "completed" && data.reportAvailable)
			state.view = "report";
		else if (
			["failed", "interrupted", "blocked"].includes(data.status) &&
			!data.verdictGate
		) {
			const stopped = data.tasks.find((task) =>
				["failed", "interrupted", "blocked"].includes(task.status),
			);
			if (stopped) state.task = stopped.specId;
		} else if (liveRun(data)) {
			const active = data.tasks.find(
				(task) => task.status === "running" && !task.placeholder,
			);
			if (active) state.task = active.specId;
		}
		urlState(true);
	}
	runLandingSeen.add(`${state.project}:${data.runId}`);
	if (!liveRun(run)) stoppingRuns.delete(run.runId);
	const index = runs.findIndex((r) => r.runId === run.runId);
	if (index >= 0) runs[index] = run;
	// URL contract uses spec IDs; Needs-you entries may carry task IDs.
	if (state.task) {
		const task = selectedTask();
		if (task && task.specId !== state.task) {
			state.task = task.specId;
			urlState(true);
		}
	}
	renderRail();
	renderRun();
	requestAnimationFrame(() => {
		if (run === data) graphControl?.handoff(handoffs);
	});
}
/** Diff projections, not redraws: initial loads and repeated SSE snapshots send no packets. */
export function taskHandoffs(previous, next) {
	if (!previous || previous.runId !== next.runId) return [];
	const old = new Map(previous.tasks.map((t) => [t.specId, t]));
	return next.tasks.flatMap((task) => {
		if (task.placeholder || old.get(task.specId)?.status === task.status)
			return [];
		if (task.status === "running")
			return [{ stageId: task.stageId, kind: "start", tone: "ok" }];
		if (["completed", "failed"].includes(task.status))
			return [
				{
					stageId: task.stageId,
					kind: "complete",
					tone: task.status === "failed" ? "err" : task.outcome?.tone || "ok",
				},
			];
		return [];
	});
}
async function refreshRun() {
	const id = state.run,
		generation = loadGeneration,
		revision = runRevision;
	const data = await api(`/api/runs/${encodeURIComponent(id)}`, {
		signal: AbortSignal.any([
			selectionController.signal,
			AbortSignal.timeout(20000),
		]),
	});
	if (
		generation === loadGeneration &&
		id === state.run &&
		revision === runRevision
	)
		acceptRun(data);
}
function stopEvents() {
	clearTimeout(reconnectTimer);
	eventSource?.close();
	eventSource = null;
}
function connectEvents() {
	stopEvents();
	const id = state.run,
		generation = loadGeneration;
	const source = new EventSource(
		`/api/events?project=${encodeURIComponent(state.project)}${id ? `&run=${encodeURIComponent(id)}` : ""}`,
	);
	eventSource = source;
	const receive = (handler) => (event) => {
		if (eventSource !== source || generation !== loadGeneration) return;
		try {
			const data = event.data ? JSON.parse(event.data) : null;
			lastEvent = Date.now();
			connection = "Live";
			backoff = 1000;
			updateConnection();
			handler(data);
		} catch {
			notice("An update could not be read. Reconnecting…");
			reconnect();
		}
	};
	source.addEventListener(
		"runs",
		receive((data) => {
			syncClock(data.serverTime);
			runs = data.runs;
			renderTop();
			renderRail();
			// No run open: the overview follows the run list.
			if (homeShown()) renderHome();
		}),
	);
	source.addEventListener(
		"run",
		receive((data) => {
			if (data?.runId === state.run) acceptRun(data);
		}),
	);
	source.addEventListener(
		"heartbeat",
		receive(() => {}),
	);
	function reconnect() {
		if (eventSource !== source) return;
		source.close();
		eventSource = null;
		connection = "Reconnecting";
		updateConnection();
		const wait = backoff;
		backoff = Math.min(30000, backoff * 2);
		reconnectTimer = setTimeout(async () => {
			if (generation !== loadGeneration) return;
			// A dashboard that was restarted has a new session: this tab's cookie is now refused
			// (401). Say so instead of reconnecting forever behind a "Stale" badge.
			if (await sessionLost()) {
				connection = "Signed out";
				updateConnection();
				notice(
					"The dashboard was restarted. Open the new URL printed by agent-workflow dashboard.",
				);
				return;
			}
			connectEvents();
		}, wait);
	}
	source.onerror = reconnect;
}
async function loadRun() {
	++loadGeneration;
	selectionController?.abort();
	selectionController = new AbortController();
	stopEvents();
	graphControl?.destroy();
	graphControl = null;
	run = null;
	workflowTarget = null;
	graphModel = null;
	logController?.abort();
	logGeneration++;
	logKey = "";
	logData = null;
	logLoading = false;
	if (modalKey) dismissDialog(false);
	$("inspector").hidden = true;
	$("inspector").inert = true;
	$("body").classList.remove("inspecting");
	applyRail();
	// Switching runs (owner: smoother): the previous run stays, dimmed and inert, until the next
	// one is drawn, instead of flashing an empty "Loading run…" page.
	const center = $("center");
	if (center.querySelector(".run-header")) {
		center.classList.add("switching");
		center.inert = true;
	} else
		center.replaceChildren(element("p", { class: "empty" }, "Loading run…"));
	connection = "Reconnecting";
	lastEvent = 0;
	updateConnection();
	renderRail();
	const generation = loadGeneration;
	const project = state.project,
		runId = state.run;
	api(
		`/api/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}/workflow-settings-target`,
	)
		.then((target) => {
			if (
				generation === loadGeneration &&
				state.project === project &&
				state.run === runId
			) {
				workflowTarget = target;
				if (run) renderRun();
			}
		})
		.catch(() => {
			if (
				generation === loadGeneration &&
				state.project === project &&
				state.run === runId
			) {
				workflowTarget = { reason: "recorded source lookup unavailable" };
				if (run) renderRun();
			}
		});
	const settle = () => {
		if (!center.classList.contains("switching")) return;
		center.classList.remove("switching");
		center.inert = false;
		if (!reducedMotion())
			center.animate([{ opacity: 0.4 }, { opacity: 1 }], {
				duration: MOTION.base,
				easing: "ease-out",
			});
	};
	try {
		await refreshRun();
		if (generation === loadGeneration) settle();
	} catch (error) {
		if (generation !== loadGeneration || error.name === "AbortError") return;
		settle();
		$("center").replaceChildren(
			element(
				"div",
				{ class: "empty" },
				element("p", {}, `Run unavailable: ${error.message}`),
				button("Try again", loadRun),
			),
		);
	}
	if (generation === loadGeneration) connectEvents();
}
$("dialog").addEventListener("cancel", (event) => {
	event.preventDefault();
	dismissDialog(!["palette", "key"].includes(modalKey));
});
$("dialog").addEventListener("click", (event) => {
	if (event.target === $("dialog")) {
		const r = event.target.getBoundingClientRect();
		if (
			event.clientX < r.left ||
			event.clientX > r.right ||
			event.clientY < r.top ||
			event.clientY > r.bottom
		)
			dismissDialog(!["palette", "key"].includes(modalKey));
	}
});
// Focus without fragment navigation: management popstate reloads would discard drafts.
$("skip-content").addEventListener("click", (event) => {
	event.preventDefault();
	$("center").focus();
});
// Readers describe only values that Save writes, never graph/view state. Snapshot
// before mounting controls, so deferred graph/catalog work cannot bless a user edit.
const settingsDrafts = new Set();
function draftSnapshot(value) {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
				)
			: item,
	);
}
function settingsDraft(node, read) {
	let baseline = draftSnapshot(read());
	const draft = {
		node,
		dirty: () => !readonly() && draftSnapshot(read()) !== baseline,
		snapshot: () => draftSnapshot(read()),
		saved: (snapshot) => {
			baseline = snapshot;
		},
		clear: () => settingsDrafts.delete(draft),
	};
	settingsDrafts.add(draft);
	return draft;
}
function hasSettingsDraft() {
	for (const draft of settingsDrafts) {
		if (!draft.node.isConnected) settingsDrafts.delete(draft);
		else if (draft.dirty()) return true;
	}
	return false;
}
function approveSettingsDiscard() {
	return (
		!hasSettingsDraft() ||
		window.confirm("Discard unsaved settings changes? Cancel to keep editing.")
	);
}
function discardSettingsDrafts() {
	if (!approveSettingsDiscard()) return false;
	settingsDrafts.clear();
	return true;
}
window.addEventListener("beforeunload", (event) => {
	if (!hasSettingsDraft()) return;
	event.preventDefault();
	event.returnValue = "";
});
// App-owned ordinary links get an app confirmation even where native departure
// dialogs are suppressed. Bubble after target handlers (profile rows own theirs).
document.addEventListener("click", (event) => {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	)
		return;
	const link = event.target.closest?.("a[href]");
	if (
		!link ||
		link.hasAttribute("download") ||
		(link.target && link.target.toLowerCase() !== "_self")
	)
		return;
	const destination = new URL(link.href, location.href);
	if (!["http:", "https:"].includes(destination.protocol)) return;
	if (
		destination.origin === location.origin &&
		destination.pathname === location.pathname &&
		destination.search === location.search &&
		link.href.includes("#")
	)
		return;
	if (!discardSettingsDrafts()) event.preventDefault();
});
// Without Navigation API, tag only our existing/app-created entries; never add a
// sentinel or infer position from history.length. Keep other history state intact.
function settingsHistoryState(value, replace = false) {
	if (window.navigation) return value;
	const index = history.state?.dashboardHistoryIndex;
	return {
		...(replace ? history.state : {}),
		...value,
		dashboardHistoryIndex:
			(Number.isInteger(index) ? index : 0) + (replace ? 0 : 1),
	};
}
if (
	!window.navigation &&
	!Number.isInteger(history.state?.dashboardHistoryIndex)
)
	history.replaceState(
		settingsHistoryState(history.state, true),
		"",
		location.href,
	);
const currentSettingsHistoryIndex = () =>
	window.navigation?.currentEntry?.index ??
	history.state?.dashboardHistoryIndex;
// Scripted same-document traversal can be refused before it commits. Browser
// toolbar traversals are not cancelable in Chrome: popstate restores their real
// entry with go(), then asks, preserving every forward entry (never pushState).
let settingsHistoryIndex = currentSettingsHistoryIndex();
let settingsHistoryReturn = null;
window.navigation?.addEventListener("navigate", (event) => {
	if (settingsHistoryReturn) return;
	if (
		event.navigationType !== "traverse" ||
		!event.destination.sameDocument ||
		!event.cancelable
	)
		return;
	if (!discardSettingsDrafts()) event.preventDefault();
});
let profileListReturn = null;
window.addEventListener("popstate", () => {
	const index = currentSettingsHistoryIndex();
	if (settingsHistoryReturn) {
		const target = settingsHistoryReturn;
		settingsHistoryReturn = null;
		if (discardSettingsDrafts()) history.go(target.index - index);
		return;
	}
	if (
		hasSettingsDraft() &&
		Number.isInteger(index) &&
		Number.isInteger(settingsHistoryIndex) &&
		index !== settingsHistoryIndex
	) {
		settingsHistoryReturn = { index };
		history.go(settingsHistoryIndex - index);
		return;
	}
	settingsHistoryIndex = index;
	if (profileListReturn) {
		const done = profileListReturn;
		profileListReturn = null;
		done();
		return;
	}
	if (
		managementView() ||
		["workflows", "profiles", "executors", "history"].includes(readState().view)
	) {
		location.reload();
		return;
	}
	if (readState().project !== state.project) {
		location.reload();
		return;
	}
	const previous = state.run;
	state = readState();
	if (modalKey) dismissDialog(false);
	if (state.run !== previous) {
		if (state.run) loadRun();
		else showHome();
	} else if (run) renderRun();
	else if (homeShown()) renderHome();
});
document.addEventListener("keydown", (event) => {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		if (modalKey === "palette") dismissDialog(false);
		else openPalette();
		return;
	}
	if (event.key === "Escape" && !$("dialog").open) {
		if (railOpen) toggleRail(false);
		else closeInspector();
		return;
	}
	if (
		$("dialog").open ||
		event.target.closest("input,textarea,select") ||
		event.metaKey ||
		event.ctrlKey ||
		event.altKey
	)
		return;
	if (event.key.toLowerCase() === "f") graphControl?.fit();
	if (["j", "k"].includes(event.key) && selectedTask())
		$("inspector")
			.querySelector(
				`[data-nav="${event.key === "j" ? "next" : "previous"}"]:not([disabled])`,
			)
			?.click();
	if (["ArrowDown", "ArrowUp"].includes(event.key)) {
		const selector = event.target.closest(".item-list")
			? ".item-list button"
			: !event.target.closest(".canvas,.inspector")
				? ".run-row"
				: null;
		if (!selector) return;
		const items = [...document.querySelectorAll(selector)];
		if (!items.length) return;
		event.preventDefault();
		let index = items.indexOf(document.activeElement);
		if (index < 0)
			index = items.findIndex((item) => item.dataset.run === state.run);
		items[
			Math.max(
				0,
				Math.min(
					items.length - 1,
					index + (event.key === "ArrowDown" ? 1 : -1),
				),
			)
		]?.focus();
	}
});
setInterval(() => {
	updateConnection();
	for (const node of document.querySelectorAll("[data-run-elapsed]")) {
		const summary = runs.find(
			(summary) => summary.runId === node.dataset.runElapsed,
		);
		if (summary) node.textContent = railElapsed(summary);
	}
	for (const node of document.querySelectorAll("[data-ago]"))
		node.textContent = whenText(node.dataset.ago);
	if (!run) return;
	refreshGraphTexts();
	if (liveRun(run)) refreshTimeline();
	if ($("status-sentence"))
		$("status-sentence").replaceChildren(...sentenceParts());
	if ($("hero-sub")) $("hero-sub").textContent = heroSubline();
	for (const node of document.querySelectorAll("[data-item-time]")) {
		const task = run.tasks.find((t) => t.specId === node.dataset.itemTime);
		if (task) node.textContent = itemTime(task);
	}
	const task = selectedTask();
	if (task && $("task-status")) $("task-status").textContent = taskLine(task);
}, 1000);
/** Live texts inside the drawn graph (stage lines of running/retry stages, agent states). */
function refreshGraphTexts() {
	if (!run) return;
	for (const node of $("canvas")?.querySelectorAll("[data-stage-line]") || []) {
		const stage = graphModel?.stages.get(node.dataset.stageLine);
		if (stage && ["running", "retry"].includes(stage.status)) {
			const text = stageLine(stage);
			node.dataset.full = text;
			if (node.firstElementChild) node.firstElementChild.textContent = text;
		}
	}
	for (const node of $("canvas")?.querySelectorAll("[data-agent-state]") ||
		[]) {
		const task = run.tasks.find((t) => t.specId === node.dataset.agentState);
		if (task) {
			const text = agentState(task);
			node.dataset.full = text;
			if (node.firstElementChild) node.firstElementChild.textContent = text;
			else node.textContent = text;
		}
	}
}
setInterval(() => {
	if (
		!document.hidden &&
		selectedTask()?.hasLogs &&
		liveRun(run) &&
		!logLoading
	)
		loadLogs();
}, 3000);
window.addEventListener("pagehide", () => {
	stopEvents();
	selectionController?.abort();
	logController?.abort();
});
window.addEventListener("pageshow", (event) => {
	if (event.persisted && session && state.project) loadRun();
});
const PROJECT_KEY = "agent-workflow:project";
function selectProject(id) {
	if (!discardSettingsDrafts()) {
		const chooser = document.querySelector('[aria-label="Project"]');
		if (chooser) chooser.value = state.project || "all";
		return;
	}
	try {
		localStorage.setItem(PROJECT_KEY, id);
	} catch {
		/* Storage is optional. */
	}
	location.assign(
		`/?project=${encodeURIComponent(id)}${managementView() ? `&view=${state.view}` : ""}`,
	);
}
function renderOverview() {
	lastEvent = Date.now();
	connection = "Live";
	renderTop();
	renderRail();
	$("center").replaceChildren(
		element(
			"section",
			{ class: "projects-overview" },
			element("h1", {}, "All projects"),
			element(
				"p",
				{ class: "muted" },
				overviewSummary(
					projects.length,
					projects.reduce((n, p) => n + p.counts.running, 0),
					projects.reduce((n, p) => n + p.counts.needsAttention, 0),
				),
			),
			projects.length
				? projects.map((project) =>
						element(
							"article",
							{ class: "project-card" },
							button(project.name, () => selectProject(project.id)),
							element(
								"p",
								{ class: "muted" },
								project.path,
								project.pathMissing ? ", path missing" : "",
							),
							element(
								"p",
								{},
								`${project.counts.running} active, ${project.counts.needsAttention} need attention`,
							),
							project.counts.lastActivity
								? element(
										"small",
										{ class: "muted" },
										`Last activity ${ago(project.counts.lastActivity)}`,
									)
								: null,
						),
					)
				: element(
						"p",
						{},
						"No projects yet. Start a workflow from your terminal.",
					),
		),
	);
}
/**
 * 2026-11-12 (owner): the project overview is what the dashboard opens to when no run is chosen
 * (`/?project=…`): what needs you, what runs now, the latest results, the workflows and the
 * project's totals. It reads the run list only; the run list carries each run's cost, agent
 * reporting counts and active time (projection.ts), so no run's detail is fetched.
 */
let showStopped = false;
/** The management page's own address (the overview's "Manage →", a workflow's name). */
function managementHref(view) {
	const params = new URLSearchParams();
	if (state.project) params.set("project", state.project);
	params.set("view", view);
	return `/?${params}`;
}
const homeShown = () =>
	Boolean(state.project) &&
	!state.run &&
	state.view !== "runs" &&
	!managementView();
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
};
/** The look of one run in a strip of squares: glyph status → tone. */
const STRIP_TONES = {
	completed: "ok",
	attention: "warn",
	blocked: "warn",
	failed: "err",
	interrupted: "stop",
	running: "run",
	pending: "run",
};
function openNeed(need) {
	// 2026-11-12 (owner, pass 2): look first. The run opens with the failing task selected and the
	// inspector showing what failed and why; "Resume…" is a button the person presses on the run.
	const target =
		need.run.runId === run?.runId
			? run.tasks.find((t) => [t.taskId, t.specId].includes(need.taskId))
					?.specId
			: need.taskId;
	go({ run: need.run.runId, task: target || null, dialog: null });
}
/**
 * "5m ago" for a day, then the date and time: a column of "1d ago" tells rows apart no better
 * than no time at all (2026-11-12, review P3-5).
 */
function whenText(value, time = now()) {
	if (time - date(value) < 86_400_000) return ago(value, time);
	return new Date(date(value)).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}
function timeAgo(value) {
	return element(
		"span",
		{
			"data-ago": value,
			title: new Date(date(value)).toLocaleString(),
		},
		whenText(value),
	);
}
function resultChip(summary) {
	const [tone, word] = resultBadge(summary);
	return element(
		"span",
		{ class: `result-badge small ${tone}`, "data-tone": tone },
		glyph(tone),
		element("strong", {}, word),
	);
}
function costCell(summary) {
	if (summary.cost?.costUsd == null) return null;
	const label = costLabel([summary.cost]);
	return element(
		"span",
		{
			class: `home-cost${label.text === "n/a" ? " muted" : ""}`,
			title: summary.cost ? label.title : "Cost not reported",
		},
		label.text,
	);
}
function homeNeeds() {
	const needs = visibleNeeds();
	if (!needs.length)
		return element("p", { class: "home-calm" }, "Nothing needs you.");
	return needs.map((need) => {
		const agents = need.run.agentSummary;
		// 2026-11-12 (owner, pass 2): the card leads with the run's identity as everywhere else (its
		// workflow and task), then why it needs you, how far it got and when.
		return element(
			"article",
			{ class: `home-need ${need.kind}`, "data-run": need.run.runId },
			glyph(
				need.kind === "decision"
					? "blocked"
					: need.kind === "stopped"
						? "interrupted"
						: "failed",
			),
			element(
				"div",
				{ class: "home-need-body" },
				element("strong", {}, need.run.name),
				need.run.taskPreview
					? element(
							"p",
							{ class: "home-task muted", title: need.run.taskPreview },
							need.run.taskPreview,
						)
					: null,
				element(
					"p",
					{ class: "home-need-reason" },
					element("b", {}, needReason(need)),
					agents
						? element(
								"span",
								{ class: "muted" },
								`${agents.completed} of ${agents.total} agents finished`,
							)
						: null,
					element("span", { class: "muted" }, ago(need.since)),
				),
				element(
					"div",
					{ class: "home-need-actions" },
					button("Inspect", () => openNeed(need), {
						class: "primary small",
					}),
					dismissible(need)
						? button("Dismiss", () => setNeedDismissed([need], true), {
								class: "small",
								title: DISMISS_TITLE,
							})
						: null,
				),
			),
		);
	});
}
function runLink(summary, children, className, view) {
	return element(
		"a",
		{
			class: className,
			href: `${runHref(summary.runId)}${view ? `&view=${view}` : ""}`,
			"data-run": summary.runId,
			onclick: (event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey) return;
				event.preventDefault();
				go({ run: summary.runId, ...(view ? { view } : {}) });
			},
		},
		children,
	);
}
function homeRunning(running) {
	if (!running.length)
		return element("p", { class: "home-calm" }, "Nothing running right now.");
	return running.map((summary) => {
		const counts = summary.agentSummary || summary.taskSummary;
		return runLink(
			summary,
			[
				element(
					"span",
					{ class: "home-row-main" },
					glyph("running"),
					element("strong", {}, summary.name),
					element(
						"span",
						{ class: "muted home-row-count" },
						railCount(counts, Boolean(summary.agentSummary)),
					),
					element(
						"span",
						{ class: "muted", "data-run-elapsed": summary.runId },
						railElapsed(summary),
					),
				),
				summary.taskPreview
					? element(
							"span",
							{ class: "home-task faint", title: summary.taskPreview },
							summary.taskPreview,
						)
					: null,
				progress(counts.completed, counts.total, summary.status),
			],
			"home-row running",
		);
	});
}
let showAll = false;
function homeRecent(finished, stopped) {
	// "Show all" lifts the cap of eight and brings the stopped runs with it, in place.
	const shown = (
		showStopped || showAll
			? finished
			: finished.filter((summary) => summary.status !== "interrupted")
	).slice(0, showAll ? Infinity : 8);
	return [
		shown.length
			? element(
					"div",
					{ class: "home-list" },
					shown.map((summary) => {
						const agents = summary.agentSummary;
						return runLink(
							summary,
							[
								resultChip(summary),
								// 2026-11-12 (review, P2-8): the workflow leads (it tells rows apart), then its
								// agents after a gap; the task the run was given is the quiet line below.
								element(
									"span",
									{ class: "home-row-title" },
									element(
										"span",
										{ class: "home-row-name" },
										element(
											"span",
											{ class: "home-row-wf", title: summary.name },
											summary.name,
										),
										agents
											? element(
													"span",
													{ class: "home-row-agents muted" },
													`${agents.completed} of ${agents.total} agents`,
												)
											: null,
									),
									summary.taskPreview
										? element(
												"span",
												{ class: "home-row-task", title: summary.taskPreview },
												summary.taskPreview,
											)
										: null,
								),
								// Date, duration and cost each have their own column (owner, pass 2).
								element(
									"span",
									{ class: "home-row-date muted" },
									timeAgo(summary.updatedAt),
								),
								summary.activeMs != null
									? element(
											"span",
											{ class: "home-row-dur", title: "Active time" },
											duration(summary.activeMs),
										)
									: null,
								costCell(summary),
							],
							"home-row recent",
							summary.reportAvailable ? "report" : undefined,
						);
					}),
				)
			: element(
					"p",
					{ class: "home-calm" },
					stopped && !showStopped
						? "No results to show. Stopped runs are hidden."
						: "No finished runs yet.",
				),
		showAll || finished.length > shown.length
			? button(
					showAll ? "Show fewer" : `Show all ${finished.length}`,
					() => {
						showAll = !showAll;
						renderHome();
					},
					{ class: "small home-toggle home-all", "data-home-key": "all" },
				)
			: null,
	];
}
function homeWorkflows(all) {
	const groups = new Map();
	for (const summary of [...all].sort(
		(a, b) => date(a.createdAt) - date(b.createdAt),
	)) {
		if (!groups.has(summary.name)) groups.set(summary.name, []);
		groups.get(summary.name).push(summary);
	}
	const rows = [...groups.entries()]
		.map(([name, list]) => ({
			name,
			list,
			updated: Math.max(...list.map((summary) => date(summary.updatedAt))),
		}))
		.sort((a, b) => b.updated - a.updated);
	// 2026-11-12 (owner, pass 2): a real table. The columns have fixed widths (app.css), so every
	// row has them at the same x; "Median" and "Last runs" drop out when the table is narrow.
	const columns = [
		["wf", "Workflow", ""],
		["runs", "Runs", "n"],
		["last", "Last result", ""],
		["median", "Median", "n"],
		["cost", "Cost", "n"],
		["strip", "Last runs", ""],
	];
	const unknown = () => null;
	return element(
		"div",
		{ class: "home-table-wrap" },
		element(
			"table",
			{ class: "home-table" },
			element(
				"colgroup",
				{},
				columns.map(([key]) => element("col", { class: `c-${key}` })),
			),
			element(
				"thead",
				{},
				element(
					"tr",
					{},
					columns.map(([key, label, align]) => {
						const titles = {
							last: "The latest run that finished; a stopped run is not a result",
							median: "Median active time of completed runs",
							cost: "Reported cost. + means some agents did not report; code steps are not counted",
						};
						return element(
							"th",
							{ class: `c-${key} ${align}`.trim(), title: titles[key] },
							label,
						);
					}),
				),
			),
			element(
				"tbody",
				{},
				rows.map(({ name, list }) => {
					// 2026-11-12 (owner): the last run that finished, not one that was stopped or is
					// still going.
					const last =
						list.findLast((summary) =>
							["completed", "failed"].includes(summary.status),
						) ?? list.at(-1);
					const completed = list
						.filter((summary) => summary.status === "completed")
						.map((summary) => summary.activeMs)
						.filter((value) => value != null);
					const middle = median(completed);
					const label = costLabel(list.map((summary) => summary.cost));
					const strip = list.slice(-12);
					return element(
						"tr",
						{ "data-workflow": name },
						element(
							"td",
							{ class: "c-wf", "data-label": "Workflow" },
							element(
								"a",
								{ href: managementHref("workflows"), title: name },
								name,
							),
						),
						element(
							"td",
							{ class: "c-runs n", "data-label": "Runs" },
							list.length,
						),
						element(
							"td",
							{ class: "c-last", "data-label": "Last result" },
							runLink(
								last,
								resultChip(last),
								"home-last-result",
								last.reportAvailable ? "report" : undefined,
							),
						),
						element(
							"td",
							{
								class: "c-median n",
								"data-label": "Median",
								title: list.some((summary) => summary.status === "completed")
									? `Active time reported for ${completed.length} of ${list.filter((summary) => summary.status === "completed").length} completed ${list.filter((summary) => summary.status === "completed").length === 1 ? "run" : "runs"}`
									: "No completed runs",
							},
							middle == null ? unknown() : duration(middle),
						),
						element(
							"td",
							{
								class: "c-cost n",
								"data-label": "Cost",
								title: `${label.title}${label.runs ? `, ${label.runs} of ${list.length} runs reported` : ""}`,
							},
							// 2026-11-12 (review, P2-11): "$1.39+ 5/5" read as incomplete and complete at
							// once; the runs ratio is in the tooltip.
							label.text === "n/a"
								? unknown()
								: element("span", { class: "home-cost" }, label.text),
						),
						element(
							"td",
							{ class: "c-strip", "data-label": "Last runs" },
							element(
								"span",
								{
									class: "strip",
									role: "img",
									"aria-label": `Last ${strip.length} runs, oldest to newest: ${strip
										.map((summary) => resultBadge(summary)[1])
										.join(", ")}`,
								},
								strip.map((summary) => {
									const [tone, word] = resultBadge(summary);
									return element("i", {
										class: `sq ${STRIP_TONES[tone] || "run"}`,
										title: `${word}, ${new Date(date(summary.createdAt)).toLocaleString()}`,
									});
								}),
							),
						),
					);
				}),
			),
		),
		element(
			"p",
			{ class: "strip-legend faint" },
			element(
				"span",
				{},
				element("i", { class: "sq warn" }),
				"Findings or gaps",
			),
			element("span", {}, element("i", { class: "sq err" }), "Failed"),
			element("span", {}, element("i", { class: "sq stop" }), "Stopped"),
			element("span", {}, element("i", { class: "sq ok" }), "Clean"),
			element("span", {}, "Oldest → newest"),
		),
	);
}
function homeProject(all) {
	const done = all.filter(
			(summary) =>
				summary.status === "completed" ||
				(summary.status === "failed" && summary.verdictGate),
		).length,
		stopped = all.filter((summary) => summary.status === "interrupted").length,
		failed = all.filter(
			(summary) => summary.status === "failed" && !summary.verdictGate,
		).length,
		live = all.filter((summary) => summary.status === "running").length,
		waiting = all.filter((summary) => summary.status === "blocked").length;
	const label = costLabel(all.map((summary) => summary.cost));
	const timed = all.filter((summary) => summary.activeMs != null);
	const active = timed.reduce((sum, summary) => sum + summary.activeMs, 0);
	const stat = (value, name, note, title) =>
		element(
			"div",
			{ class: "home-stat" },
			element("div", { class: "home-stat-value", title }, value),
			element("div", { class: "home-stat-name" }, name),
			element("div", { class: "home-stat-note faint" }, note),
		);
	return element(
		"div",
		{ class: "home-stats" },
		stat(
			all.length,
			"runs",
			// Each part stays whole when the note wraps; the middle dot stays with the part before it.
			[
				`${done} done`,
				stopped ? `${stopped} stopped` : null,
				failed ? `${failed} failed` : null,
				live ? `${live} running` : null,
				waiting ? `${waiting} need${waiting === 1 ? "s" : ""} you` : null,
			]
				.filter(Boolean)
				.flatMap((part, index, parts) => [
					index ? " " : null,
					element(
						"span",
						{ class: "nowrap" },
						index < parts.length - 1 ? `${part},` : part,
					),
				]),
		),
		label.runs
			? stat(
					label.text,
					"spend",
					`${label.ratio}; ${label.runs} of ${all.length} runs reported`,
					label.title,
				)
			: null,
		timed.length
			? stat(
					duration(active),
					"active time",
					`${timed.length} of ${all.length} runs reported, not waiting`,
					"The time agents and steps were working; a run that sat waiting does not count it",
				)
			: null,
	);
}
/*
 * 2026-11-13 (owner: "too many choices"): cleaning up old runs is one line under the project's
 * numbers. The newest 50 finished runs stay (the CLI's default); the line shows only when older
 * runs can go, and Delete asks once, with the exact list. Other rules stay in the terminal
 * (`agent-workflow prune --keep N`). The server deletes only what this preview showed (digest).
 */
const CLEANUP_KEEP = 50;
let cleanup = {
	key: null,
	preview: null,
	confirming: false,
	message: null,
	error: null,
};
function refreshCleanup(force = false) {
	if (readonly() || !state.project || state.project === "all") return;
	const key = `${state.project}|${runs.length}`;
	if (!force && cleanup.key === key) return;
	const sameProject = cleanup.key?.startsWith(`${state.project}|`);
	cleanup = {
		key,
		preview: sameProject ? cleanup.preview : null,
		message: sameProject ? cleanup.message : null,
		confirming: false,
		error: null,
	};
	managementWrite(projectRoute("prune/preview"), "POST", { keep: CLEANUP_KEEP })
		.then((result) => {
			if (cleanup.key === key) cleanup.preview = result;
		})
		.catch(() => {
			if (cleanup.key === key) cleanup.preview = null;
		})
		.finally(() => {
			if (cleanup.key === key && homeShown()) renderHome();
		});
}
const cleanupRuns = (preview) =>
	(preview?.ok ? preview.data.runs || [] : []).filter(
		(entry) => entry.selected && !entry.protected,
	);
async function deleteOldRuns() {
	const shown = cleanup.preview;
	const going = cleanupRuns(shown);
	try {
		const result = await managementWrite(projectRoute("prune"), "POST", {
			keep: CLEANUP_KEEP,
			digest: shown.digest,
		});
		const deleted = (result.data.runs || []).filter((entry) => entry.deleted);
		cleanup.message = `Deleted ${deleted.length} ${deleted.length === 1 ? "run" : "runs"}, freeing ${formatBytes(result.data.deletedBytes)}.`;
		cleanup.preview = null;
		cleanup.confirming = false;
		await refreshRuns();
		refreshCleanup(true);
	} catch (error) {
		// 409: the runs changed since the preview; show the new list and ask again.
		if (error.data?.preview) cleanup.preview = error.data.preview;
		cleanup.error =
			error.status === 409
				? `The list changed (it was ${going.length}). Check it and delete again.`
				: error.message;
	}
	renderHome();
	$("home-view")
		.querySelector('[data-home-key^="cleanup"]')
		?.focus({ preventScroll: true });
}
function homeCleanup() {
	const going = cleanupRuns(cleanup.preview);
	const message = cleanup.message
		? element(
				"p",
				{ class: "home-cleanup-done", role: "status" },
				cleanup.message,
			)
		: null;
	if (!going.length) return message;
	const bytes = going.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
	const count = `${going.length} old ${going.length === 1 ? "run" : "runs"}`;
	const named = new Map(runs.map((summary) => [summary.runId, summary.name]));
	if (!cleanup.confirming)
		return element(
			"div",
			{ class: "home-cleanup" },
			element(
				"p",
				{},
				`${count} can be deleted (${formatBytes(bytes)})`,
				element(
					"small",
					{ class: "faint" },
					`The newest ${CLEANUP_KEEP} finished runs are kept.`,
				),
			),
			button(
				"Clean up…",
				() => {
					cleanup.confirming = true;
					cleanup.message = null;
					renderHome();
					$("home-view")
						.querySelector('[data-home-key="cleanup-cancel"]')
						?.focus({ preventScroll: true });
				},
				{ class: "small", "data-home-key": "cleanup" },
			),
		);
	return element(
		"div",
		{
			class: "home-cleanup confirming",
			role: "group",
			"aria-label": "Clean up old runs",
		},
		element(
			"p",
			{},
			`Delete ${count} and free ${formatBytes(bytes)}? This cannot be undone.`,
		),
		element(
			"details",
			{ class: "more-details" },
			element("summary", {}, "Which runs"),
			element(
				"ul",
				{ class: "home-cleanup-list" },
				going.map((entry) =>
					element(
						"li",
						{ "data-cleanup-run": entry.runId },
						element("span", {}, named.get(entry.runId) || entry.runId),
						element(
							"span",
							{ class: "muted" },
							`${whenText(entry.updatedAt)}, ${formatBytes(entry.bytes)}`,
						),
					),
				),
			),
		),
		cleanup.error
			? element(
					"p",
					{ role: "alert", class: "management-error" },
					cleanup.error,
				)
			: null,
		element(
			"div",
			{ class: "home-cleanup-actions" },
			button(
				`Delete ${going.length} ${going.length === 1 ? "run" : "runs"}`,
				deleteOldRuns,
				{
					class: "small danger",
					"data-home-key": "cleanup-delete",
				},
			),
			button(
				"Cancel",
				() => {
					cleanup.confirming = false;
					cleanup.error = null;
					renderHome();
					$("home-view")
						.querySelector('[data-home-key="cleanup"]')
						?.focus({ preventScroll: true });
				},
				{ class: "small", "data-home-key": "cleanup-cancel" },
			),
		),
	);
}
function renderHome() {
	const center = $("center");
	const previous = $("home-view");
	const scroll = previous?.scrollTop ?? 0;
	const maintenanceOpen =
		previous?.querySelector(".advanced-maintenance")?.open ||
		cleanup.confirming;
	const focused =
		document.activeElement?.closest("[data-home-key]")?.dataset.homeKey;
	const project = projects.find((entry) => entry.id === state.project);
	const all = [...runs].sort((a, b) => date(b.updatedAt) - date(a.updatedAt));
	if (!all.length) {
		center.replaceChildren(
			element(
				"p",
				{ class: "empty", id: "home-view" },
				"No runs in this project. Start one from your terminal.",
			),
		);
		return;
	}
	refreshCleanup();
	const running = all.filter((summary) => summary.status === "running");
	const needs = visibleNeeds();
	// 2026-11-12 (owner, pass 2): a run that needs you is listed under "Needs you" only; once it is
	// dismissed it is one of the results again.
	const needing = new Set(needs.map((need) => need.run.runId));
	const finished = all.filter(
		(summary) => summary.status !== "running" && !needing.has(summary.runId),
	);
	const stopped = finished.filter(
		(summary) => summary.status === "interrupted",
	).length;
	const oldest = all.reduce(
		(min, summary) => Math.min(min, date(summary.createdAt)),
		Infinity,
	);
	const calm = !needs.length && !running.length;
	// 2026-11-13 (owner): dismissed needs come back from here (the rail does the same beside a run).
	const hidden = allNeeds().filter(
		(need) => !needs.some((shown) => shown.key === need.key),
	);
	const restore = hidden.length
		? button(
				`Show ${hidden.length} dismissed`,
				() => {
					setNeedDismissed(hidden, false);
					$("home-view")
						.querySelector(".home-need button")
						?.focus({ preventScroll: true });
				},
				{ class: "small home-toggle", "data-home-key": "restore" },
			)
		: null;
	const section = (title, children, extra = null, id = null) =>
		element(
			"section",
			{ class: "home-section", id },
			element("h2", {}, element("span", {}, title), extra),
			children,
		);
	center.replaceChildren(
		element(
			"div",
			{ class: "home-view", id: "home-view" },
			element(
				"div",
				{ class: "home-grid" },
				// The project is in the top bar and the rail; the page says what it is (review, P3-4).
				element(
					"h1",
					{},
					"Overview",
					" ",
					element(
						"small",
						{},
						`${all.length} run${all.length === 1 ? "" : "s"} since ${new Date(oldest).toLocaleDateString([], { month: "short", day: "numeric" })}`,
					),
				),
				// 2026-11-12 (review, P2-9): with nothing to do and nothing running, one quiet line;
				// a section shows only when it has something to say.
				calm
					? element(
							"p",
							{ class: "home-status", id: "home-status" },
							"Nothing needs you and nothing is running.",
							restore,
						)
					: [
							section(
								"Needs you",
								homeNeeds(),
								restore ||
									(needs.length
										? element("span", { class: "faint" }, needs.length)
										: null),
								"home-needs",
							),
							section(
								"Running now",
								homeRunning(running),
								null,
								"home-running",
							),
						],
				section(
					"Recent results",
					homeRecent(finished, stopped),
					stopped && !showAll
						? button(
								showStopped
									? "Hide stopped runs"
									: `Show ${stopped} stopped run${stopped === 1 ? "" : "s"}`,
								() => {
									showStopped = !showStopped;
									renderHome();
									$("home-view")
										.querySelector("[data-home-key=stopped]")
										?.focus({ preventScroll: true });
								},
								{
									class: "small home-toggle",
									"data-home-key": "stopped",
								},
							)
						: null,
					"home-recent",
				),
				section(
					"This project",
					[
						homeProject(all),
						element(
							"details",
							{
								class: "advanced-maintenance",
								open: maintenanceOpen ? "" : null,
							},
							element("summary", {}, "Advanced maintenance"),
							element(
								"p",
								{},
								"Broad keep/age cleanup includes project runs and auto-router history, global executor adapter state and local host launch claims. This is not selected-record deletion. Owned worktrees (including dirty changes) and supported engine-owned sessions may be removed; no guaranteed undo.",
							),
							homeCleanup(),
						),
					],
					null,
					"home-project",
				),
				section(
					"Workflows",
					homeWorkflows(all),
					element(
						"a",
						{ class: "home-manage", href: managementHref("workflows") },
						"Manage →",
					),
					"home-workflows",
				),
			),
		),
	);
	const view = $("home-view");
	view.scrollTop = scroll;
	if (focused)
		view
			.querySelector(`[data-home-key="${CSS.escape(focused)}"]`)
			?.focus({ preventScroll: true });
}
/** The overview: no run is open; the run list keeps coming from the event stream. */
function showHome() {
	++loadGeneration;
	selectionController?.abort();
	logController?.abort();
	logGeneration++;
	stopEvents();
	graphControl?.destroy();
	graphControl = null;
	run = null;
	graphModel = null;
	if (modalKey) dismissDialog(false);
	$("inspector").hidden = true;
	$("inspector").inert = true;
	$("body").classList.remove("inspecting");
	applyRail();
	renderTop();
	renderRail();
	renderHome();
	connectEvents();
}
let overviewRefreshing = false;
setInterval(async () => {
	if (
		!session ||
		state.project ||
		managementView() ||
		document.hidden ||
		overviewRefreshing
	)
		return;
	overviewRefreshing = true;
	try {
		const next = (await api("/api/projects")).projects;
		lastEvent = Date.now();
		connection = "Live";
		if (JSON.stringify(next) !== JSON.stringify(projects)) {
			projects = next;
			renderOverview();
		} else updateConnection();
	} catch {
		connection = "Reconnecting";
		updateConnection();
		notice("Could not refresh projects. Try reloading the dashboard.");
	} finally {
		overviewRefreshing = false;
	}
}, 5000);
async function start() {
	try {
		session = await api("/api/session");
		syncClock(session.serverTime);
		projects = (await api("/api/projects")).projects;
		if (!state.project) {
			let remembered;
			try {
				remembered = localStorage.getItem(PROJECT_KEY);
			} catch {
				/* Storage is optional. */
			}
			state.project =
				remembered === "all"
					? "all"
					: projects.some((p) => p.id === remembered)
						? remembered
						: projects.length === 1
							? projects[0].id
							: "all";
		}
		if (
			state.project !== "all" &&
			!projects.some((project) => project.id === state.project)
		) {
			notice("This project is not registered. Showing all projects.");
			state.project = "all";
		}
		if (state.project === "all") {
			try {
				localStorage.setItem(PROJECT_KEY, "all");
			} catch {
				/* Storage is optional. */
			}
			state.project = null;
			state.run = null;
			if (managementView()) await renderManagement();
			else renderOverview();
			return;
		}
		try {
			localStorage.setItem(PROJECT_KEY, state.project);
		} catch {
			/* Storage is optional. */
		}
		urlState(true);
		if (managementView()) {
			await renderManagement();
			return;
		}
		await refreshRuns();
		// The nav's Runs item opens the latest run (a running one first), as the landing used to.
		// 2026-11-12 (review, P2-3): a stopped run is the last thing it should open.
		if (!state.run && state.view === "runs") {
			state.run =
				(
					runs.find((r) => r.status === "running") ||
					runs.find((r) => r.status !== "interrupted") ||
					runs[0]
				)?.runId || null;
			urlState(true);
		} else if (!state.run && state.view === "report") {
			// A report is a run's page: without its run there is nothing to open.
			state.view = null;
			urlState(true);
		}
		// 2026-11-12 (owner): with no run chosen the dashboard opens to the project overview.
		if (state.run) await loadRun();
		else showHome();
	} catch (error) {
		$("center").replaceChildren(
			element(
				"div",
				{ class: "empty" },
				element(
					"p",
					{},
					`Dashboard unavailable: ${error.message}. Use the URL printed by agent-workflow dashboard.`,
				),
				button("Try again", start),
			),
		);
	}
}
// Management pages use the same text-only components as run views. No launch endpoint or form.
function managementView() {
	return ["workflows", "profiles", "executors", "history"].includes(state.view);
}
const managementApi = (path, options = {}) =>
	api(path, { signal: AbortSignal.timeout(150000), ...options });
const projectRoute = (path) =>
	`/api/projects/${encodeURIComponent(state.project)}/${path}`;
function managementWrite(path, method, body = {}) {
	return managementApi(path, {
		method,
		headers: { "Content-Type": "application/json", "X-AW-CSRF": session.csrf },
		body: JSON.stringify(body),
	});
}
function field(label, control) {
	return element(
		"label",
		{ class: "management-field" },
		element("span", {}, label),
		control,
	);
}
function input(label, value = "", attrs = {}) {
	const control = element("input", { "aria-label": label, ...attrs });
	control.value = value;
	return control;
}
function choices(label, values, value = "") {
	const control = element(
		"select",
		{ "aria-label": label },
		values.map((entry) => {
			const [id, text] = Array.isArray(entry)
				? entry
				: [entry, entry || "Automatic"];
			return element("option", { value: id }, text);
		}),
	);
	control.value = value;
	return control;
}
// Deliberate diagnostics, with direct readable content rather than nested raw JSON folds.
function diagnosticView(label, ...content) {
	const body = element(
		"div",
		{ hidden: true, class: "management-diagnostics" },
		content,
	);
	const toggle = button(
		label,
		() => {
			body.hidden = !body.hidden;
			toggle.setAttribute("aria-expanded", String(!body.hidden));
		},
		{ "aria-expanded": "false" },
	);
	return element("div", {}, toggle, body);
}
function readableDiagnostic(value) {
	if (value === null || typeof value !== "object")
		return element("pre", {}, value === "" ? '""' : String(value));
	if (!Object.keys(value).length)
		return element("pre", {}, Array.isArray(value) ? "[]" : "{}");
	if (Array.isArray(value))
		return element(
			"ul",
			{},
			value.map((entry) => element("li", {}, readableDiagnostic(entry))),
		);
	return element(
		"dl",
		{ class: "diagnostic-fields" },
		Object.entries(value).map(([key, entry]) =>
			element(
				"div",
				{},
				element("dt", {}, key),
				element("dd", {}, readableDiagnostic(entry)),
			),
		),
	);
}
function managementResult(value, detailLabel = "Result details") {
	const data = value.data || value;
	const capability = data.capability;
	return element(
		"div",
		{ class: "management-result", role: "status" },
		value.text ? element("pre", {}, value.text) : readableDiagnostic(value),
		capability
			? element(
					"p",
					{ class: "management-check-limitations" },
					`Capability limitations: ${capability.degradations?.length ?? "see details"}. Forced read-only: ${capability.forcedReadOnly?.length ?? "see details"}. Review Check details before running.`,
				)
			: null,
		capability?.forcedReadOnly?.length
			? readableDiagnostic(capability.forcedReadOnly)
			: null,
		diagnosticView(detailLabel, readableDiagnostic(data)),
	);
}
function managementPanel(title, ...children) {
	return element(
		"section",
		{ class: "management-card" },
		element("h2", {}, title),
		children,
	);
}
// The actor is the dashboard user: no MCP confirmation dialogs. Errors stay beside their form.
function managementControl(
	label,
	action,
	output,
	{ write = true, ...attrs } = {},
) {
	const control = button(
		label,
		async () => {
			control.disabled = true;
			const working = element(
				"p",
				{ role: "status", class: "muted" },
				"Working…",
			);
			output.replaceChildren(working);
			try {
				await action();
			} catch (error) {
				output.replaceChildren(
					element(
						"p",
						{ role: "alert", class: "management-error" },
						error.message,
					),
				);
				if (error.data?.preview)
					output.append(managementResult(error.data.preview));
			} finally {
				working.remove();
				control.disabled = write && readonly();
			}
		},
		{
			disabled: write && readonly(),
			title: write && readonly() ? "Read-only mode" : null,
			...attrs,
		},
	);
	return control;
}
function commandHint(command) {
	return element(
		"div",
		{ class: "command" },
		element("pre", {}, command),
		button("Copy", () => copy(command)),
	);
}
// One styled, below-field menu for Executor, Model and Effort (2026-11-13, owner).
let activePicker = null;
let pickerId = 0;
document.addEventListener("pointerdown", (event) => {
	if (activePicker && !activePicker.node.contains(event.target))
		activePicker.close();
});
function choicePicker(
	label,
	values,
	value = "",
	{ editable = false, placeholder = "Automatic" } = {},
) {
	const id = `picker-${++pickerId}`;
	const control = input(label, value, {
		role: "combobox",
		"aria-controls": id,
		"aria-expanded": "false",
		"aria-haspopup": "listbox",
		"aria-autocomplete": editable ? "list" : "none",
		autocomplete: "off",
		readonly: !editable,
		placeholder,
	});
	const menu = element("div", {
		id,
		role: "listbox",
		"aria-label": `${label} options`,
		class: "picker-menu",
		hidden: true,
	});
	const node = element("div", { class: "management-picker" }, control, menu);
	// Padding/empty-state clicks must not activate the surrounding field label or steal focus.
	menu.addEventListener("pointerdown", (event) => event.preventDefault());
	menu.addEventListener("click", (event) => event.preventDefault());
	let options = [],
		shown = [],
		active = -1,
		filtering = false,
		choosing = false;
	const close = () => {
		menu.hidden = true;
		control.setAttribute("aria-expanded", "false");
		control.removeAttribute("aria-activedescendant");
		if (activePicker?.node === node) activePicker = null;
	};
	const highlight = (index, scroll = true) => {
		active = index;
		const items = [...menu.querySelectorAll('[role="option"]')];
		for (let i = 0; i < items.length; i++)
			items[i].toggleAttribute("data-active", i === active);
		if (items[active]) {
			control.setAttribute("aria-activedescendant", items[active].id);
			if (scroll)
				items[active].scrollIntoView({ block: "nearest", behavior: "instant" });
		} else control.removeAttribute("aria-activedescendant");
	};
	const choose = (index) => {
		const item = shown[index];
		if (!item) return;
		control.value = item[0];
		close();
		choosing = true;
		control.dispatchEvent(new Event("input", { bubbles: true }));
		control.dispatchEvent(new Event("change", { bubbles: true }));
		choosing = false;
		control.focus({ preventScroll: true });
	};
	const paint = () => {
		const query = editable && filtering ? control.value.toLowerCase() : "";
		shown = options.filter(
			([value, text]) =>
				!query || `${value} ${text}`.toLowerCase().includes(query),
		);
		menu.replaceChildren(
			...shown.map(([value, text], index) =>
				element(
					"div",
					{
						id: `${id}-${index}`,
						role: "option",
						"data-value": value,
						"aria-selected": String(value === control.value),
						onpointermove: () => highlight(index, false),
						onclick: () => choose(index),
					},
					text,
				),
			),
		);
		if (!shown.length)
			menu.append(
				element(
					"div",
					{ class: "picker-empty", role: "status" },
					"No suggestions. You can type a value.",
				),
			);
		active = shown.findIndex(([value]) => value === control.value);
		if (!menu.hidden) highlight(active, false);
	};
	const open = () => {
		if (activePicker?.node !== node) activePicker?.close();
		activePicker = { node, close };
		filtering = false;
		paint();
		menu.hidden = false;
		control.setAttribute("aria-expanded", "true");
		// The list contributes to the page's scroll area, so it can stay below even at the bottom.
		menu.scrollIntoView({ block: "nearest", behavior: "instant" });
		highlight(active);
	};
	control.addEventListener("click", () => {
		if (!editable && !menu.hidden) close();
		else if (menu.hidden) open();
	});
	control.addEventListener("input", (event) => {
		if (!editable || event.isComposing || choosing) return;
		if (document.activeElement === control && menu.hidden) open();
		filtering = true;
		paint();
	});
	control.addEventListener("change", paint);
	let typed = "",
		typedAt = 0;
	control.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		const wasOpen = !menu.hidden;
		if (["ArrowDown", "ArrowUp"].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (!wasOpen) open();
			let next = active;
			if (!shown.length) next = -1;
			else if (active < 0)
				next = event.key === "ArrowDown" ? 0 : shown.length - 1;
			else if (wasOpen)
				next =
					(active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) %
					shown.length;
			highlight(next);
		} else if (event.key === "Enter" && wasOpen) {
			event.preventDefault();
			event.stopPropagation();
			if (active >= 0) choose(active);
			else close();
		} else if (event.key === "Escape" && wasOpen) {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "Tab") close();
		else if (!editable && ["Home", "End", " "].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === " " && wasOpen) close();
			else {
				if (!wasOpen) open();
				if (event.key !== " ")
					highlight(event.key === "Home" ? 0 : shown.length - 1);
			}
		} else if (
			!editable &&
			event.key.length === 1 &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey
		) {
			event.preventDefault();
			if (!wasOpen) open();
			typed = Date.now() - typedAt > 700 ? event.key : typed + event.key;
			typedAt = Date.now();
			highlight(
				shown.findIndex(([, text]) =>
					text.toLowerCase().startsWith(typed.toLowerCase()),
				),
			);
		}
	});
	node.addEventListener("focusout", (event) => {
		if (!node.contains(event.relatedTarget)) close();
	});
	const setOptions = (values) => {
		options = values.map((entry) =>
			Array.isArray(entry) ? entry : [entry, entry || "Automatic"],
		);
		paint();
	};
	setOptions(values);
	return { node, control, setOptions };
}

// The engine's effort vocabulary (core/types.ts EFFORT_LEVELS); executors map it to their own levels.
const EFFORT_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];
let managementCleanup = () => {};
async function renderManagement() {
	managementCleanup();
	settingsDrafts.clear();
	managementCleanup = () => {};
	renderTop();
	renderRail();
	const title =
		state.view === "history" ? "Delete selected Runs" : humanize(state.view);
	const page = element(
		"div",
		{ class: "management-page", "data-management": state.view },
		element("h1", {}, title),
		element(
			"p",
			{ class: "muted" },
			["profiles", "executors"].includes(state.view)
				? "User level, shared by every project and host"
				: "Selected project, shared host actions",
		),
	);
	$("center").replaceChildren(page);
	try {
		if (state.view === "workflows" && !state.project) {
			page.append(
				element(
					"p",
					{ class: "empty" },
					"Choose a project in the sidebar to manage its workflows and history.",
				),
			);
			return;
		}
		if (state.view === "history") await renderRunHistory(page);
		if (state.view === "workflows") await renderWorkflows(page);
		if (state.view === "profiles") await renderProfiles(page);
		if (state.view === "executors") await renderExecutors(page);
	} catch (error) {
		page.append(
			element("p", { role: "alert", class: "management-error" }, error.message),
			button("Try again", renderManagement),
		);
	}
}
async function renderRunHistory(page) {
	page.append(
		element("a", { href: managementHref("runs") }, "Back to Run history"),
	);
	const project = state.project;
	if (!project) {
		page.append(
			element("p", {}, "Choose a project before deleting selected Runs."),
		);
		return;
	}
	const current = () =>
		page.isConnected && state.view === "history" && state.project === project;
	const route = `/api/projects/${encodeURIComponent(project)}/run-deletions`;
	const data = await managementApi(
		`/api/projects/${encodeURIComponent(project)}/runs`,
	);
	if (!current()) return;
	const selected = new Set();
	let version = 0,
		preview = null,
		pending = false,
		committing = false;
	const disclosure = element("section", {
		class: "management-result",
		"data-testid": "selected-delete-preview",
		hidden: true,
	});
	const message = element("div", {
		class: "management-result",
		role: "status",
		"data-testid": "selected-delete-status",
	});
	const list = element("div", { class: "history-list" });
	const ids = () => [...selected].sort();
	const valid = (token) => current() && token === version;
	const invalidate = () => {
		++version;
		preview = null;
		disclosure.hidden = true;
		update();
	};
	const review = button(
		"Review selected deletion",
		async () => {
			const token = ++version,
				runIds = ids();
			pending = true;
			preview = null;
			disclosure.hidden = true;
			update();
			try {
				const result = await managementWrite(`${route}/preview`, "POST", {
					runIds,
				});
				if (!valid(token)) return;
				preview = result;
				showPreview();
			} catch (error) {
				if (valid(token))
					message.textContent = `Preview refused: ${error.message}. Selection retained.`;
			} finally {
				if (valid(token)) {
					pending = false;
					update();
				}
			}
		},
		{ "data-testid": "selected-delete-review", disabled: true },
	);
	const confirm = button(
		"Delete exactly these selected runs",
		async () => {
			if (!readyToDelete()) return;
			const shown = preview,
				token = ++version,
				runIds = ids();
			pending = true;
			committing = true;
			message.textContent =
				"Deleting selected runs. This sent request cannot be cancelled.";
			update();
			try {
				const result = await managementWrite(route, "POST", {
					runIds,
					digest: shown.digest,
				});
				if (!valid(token)) return;
				preview = null;
				disclosure.hidden = true;
				const rows = result.data?.runs || [];
				const complete =
					result.outcome === "success" &&
					runIds.every((id) =>
						rows.some(
							(row) =>
								row.runId === id &&
								row.deleted &&
								row.purged &&
								!row.error &&
								!row.protected,
						),
					);
				message.textContent = complete
					? `Deleted exactly ${runIds.length} selected runs. No guaranteed undo.`
					: "Deletion incomplete or protected; inspect retained evidence and errors. Not full success.";
				message.append(readableDiagnostic(result));
				for (const row of rows)
					if (row.deleted) {
						selected.delete(row.runId);
						list
							.querySelector(`[data-history-id="${CSS.escape(row.runId)}"]`)
							?.remove();
					}
			} catch (error) {
				if (!valid(token)) return;
				preview = null;
				disclosure.hidden = true;
				message.textContent =
					error.status === 409
						? "Conflict (409): selection retained. Review a fresh preview and explicitly confirm again; nothing automatically retried."
						: `Deletion not confirmed: ${error.message}. Selection retained; partial effects may exist.`;
				if (error.data) message.append(readableDiagnostic(error.data));
			} finally {
				if (valid(token)) {
					pending = false;
					committing = false;
					update();
					message.scrollIntoView({ block: "start", behavior: "instant" });
				}
			}
		},
		{ "data-testid": "selected-delete-confirm", disabled: true },
	);
	const cancel = button(
		"Cancel deletion",
		() => {
			if (committing) return;
			invalidate();
			message.textContent = "Deletion cancelled. Selection retained.";
		},
		{ "data-testid": "selected-delete-cancel" },
	);
	function readyToDelete() {
		return (
			current() &&
			!readonly() &&
			!pending &&
			selected.size > 0 &&
			preview?.outcome === "success" &&
			/^[a-f0-9]{64}$/.test(preview.digest || "") &&
			JSON.stringify(preview.runIds) === JSON.stringify(ids()) &&
			ids().every((id) =>
				preview.data?.runs?.some(
					(row) =>
						row.runId === id && row.selected && !row.protected && !row.error,
				),
			)
		);
	}
	function update() {
		review.disabled = readonly() || pending || !selected.size;
		confirm.disabled = !readyToDelete();
		cancel.disabled = committing;
		for (const checkbox of list.querySelectorAll(
			"input:not([data-nonterminal])",
		))
			checkbox.disabled = readonly() || committing;
	}
	function showPreview() {
		disclosure.hidden = false;
		const rows = preview.data?.runs || [];
		disclosure.replaceChildren(
			element("h2", {}, "Confirm exact selected Run deletion"),
			element(
				"p",
				{},
				`Project: ${projects.find((p) => p.id === project)?.name || project} (${project}). Exact IDs: ${ids().join(", ")}`,
			),
			element(
				"p",
				{},
				"Includes attached logs/reports, actual owned managed worktrees below (including dirty changes), and engine-owned sessions where supported. Session counts are deletion-time facts; unsupported sessions remain. No guaranteed recovery or undo. Excludes the main checkout and project settings, unselected/active runs, other projects, auto-router history, global adapter state and host launch claims.",
			),
			...(preview.error || preview.data?.error
				? [
						element(
							"p",
							{ role: "alert" },
							`Preview error: ${preview.error || preview.data.error}`,
						),
					]
				: []),
			...rows.map((row) =>
				element(
					"article",
					{},
					element("h3", {}, row.runId),
					element(
						"p",
						{},
						`Status: ${row.status}; protected: ${Boolean(row.protected)}${row.error ? `; error: ${row.error}` : ""}`,
					),
					row.bytes !== undefined
						? element("p", {}, `Record resources: ${row.bytes} bytes`)
						: null,
					row.ownedSessions
						? element(
								"p",
								{},
								`Engine-owned sessions: deleted ${row.ownedSessions.deleted}; not found ${row.ownedSessions.notFound}; unsupported ${row.ownedSessions.unsupported} (left in place).`,
							)
						: null,
					row.retainedEvidencePath
						? element("p", {}, `Retained evidence: ${row.retainedEvidencePath}`)
						: null,
					row.retainedMirrorPath
						? element("p", {}, `Retained mirror: ${row.retainedMirrorPath}`)
						: null,
					...(row.worktrees || []).map((tree) =>
						element(
							"p",
							{},
							`Owned worktree: ${tree.path}; branch: ${tree.branch || "unknown"}; dirty: ${tree.dirty}; unique commits: ${tree.commits}${tree.missing ? "; missing worktree" : ""}${tree.error ? `; error: ${tree.error}` : ""}`,
						),
					),
				),
			),
			element(
				"details",
				{ class: "deletion-technical" },
				element("summary", {}, "Technical preview details"),
				readableDiagnostic(preview),
			),
			cancel,
			confirm,
		);
		update();
	}
	for (const summary of data.runs || []) {
		const terminal = ["completed", "failed", "interrupted"].includes(
			summary.status,
		);
		const check = element("input", {
			type: "checkbox",
			"aria-label": `Select ${summary.runId}`,
			disabled: readonly() || !terminal,
			"data-nonterminal": !terminal ? "true" : null,
			onchange: (event) => {
				if (committing) return;
				if (event.target.checked) selected.add(summary.runId);
				else selected.delete(summary.runId);
				pending = false;
				invalidate();
			},
		});
		list.append(
			element(
				"article",
				{ "data-history-id": summary.runId },
				check,
				element(
					"a",
					{ href: runHref(summary.runId) },
					`${summary.name}, ${summary.runId}`,
				),
				element(
					"p",
					{},
					`${summary.status}, ${summary.updatedAt}${!terminal ? ", Active/nonterminal runs cannot be selected" : ""}`,
				),
			),
		);
	}
	page.append(
		element(
			"p",
			{},
			readonly()
				? "Read-only: deletion unavailable."
				: "Select exact terminal records in this project; no age or keep policy is applied.",
		),
		list,
		review,
		message,
		disclosure,
	);
	if (!data.runs?.length) list.append(element("p", {}, "No runs yet"));
}

async function renderWorkflows(page) {
	if (state.workflow) return renderWorkflow(page, state.workflow);
	const [catalog, agents] = await Promise.all([
		managementApi(projectRoute("workflows")),
		managementApi(projectRoute("agents")),
	]);
	const list = managementPanel("Available workflows");
	page.append(list);
	if (!catalog.data.workflows.length)
		list.append(
			element(
				"p",
				{},
				"No workflows yet. Add a workflow definition to .agent-workflow/workflows, or install a workflow bundle. Run agent-workflow list to discover it.",
			),
		);
	// 2026-11-11 (owner): the whole card opens the workflow, on a page of its own.
	list.append(
		element(
			"div",
			{ class: "workflow-cards" },
			catalog.data.workflows.map((workflow) =>
				element(
					"a",
					{
						class: "workflow-card",
						href: workflowHref(workflow.workflowKey || workflow.name),
						"data-workflow": workflow.name,
						"data-workflow-key": workflow.workflowKey || "",
					},
					element(
						"span",
						{ class: "workflow-card-head" },
						element("strong", {}, workflow.name),
						workflowTags(workflow),
					),
					element(
						"span",
						{ class: "workflow-card-text" },
						workflow.description || "No description.",
					),
					element(
						"small",
						{ class: "muted" },
						workflow.specPath || workflow.scope,
					),
				),
			),
		),
	);
	page.append(
		diagnosticView(
			"Agent inventory",
			agents.data.agents.length
				? propertyTable(
						["Agent", "Description", "Source"],
						agents.data.agents.map((agent) => [
							element("strong", {}, agent.displayName),
							agent.description || "No description.",
							element(
								"span",
								{ class: "muted" },
								`${agent.scope}${agent.model ? `, ${agent.model}` : ""}`,
							),
						]),
					)
				: element(
						"p",
						{},
						"No agents yet. Add an agent to .agent-workflow/agents.",
					),
		),
	);
}
const ROUTING_LABELS = {
	useWhen: "Use when",
	avoidWhen: "Avoid when",
	outputs: "Outputs",
};
function workflowHref(key) {
	const params = new URLSearchParams();
	if (state.project) params.set("project", state.project);
	params.set("view", "workflows");
	if (key) params.set("workflow", key);
	return `/?${params}`;
}
function workflowTags(workflow) {
	return element(
		"span",
		{ class: "workflow-tags" },
		[
			workflow.scope === "package" ? "built-in" : workflow.scope,
			workflow.readOnly ? "read-only" : null,
			workflow.agent ? `agent: ${workflow.agent}` : null,
		]
			.filter(Boolean)
			.map((tag) => element("span", { class: "tag" }, tag)),
	);
}
/** A plain table: a header row and rows of cells (text or nodes). */
function propertyTable(headers, rows, attrs = {}) {
	return element(
		"table",
		{ class: "property-table", ...attrs },
		headers
			? element(
					"thead",
					{},
					element(
						"tr",
						{},
						headers.map((header) => element("th", {}, header)),
					),
				)
			: null,
		element(
			"tbody",
			{},
			rows.map((cells) =>
				element(
					"tr",
					{},
					cells.map((cell) => element("td", {}, cell ?? "n/a")),
				),
			),
		),
	);
}
/** Project-local intent only. Resolution and authorization belong to the keyed B2 API. */
async function projectWorkflowEditor(page, project, workflow, graph, current) {
	const route = `/api/projects/${encodeURIComponent(project)}/workflows/${workflow.workflowKey}/settings`;
	const host = element("section", {
		class: "management-card project-workflow-editor",
	});
	host.dataset.workflowKey = workflow.workflowKey;
	host.dataset.projectId = project;
	page.append(host);
	let disposed = false,
		saving = false,
		generation = 0,
		request = 0,
		selection = null;
	let settings,
		intent,
		preview,
		previewGeneration = -1,
		controller;
	let layout = "td",
		showCode = true,
		calculationQueued = false,
		attemptedGeneration = -1,
		feedback = "";
	const views = new Map();
	const refreshers = new Set();
	const live = () => !disposed && current() && host.isConnected;
	managementCleanup = () => {
		disposed = true;
		++request;
		controller?.destroy();
	};
	const copy = (value) => structuredClone(value);
	const own = (map, key) =>
		map && Object.hasOwn(map, key) ? map[key] : undefined;
	const put = (map, key, value) =>
		Object.defineProperty(map, key, {
			value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	const expected = () =>
		Object.fromEntries(
			[
				"storeEpoch",
				"revision",
				"definitionFingerprint",
				"resolutionToken",
			].map((key) => [key, settings[key]]),
		);
	const status = element("p", {
		role: "status",
		"data-testid": "workflow-settings-status",
	});
	const error = element("p", {
		role: "alert",
		class: "management-error",
		hidden: true,
	});
	const loading = element("span", {
		class: "project-settings-spinner",
		role: "status",
		"aria-label": "Loading",
	});
	host.append(loading, status);
	const loaded = await managementApi(route);
	if (!live()) return;
	settings = loaded.settings;
	intent = copy(settings.intent);
	// Refuse future schemas rather than turning a partial UI view into replacement intent.
	const supported = (value) =>
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value.slots === undefined ||
			(value.slots !== null &&
				typeof value.slots === "object" &&
				!Array.isArray(value.slots))) &&
		Object.keys(value).every((key) => ["defaults", "slots"].includes(key)) &&
		[value.defaults, ...Object.values(value.slots || {})]
			.filter((v) => v !== undefined)
			.every(
				(binding) =>
					binding &&
					typeof binding === "object" &&
					!Array.isArray(binding) &&
					typeof binding.executor === "string" &&
					binding.executor.length > 0 &&
					["model", "effort"].every(
						(key) =>
							!Object.hasOwn(binding, key) ||
							(typeof binding[key] === "string" && binding[key].length > 0),
					) &&
					(binding.effort === undefined ||
						EFFORT_LEVELS.includes(binding.effort)) &&
					Object.keys(binding).every((key) =>
						["executor", "model", "effort"].includes(key),
					),
			);
	if (!supported(intent)) {
		loading.remove();
		status.textContent =
			"This writable intent is not supported by this editor. Original settings preserved; editing refused.";
		return;
	}
	let metadata = loaded;
	const draft = settingsDraft(host, () => intent);
	let presets = [];
	try {
		presets = (await managementApi("/api/profiles/presets")).data.presets;
	} catch (failure) {
		failPresetLoad(failure);
	}
	function failPresetLoad(failure) {
		error.hidden = false;
		error.textContent = `Presets unavailable: ${failure.message}. Manual editing remains available.`;
	}
	let inventory;
	try {
		inventory = (await managementApi("/api/executors/models")).data;
	} catch (failure) {
		inventory = { executors: [], error: failure.message };
	}
	if (!live()) {
		draft.clear();
		return;
	}
	loading.remove();
	const common = element("section", {
		class: "project-common",
		"aria-label": "All tasks settings",
	});
	const graphHost = element("div", { class: "profile-flow" });
	const panel = element("section", {
		class: "role-inspector",
		"aria-label": "Canonical task settings",
	});
	// Wide: the graph fills the page and every setting sits in one sticky side column (2026-11-16, owner).
	const editors = element(
		"div",
		{ class: "project-workflow-layout" },
		element("div", { class: "project-workflow-graph" }, graphHost),
		element(
			"aside",
			{ class: "project-settings-side", "aria-label": "Settings" },
			common,
			panel,
		),
	);
	const binding = (id) =>
		id === null ? intent.defaults : own(intent.slots, id);
	const row = (id) =>
		previewGeneration === generation
			? own(preview?.check?.data?.configuration?.slots, id)
			: undefined;
	const fail = (message, retry = false) => {
		error.hidden = false;
		error.replaceChildren(document.createTextNode(message));
		if (retry)
			error.append(
				button("Retry", () => {
					attemptedGeneration = -1;
					scheduleCalculation();
				}),
			);
	};
	const dirty = element(
		"small",
		{ class: "muted", "data-testid": "workflow-settings-dirty", hidden: true },
		"Unsaved changes",
	);
	const updateStatus = () => {
		dirty.hidden = !draft.dirty();
		status.textContent = readonly()
			? "Read-only: editing unavailable."
			: feedback;
		status.hidden = !status.textContent;
		save.disabled = readonly() || saving || !draft.dirty();
	};
	function scheduleCalculation() {
		if (!live() || readonly() || saving || calculationQueued) return;
		calculationQueued = true;
		queueMicrotask(() => {
			calculationQueued = false;
			if (live() && !readonly() && !saving) void calculate();
		});
	}
	function changed() {
		++generation;
		feedback = "";
		error.hidden = true;
		updateStatus();
		// Keep controls and raw saved IDs; stale calculations are not current sources.
		for (const label of host.querySelectorAll(
			"[data-calculated], [data-source-lineage]",
		)) {
			label.textContent = "";
			label.hidden = true;
		}
		for (const refresh of refreshers) refresh();
		controller?.refresh();
		scheduleCalculation();
	}
	function setBinding(id, value) {
		if (draftSnapshot(binding(id)) === draftSnapshot(value)) return;
		if (id === null) {
			if (value) intent.defaults = value;
			else delete intent.defaults;
		} else {
			if (!intent.slots) intent.slots = {};
			if (value) put(intent.slots, id, value);
			else delete intent.slots[id];
		}
		changed();
	}
	// Build ordinary project intent from the server's role addresses, never task names.
	// A dynamic binding's executor is a compatibility namespace, not an executor pin.
	function presetIntent(preset) {
		const defaults = copy(preset.roles.default);
		const slots = {};
		for (const slot of metadata.editableSlots) {
			const keys = own(metadata.slotRoleKeys, slot.id) || [];
			const key = keys.find((key) => Object.hasOwn(preset.roles, key));
			const value = copy(key ? preset.roles[key] : defaults);
			if (slot.kind === "dynamic-profile") {
				const parent = metadata.authored.find(
					(node) => node.id === slot.id,
				)?.parentId;
				const executor = own(slots, parent)?.executor || defaults.executor;
				// Incompatible models cannot be rebound across executors. Inherit the
				// actual parent instead, just as manual template editing requires.
				if (value.executor !== executor) continue;
			}
			if (draftSnapshot(value) !== draftSnapshot(defaults))
				put(slots, slot.id, value);
		}
		return { defaults, ...(Object.keys(slots).length ? { slots } : {}) };
	}
	const presetControl = choices("Preset", [
		["", "Custom"],
		...presets.map((preset) => preset.id),
	]);
	const refreshPreset = () => {
		presetControl.disabled = readonly() || !presets.length;
		presetControl.value =
			presets.find(
				(preset) =>
					draftSnapshot(intent) === draftSnapshot(presetIntent(preset)),
			)?.id || "";
	};
	presetControl.addEventListener("change", () => {
		if (readonly()) return;
		const preset = presets.find((preset) => preset.id === presetControl.value);
		if (!preset) {
			// Custom is derived, not a stored profile or destructive reset.
			refreshPreset();
			return;
		}
		const focused = document.activeElement === presetControl;
		intent = presetIntent(preset);
		changed();
		renderFields();
		if (focused) presetControl.focus({ preventScroll: true });
	});
	function sourceText(value, field, full = false) {
		if (!value) return "";
		const actual =
			field === "effort"
				? `requested: ${value.requested ?? "unknown"}; resolved: ${value.resolved ?? "unknown"}${value.reason ? ` (${value.reason})` : ""}`
				: (value.value ?? "unknown");
		return `${actual}; source: ${value.source || "unknown"}${value.originSlot ? `; origin: ${value.originSlot}` : ""}${full && value.inheritedFrom ? `; inherited from: ${value.inheritedFrom}` : ""}${full && value.inheritedVia?.length ? `; via: ${value.inheritedVia.join(" → ")}` : ""}`;
	}
	function controls(id) {
		const value = binding(id) || {};
		const resolved = id === null ? undefined : row(id);
		const slot = metadata.editableSlots.find((slot) => slot.id === id);
		const dynamic = slot?.kind === "dynamic-profile";
		const parentExecutor =
			previewGeneration === generation ? slot?.parentExecutor : undefined;
		const actualExecutor = dynamic ? parentExecutor : resolved?.executor?.value;
		const prefix = id === null ? "All tasks" : `Slot ${id}`;
		let modelCleared = false;
		const node = element("div", {
			class: "management-fields",
			"data-binding": id ?? "common",
		});
		const ids = [
			...new Set(
				[
					...(inventory.executors || []).map((entry) => entry.id),
					value.executor,
					actualExecutor,
				].filter(Boolean),
			),
		];
		const executor = choicePicker(
			`${prefix} Executor`,
			ids,
			value.executor || "",
			{
				placeholder: actualExecutor
					? `Resolved: ${actualExecutor}`
					: "Choose executor explicitly",
			},
		);
		const modelControl = choices(
			`${prefix} Model`,
			[["", "Use baseline settings"], ...(value.model ? [value.model] : [])],
			value.model || "",
		);
		const model = { control: modelControl, node: modelControl };
		const effort = choicePicker(
			`${prefix} Effort`,
			[["", "Use baseline settings"], ...EFFORT_LEVELS],
			value.effort || "",
			{ placeholder: "Use baseline settings" },
		);
		const note = element("small", { class: "muted", role: "status" });
		const refresh = () => {
			const currentSlot = metadata.editableSlots.find((slot) => slot.id === id);
			const currentExecutor = dynamic
				? previewGeneration === generation
					? currentSlot?.parentExecutor
					: undefined
				: id === null
					? undefined
					: row(id)?.executor?.value;
			const exec = binding(id)?.executor || currentExecutor;
			executor.control.value = binding(id)?.executor || "";
			const entry = inventory.executors.find((entry) => entry.id === exec);
			const previousModel = binding(id)?.model || "";
			const models = [
				...new Set([...(entry?.models || []), previousModel].filter(Boolean)),
			];
			const options = ["", ...models];
			if (
				options.length !== model.control.options.length ||
				options.some(
					(value, index) => model.control.options[index]?.value !== value,
				)
			) {
				model.control.replaceChildren(
					element("option", { value: "" }, "Use baseline settings"),
					...models.map((id) => element("option", { value: id }, id)),
				);
				model.control.value = previousModel;
			}
			for (const hint of node.querySelectorAll(
				"[data-calculated], [data-source-lineage]",
			)) {
				const key = hint.dataset.calculated || hint.dataset.sourceLineage;
				const value = row(id)?.[key];
				hint.textContent = value
					? `${hint.hasAttribute("data-source-lineage") ? `${humanize(key)}: ` : ""}${sourceText(value, key, hint.hasAttribute("data-source-lineage"))}`
					: "";
				hint.hidden = !value;
			}
			model.control.disabled = effort.control.disabled = readonly() || !exec;
			executor.control.disabled = readonly() || dynamic;
			executor.control.placeholder = currentExecutor
				? `Resolved: ${currentExecutor}`
				: "Choose executor explicitly";
			const inventoryError = entry?.error || inventory.error;
			note.textContent = modelCleared
				? "Model cleared: not available for this executor."
				: inventoryError
					? `Model inventory unavailable: ${inventoryError}`
					: "";
			note.hidden = !note.textContent;
		};
		executor.control.addEventListener("change", () => {
			if (readonly() || dynamic) return;
			if (!executor.control.value) return;
			const next = { ...binding(id), executor: executor.control.value };
			const entry = inventory.executors.find(
				(entry) => entry.id === next.executor,
			);
			modelCleared = Boolean(
				next.executor !== binding(id)?.executor &&
					next.model &&
					!inventory.error &&
					!entry?.error &&
					entry?.modelListComplete === true &&
					Array.isArray(entry.models) &&
					!entry.models.some(
						(listed) =>
							listed === next.model ||
							listed.endsWith(`/${next.model}`) ||
							next.model.endsWith(`/${listed}`),
					),
			);
			if (modelCleared) delete next.model;
			setBinding(id, next);
			refresh();
		});
		for (const [key, picker] of [
			["model", model],
			["effort", effort],
		]) {
			const change = () => {
				if (readonly()) return;
				modelCleared = false;
				const previous = binding(id);
				if (!previous && !picker.control.value) return;
				const currentSlot = metadata.editableSlots.find(
					(slot) => slot.id === id,
				);
				const parentExecutor =
					previewGeneration === generation
						? currentSlot?.parentExecutor
						: undefined;
				const exec =
					previous?.executor ||
					(dynamic ? parentExecutor : row(id)?.executor?.value);
				if (!exec || (dynamic && exec !== parentExecutor)) {
					fail(
						"Actual parent/slot executor is unresolved or incompatible. Review the settings; no values were rebound.",
					);
					return;
				}
				const next = { ...previous, executor: exec };
				if (picker.control.value) next[key] = picker.control.value;
				else delete next[key];
				setBinding(id, next);
				refresh();
			};
			picker.control.addEventListener("input", change);
			node.append(
				field(key === "model" ? "Model" : "Effort", picker.node),
				...(id === null
					? []
					: [
							element(
								"small",
								{ "data-calculated": key, hidden: !resolved?.[key] },
								sourceText(resolved?.[key], key),
							),
						]),
			);
		}
		node.prepend(
			field("Executor", executor.node),
			...(id === null
				? []
				: [
						element(
							"small",
							{ "data-calculated": "executor", hidden: !resolved?.executor },
							sourceText(resolved?.executor, "executor"),
						),
					]),
		);
		node.append(
			note,
			...(id === null
				? []
				: [
						moreDetails(
							"Setting sources and lineage",
							...["executor", "model", "effort"].map((key) =>
								element(
									"p",
									{ "data-source-lineage": key, hidden: !resolved?.[key] },
									resolved?.[key]
										? `${humanize(key)}: ${sourceText(resolved[key], key, true)}`
										: "",
								),
							),
						),
					]),
		);
		refreshers.add(refresh);
		refresh();
		return node;
	}
	function renderFields() {
		refreshers.clear();
		refreshers.add(refreshPreset);
		refreshPreset();
		common.hidden = selection !== null;
		panel.hidden = selection === null;
		common.replaceChildren(
			element(
				"h3",
				{ "data-testid": "all-tasks-title", tabindex: "-1" },
				"All tasks",
			),
			field("Preset", presetControl),
			controls(null),
		);
		const selected = metadata.authored.find((node) => node.id === selection);
		panel.replaceChildren(
			element(
				"h3",
				{ tabindex: "-1", "data-testid": "canonical-slot-title" },
				selected?.id || "All tasks",
			),
		);
		if (selected)
			panel.prepend(
				button("← All tasks", returnToAll, { "data-testid": "all-tasks-back" }),
			);
		if (!selected) return;
		if (!selected.editable)
			panel.append(
				element(
					"p",
					{ "data-testid": "noneditable-node" },
					{
						group:
							"Structural group: no direct model. Select an expanded authored child.",
						controller:
							"Dynamic controller: no individual model editor. Only declared templates are editable; future workers are not invented.",
						code: "Code step: no model settings.",
					}[selected.kind] || "No editable model slot.",
				),
			);
		else {
			const custom = Boolean(binding(selected.id));
			const scope = element(
				"fieldset",
				{ class: "task-settings-scope" },
				element("legend", { class: "sr-only" }, "Task settings scope"),
			);
			for (const [value, label] of [
				["all", "Use All tasks settings"],
				["custom", "Custom for this task"],
			]) {
				const option = element("input", {
					type: "radio",
					name: "task-settings-scope",
					value,
					checked: custom === (value === "custom"),
					disabled:
						readonly() ||
						(value === "custom" && !row(selected.id)?.executor?.value),
				});
				refreshers.add(() => {
					option.disabled =
						readonly() ||
						(value === "custom" &&
							!binding(selected.id) &&
							!row(selected.id)?.executor?.value);
				});
				option.addEventListener("change", () => {
					if (readonly() || !option.checked) return;
					if (value === "all") setBinding(selected.id, undefined);
					else {
						const resolved = row(selected.id);
						const slot = metadata.editableSlots.find(
							(slot) => slot.id === selected.id,
						);
						const executor = resolved?.executor?.value;
						if (
							!executor ||
							(slot?.kind === "dynamic-profile" &&
								executor !== slot.parentExecutor)
						) {
							fail(
								"Actual parent/slot executor is unresolved or incompatible. No values were rebound.",
							);
							return;
						}
						const next = { executor };
						if (resolved.model?.value) next.model = resolved.model.value;
						if (resolved.effort?.requested)
							next.effort = resolved.effort.requested;
						setBinding(selected.id, next);
					}
					renderFields();
				});
				scope.append(element("label", {}, option, label));
			}
			const fields = controls(selected.id);
			fields.hidden = !custom;
			panel.append(
				element(
					"p",
					{ class: "muted" },
					selected.kind === "template"
						? `Authored template${selected.parentId ? ` in ${selected.parentId}` : ""}; generated tasks inherit its captured settings, not live edits.`
						: `Settings for task ${selected.id} only; other tasks are independent.`,
				),
				scope,
				fields,
			);
		}
	}
	function returnToAll() {
		const previous = selection;
		choose(null);
		graphHost
			.querySelector(`[data-stage="${CSS.escape(previous)}"]`)
			?.focus({ preventScroll: true });
	}
	const choose = (id) => {
		selection = id;
		renderFields();
		controller?.refresh();
		// Explicit editor selection only; never a Run/SSE update. Keep graph camera intact.
		if (id) {
			panel.scrollIntoView({ block: "nearest", behavior: "instant" });
			panel.querySelector("h3")?.focus({ preventScroll: true });
		}
	};
	function draw() {
		controller?.destroy();
		const tasks = [...(graph?.tasks || [])];
		for (const task of graph?.templateTasks || [])
			tasks.push({
				...task,
				specId: `template:${task.stageId}`,
				dependsOn: task.dependsOn.map((id) => `template:${id}`),
			});
		const present = new Set(tasks.map((task) => task.stageId));
		// Extra authored entries are selectable definitions, never fabricated runtime dependencies.
		for (const node of metadata.authored)
			if (!present.has(node.id))
				tasks.push({
					specId: `authored:${node.id}`,
					stageId: node.id,
					kind: node.kind === "code" ? "support" : node.kind,
					dependsOn: [],
				});
		const model = deriveGraph(
			{
				tasks: tasks.map((task) => ({
					...task,
					status: "pending",
					statusDetail: "pending",
					placeholder: true,
				})),
			},
			{ hideCode: !showCode, keep: selection },
		);
		graphHost.replaceChildren(
			renderGraph({
				model,
				name: workflow.name,
				key: `${project}:${workflow.workflowKey}`,
				layout,
				showCode,
				views,
				describe: (stage) => {
					const node = metadata.authored.find((node) => node.id === stage.id);
					const resolved = row(node?.id);
					const line = resolved
						? [resolved.model?.value, resolved.effort?.resolved]
								.filter(Boolean)
								.join(" · ")
						: "";
					return node?.editable
						? [line, binding(node.id) ? "Custom" : ""]
								.filter(Boolean)
								.join(" · ")
						: {
								group: "Structural group",
								controller: "Dynamic controller",
								code: "Code, no model",
							}[node?.kind] || "Authored definition";
				},
				select: (stage) => choose(stage.id),
				selected: () => selection,
				related: () => new Set(),
				clear: () => choose(null),
				control: (value) => {
					controller = value;
				},
				toggleCode: () => {
					showCode = !showCode;
					draw();
				},
				controls: () =>
					[
						["td", "Top-down"],
						["lr", "Left-right"],
					].map(([value, label]) =>
						button(
							markIcon(value),
							() => {
								layout = value;
								draw();
							},
							{ "aria-label": label, "aria-pressed": String(layout === value) },
						),
					),
			}),
		);
	}
	async function calculate() {
		if (saving || readonly() || attemptedGeneration === generation) return;
		const token = ++request,
			version = generation;
		attemptedGeneration = version;
		const body = { intent: copy(intent), expected: expected() };
		try {
			const result = await managementWrite(`${route}/preview`, "POST", body);
			if (!live() || token !== request || version !== generation) return;
			preview = result;
			previewGeneration = version;
			metadata = result;
			error.hidden = true;
			if (!result.check?.ok)
				fail(
					`Check refused: ${result.check?.text || "No calculable configuration"}. Draft retained. ${result.check?.data?.configuration ? "Calculated configuration is shown separately; capability refusal is not a Save result." : "Unresolved configuration remains unknown."}`,
					!result.check?.data?.configuration,
				);
			for (const refresh of refreshers) refresh();
			controller?.refresh();
			updateStatus();
		} catch (failure) {
			if (live() && token === request && version === generation)
				fail(
					`${failure.message}. Draft retained. Automatic calculation failed.`,
					true,
				);
		}
	}
	const save = button(
		"Save",
		async () => {
			if (saving || readonly()) return;
			saving = true;
			feedback = "Saving…";
			updateStatus();
			const token = ++request,
				submitted = copy(intent),
				snapshot = draft.snapshot();
			let confirmed = false;
			try {
				const result = await managementWrite(route, "PUT", {
					intent: submitted,
					expected: expected(),
				});
				if (!live() || token !== request) return;
				settings = result;
				draft.saved(snapshot);
				confirmed = true;
				error.hidden = true;
				feedback = draft.dirty()
					? "Submitted settings saved. Unsaved changes remain."
					: "Settings saved.";
				updateStatus();
			} catch (failure) {
				if (live() && token === request) {
					feedback = "";
					fail(
						`${failure.status === 409 ? "Conflict (409): " : "Save not confirmed: "}${failure.message}. Complete draft retained. Reload and review; no automatic overwrite/retry.`,
					);
					updateStatus();
				}
			} finally {
				saving = false;
				if (live()) {
					updateStatus();
					// A settled calculation already describes this exact intent. Only a
					// pending/newer generation needs another request with the new CAS tokens.
					if (confirmed && previewGeneration !== generation) {
						attemptedGeneration = -1;
						scheduleCalculation();
					}
				}
			}
		},
		{
			class: "primary",
			"data-management-action": "save-project-settings",
			disabled: readonly(),
		},
	);
	host.append(editors);
	page.querySelector(".project-workflow-header").append(
		element(
			"div",
			{ class: "project-workflow-actions" },
			save,
			button(
				"Discard changes",
				() => {
					if (approveSettingsDiscard()) renderManagement();
				},
				{ "data-testid": "project-settings-reload", disabled: readonly() },
			),
			dirty,
			status,
			error,
		),
	);
	host.addEventListener("keydown", (event) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey
		)
			return;
		if (event.key === "Escape" && selection) {
			returnToAll();
			event.preventDefault();
			event.stopPropagation();
		} else if (
			event.key.toLowerCase() === "f" &&
			event.target.closest(".profile-flow")
		) {
			controller?.fit();
			event.preventDefault();
			event.stopPropagation();
		}
	});
	if (graph?.error)
		fail(
			`Compiled graph: ${graph.error}. Authored definitions remain inspectable.`,
		);
	renderFields();
	draw();
	updateStatus();
	scheduleCalculation();
}

/** Project workflow: one draft, graph task selection and title-row Save/Discard. */
async function renderWorkflow(page, name) {
	const project = state.project;
	let selectionKey = name;
	const route = (suffix = "") =>
		`/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(selectionKey)}${suffix}`;
	const current = () =>
		page.isConnected &&
		state.project === project &&
		state.workflow === selectionKey;
	page.querySelector("h1").textContent = name;
	page
		.querySelector("h1")
		.before(
			element(
				"a",
				{ class: "back-link", href: workflowHref(null) },
				"← All workflows",
			),
		);
	const catalog = await managementApi(
		`/api/projects/${encodeURIComponent(project)}/workflows`,
	);
	if (!current()) return;
	const exact = catalog.data.workflows.find(
		(entry) => entry.workflowKey === name,
	);
	const aliases = catalog.data.workflows.filter((entry) => entry.name === name);
	if (!exact && aliases.length > 1) {
		page.append(
			element(
				"p",
				{ role: "alert" },
				"Multiple sources have this workflow name. Return to All workflows and select an explicit source.",
			),
		);
		return;
	}
	const workflow = exact || aliases[0] || { name };
	if (workflow.workflowKey) {
		selectionKey = workflow.workflowKey;
		state.workflow = selectionKey;
		const params = new URLSearchParams(location.search);
		params.set("workflow", selectionKey);
		history.replaceState(
			history.state,
			"",
			`${location.pathname}?${params}${location.hash}`,
		);
	}
	const data = await managementApi(route());
	if (!current()) return;
	const title = page.querySelector("h1");
	title.textContent = workflow.name;
	page.querySelector("h1 + p")?.remove();
	const header = element("header", { class: "project-workflow-header" });
	title.before(header);
	header.append(
		element(
			"div",
			{ class: "project-workflow-heading" },
			title,
			element(
				"p",
				{ class: "workflow-description muted" },
				workflow.description || "No description.",
			),
		),
	);
	if (workflow.workflowKey) {
		try {
			await projectWorkflowEditor(page, project, workflow, data.graph, current);
		} catch (failure) {
			if (!current()) return;
			const status = page.querySelector(
				'[data-testid="workflow-settings-status"]',
			);
			if (status) {
				page.querySelector(".project-settings-spinner")?.remove();
				status.textContent = `Project settings unavailable: ${failure.message}. No draft was saved or discarded.`;
				status.setAttribute("role", "alert");
			}
			page.append(button("Reload project settings", renderManagement));
		}
		if (!current()) return;
	} else
		page.append(
			element(
				"p",
				{ role: "alert" },
				"Project settings unavailable: no server workflow identity.",
			),
		);
	// Parsing here only exposes real definition problems, not a second compiler or raw-spec view.
	let authored = {};
	let specError = "";
	try {
		authored = JSON.parse(data.spec.data.spec);
	} catch (error) {
		specError = error.message;
	}
	// A valid definition needs no section; only real definition problems are shown (2026-11-16, owner).
	const validation = data.validation?.data;
	const problems = [
		...(specError ? [`The workflow spec could not be read: ${specError}`] : []),
		...(data.validation?.error ? [data.validation.error] : []),
		...(validation?.warnings || []).map((warning) => `Warning: ${warning}`),
		...(validation?.blockedPermissionPreviews || []).map(
			(entry) =>
				`Blocked: ${entry.taskId}: ${entry.reason || entry.statusDetail}`,
		),
	];
	const specProblems = problems.length
		? element(
				"ul",
				{
					role: "alert",
					class: "management-error",
					"data-testid": "workflow-spec-problems",
				},
				...problems.map((problem) => element("li", {}, problem)),
			)
		: null;
	if (specProblems) header.after(specProblems);
}
// Profiles (2026-11-13): a short list first, one editor at a time. Settings/API semantics stay as they are.
async function renderProfiles(page) {
	const result = await managementApi("/api/profiles");
	if (!page.isConnected) return;
	page.classList.add("profiles-page");
	page
		.querySelector("h1 + p")
		?.replaceChildren(
			"Manage shared profile permissions and strict capabilities.",
		);
	const data = result.data;
	const overview = element("div", { class: "profile-overview" });
	const editor = element("div", { class: "profile-editor", hidden: true });
	const errors = element("div");
	page.append(errors, overview, editor);
	const executorDefaults = data.executorDefaults || [];
	const executorProfileNames = new Set(
		executorDefaults.map((entry) => entry.executor),
	);
	const defaultLine = element(
		"p",
		{ class: "profile-default muted" },
		data.default
			? `Default profile: ${data.default}. Not found in the profiles shown here.`
			: "No default profile.",
	);
	defaultLine.hidden =
		!!data.default &&
		(executorProfileNames.has(data.default) ||
			data.profiles.some((profile) => profile.name === data.default));
	const describe = (profile) =>
		[
			`Permissions: ${profile.permissionMode || "free"}`,
			profile.strictCapabilities?.length
				? `Strict: ${profile.strictCapabilities.join(", ")}`
				: "",
		]
			.filter(Boolean)
			.join(", ");
	const row = (name, summary, action, attrs = {}, badge = null) => {
		const params = new URLSearchParams(location.search);
		params.set("view", "profiles");
		params.delete("createProfile");
		params.set("profile", name);
		const link = element(
			"a",
			{
				href: `${location.pathname}?${params}`,
				class: "profile-row",
				"data-profile-open": name,
				"aria-label": `Edit ${name}`,
				...attrs,
			},
			[
				element("strong", { class: "profile-name" }, name),
				element("span", { class: "profile-summary muted" }, summary),
				element("span", { class: "profile-badge" }, badge || ""),
				element(
					"span",
					{ class: "profile-chevron", "aria-hidden": "true" },
					"›",
				),
			],
		);
		link.addEventListener("click", (event) => {
			if (
				event.defaultPrevented ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			event.preventDefault();
			action();
		});
		return link;
	};
	const defaults = element(
		"section",
		{ class: "profiles-section" },
		element("h2", {}, "Executor defaults"),
		element(
			"p",
			{ class: "muted" },
			"Shared permissions and strict capabilities for each executor.",
		),
	);
	for (const entry of executorDefaults) {
		const saved = data.profiles.find(
			(profile) => profile.name === entry.executor,
		);
		const summary = describe(saved || {});
		defaults.append(
			row(
				entry.executor,
				summary,
				() => edit(saved || { name: entry.executor }, entry),
				{ "data-executor-default": entry.executor },
				data.default === entry.executor
					? "Default profile"
					: saved
						? "Customized"
						: null,
			),
		);
	}
	const saved = data.profiles.filter(
		(profile) => !executorProfileNames.has(profile.name),
	);
	const savedSection = element(
		"section",
		{ class: "profiles-section" },
		element(
			"div",
			{ class: "profile-section-head" },
			element("h2", {}, "Your profiles"),
			managementControl("New profile", () => edit({}), errors, {
				write: false,
				class: "small",
				"data-profile-new": "",
			}),
		),
		saved.length
			? saved.map((profile) =>
					row(
						profile.name,
						describe(profile),
						() => edit(profile),
						{},
						data.default === profile.name ? "Default profile" : null,
					),
				)
			: element(
					"p",
					{ class: "muted" },
					"Create a profile to reuse permissions and strict capabilities.",
				),
	);
	overview.append(defaultLine, defaults, savedSection);
	const backToProfiles = () => {
		if (!discardSettingsDrafts()) return;
		if (history.state?.profileEditor) history.back();
		else location.assign(managementHref("profiles"));
	};
	const reloadProfiles = async (savedName = state.profile) => {
		if (history.state?.profileEditor) {
			// Save a new profile's detail URL for Forward, then consume the list->editor
			// entry on Back. Refresh locally so the write's confirmation survives.
			if (savedName) {
				state.profile = savedName;
				state.createProfile = null;
				urlState(true);
			}
			await new Promise((resolve, reject) => {
				profileListReturn = () => {
					state = readState();
					history.replaceState(
						settingsHistoryState(
							{
								...history.state,
								profileReturnFocus: savedName,
								newProfileReturn: false,
							},
							true,
						),
						"",
						location.href,
					);
					renderManagement().then(resolve, reject);
				};
				history.back();
			});
		} else {
			history.replaceState(
				settingsHistoryState(
					{
						...history.state,
						profileReturnFocus: savedName,
						newProfileReturn: false,
					},
					true,
				),
				"",
				location.href,
			);
			state.profile = null;
			state.createProfile = null;
			urlState(true);
			await renderManagement();
		}
	};
	let editGeneration = 0;
	async function edit(profile, executorDefault, fromRoute = false) {
		if (!fromRoute) {
			if (!discardSettingsDrafts()) return;
			const params = new URLSearchParams(location.search);
			params.set("view", "profiles");
			params.delete("profile");
			params.delete("createProfile");
			params.set(
				profile.name ? "profile" : "createProfile",
				profile.name || "1",
			);
			history.replaceState(
				settingsHistoryState(
					{
						...history.state,
						profileReturnFocus: profile.name || "",
						newProfileReturn: !profile.name,
					},
					true,
				),
				"",
				location.href,
			);
			history.pushState(
				settingsHistoryState({ profileEditor: true }),
				"",
				`${location.pathname}?${params}`,
			);
			location.reload();
			return;
		}
		const generation = ++editGeneration;
		const id = input("Profile name", profile.name || "", {
			maxlength: 64,
			readonly: !!profile.name,
		});
		const nameError = element("p", {
			id: "profile-name-error",
			class: "management-error profile-name-error",
			role: "alert",
			hidden: true,
		});
		const clearNameError = () => {
			if (!id.value.trim()) return;
			nameError.hidden = true;
			nameError.textContent = "";
			id.removeAttribute("aria-invalid");
			const descriptions = (id.getAttribute("aria-describedby") || "")
				.split(/\s+/)
				.filter((value) => value && value !== nameError.id);
			if (descriptions.length)
				id.setAttribute("aria-describedby", descriptions.join(" "));
			else id.removeAttribute("aria-describedby");
		};
		id.addEventListener("input", clearNameError);
		const permission = choices(
			"Profile permission mode",
			["", "free", "safe"],
			profile.permissionMode || "",
		);
		const strict = input(
			"Strict capabilities (comma separated)",
			(profile.strictCapabilities || []).join(", "),
		);
		const output = element("div");
		const saveOutput = element("div", { class: "profile-save-feedback" });
		const cancel = () => {
			draft.clear();
			backToProfiles();
		};
		const hasSavedProfile = data.profiles.some(
			(entry) => entry.name === profile.name,
		);
		const options = element(
			"section",
			{ class: "profile-options" },
			element("h3", {}, "Manage profile"),
		);
		if (hasSavedProfile) {
			options.append(
				managementControl(
					data.default === profile.name
						? "Clear default"
						: `Use ${profile.name} by default`,
					async () => {
						if (!approveSettingsDiscard()) return;
						await managementWrite("/api/profiles-default", "PUT", {
							name: data.default === profile.name ? null : profile.name,
						});
						settingsDrafts.clear();
						await reloadProfiles();
					},
					output,
				),
			);
			const label = executorDefault
				? `Restore built-in ${profile.name}`
				: `Delete ${profile.name}`;
			const confirm = element("div", {
				class: "profile-delete-confirm",
				hidden: true,
			});
			options.append(
				button(
					label,
					() => {
						confirm.hidden = false;
						confirm.querySelector("button")?.focus();
					},
					{ class: "danger", disabled: readonly() },
				),
				confirm,
			);
			confirm.append(
				element(
					"p",
					{},
					executorDefault
						? "Remove your changes and use the built-in settings?"
						: "Delete this saved profile? Existing runs are unchanged.",
				),
				managementControl(
					"Confirm",
					async () => {
						await managementWrite(
							`/api/profiles/${encodeURIComponent(profile.name)}`,
							"DELETE",
						);
						draft.clear();
						await reloadProfiles();
					},
					output,
					{ class: "danger" },
				),
				button("Keep profile", () => {
					confirm.hidden = true;
				}),
			);
		}
		const configuration = element(
			"div",
			{ class: "management-fields" },
			field("Permission mode", permission),
			field("Strict capabilities (comma separated)", strict),
		);
		for (const control of [permission, strict]) control.disabled = readonly();
		const draft = settingsDraft(editor, () => ({
			name: id.value.trim(),
			permissionMode: permission.value,
			strictCapabilities: strict.value
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		}));
		editor.replaceChildren(
			element(
				"nav",
				{ class: "profile-breadcrumb", "aria-label": "Profile navigation" },
				button("← Profiles", backToProfiles, {
					class: "link",
					"aria-label": "Back to profiles",
					"data-profile-back": "",
				}),
				element("span", { "aria-hidden": "true" }, "/"),
				element("span", {}, profile.name || "New profile"),
			),
			managementPanel(
				executorDefault
					? `Edit ${profile.name} defaults`
					: profile.name
						? `Edit ${profile.name}`
						: "New profile",
				!profile.name
					? element(
							"div",
							{ class: "profile-name-field" },
							field("Name", id),
							nameError,
						)
					: null,
				configuration,
				hasSavedProfile ? options : null,
				output,
				element(
					"div",
					{ class: "profile-editor-actions profile-editor-actions-sticky" },
					managementControl(
						"Save profile",
						async () => {
							if (!id.value.trim()) {
								nameError.textContent = "Enter a profile name before saving.";
								nameError.hidden = false;
								id.setAttribute("aria-invalid", "true");
								const descriptions = new Set(
									(id.getAttribute("aria-describedby") || "")
										.split(/\s+/)
										.filter(Boolean),
								);
								descriptions.add(nameError.id);
								id.setAttribute(
									"aria-describedby",
									[...descriptions].join(" "),
								);
								id.focus({ preventScroll: true });
								nameError.parentElement.scrollIntoView({ block: "center" });
								return;
							}
							clearNameError();
							const values = {
								...(permission.value
									? { permissionMode: permission.value }
									: {}),
								...(strict.value.trim()
									? {
											strictCapabilities: strict.value
												.split(",")
												.map((s) => s.trim())
												.filter(Boolean),
										}
									: {}),
							};
							const unset = ["permissionMode", "strictCapabilities"].filter(
								(key) => values[key] === undefined,
							);
							// The API merges values under the store lock. Patch only visible fields;
							// never normalize, revalidate, or unset hidden profile/role values here.
							const submitted = draft.snapshot();
							const savedName = id.value;
							await managementWrite(
								`/api/profiles/${encodeURIComponent(savedName)}`,
								"PUT",
								{
									values,
									unset,
								},
							);
							// A deliberate leave/replacement owns the current page, not this completion.
							if (
								!page.isConnected ||
								generation !== editGeneration ||
								!settingsDrafts.has(draft)
							)
								return;
							draft.saved(submitted);
							if (draft.dirty()) {
								saveOutput.replaceChildren(
									element(
										"div",
										{
											class: "profile-save-status",
											role: "status",
										},
										`Saved profile: ${savedName}. Later changes are unsaved.`,
									),
								);
								return;
							}
							draft.clear();
							await reloadProfiles(savedName);
							// Successful saves need only a concise confirmation.
							const status = element(
								"div",
								{ class: "profile-save-status", role: "status" },
								`Saved profile: ${savedName}`,
							);
							$("center").querySelector(".management-page")?.prepend(status);
						},
						saveOutput,
						{ class: "primary", "data-management-action": "save-profile" },
					),
					button("Discard changes", cancel),
					saveOutput,
				),
			),
		);
		editor.setAttribute("data-profile-edit", profile.name || "");
		overview.hidden = true;
		editor.hidden = false;
		page.scrollIntoView({ block: "start" });
		(profile.name ? permission : id)?.focus();
	}
	if (state.profile || state.createProfile) {
		const selected = data.profiles.find(
			(entry) => entry.name === state.profile,
		);
		const executorDefault = executorDefaults.find(
			(entry) => entry.executor === state.profile,
		);
		if (state.createProfile) await edit({}, undefined, true);
		else if (selected || executorDefault)
			await edit(selected || { name: state.profile }, executorDefault, true);
		else
			errors.append(
				button("← Profiles", backToProfiles, {
					class: "link",
					"aria-label": "Back to profiles",
				}),
				element(
					"p",
					{ role: "alert", class: "management-error" },
					"Profile not found.",
				),
			);
	} else {
		const focus = history.state?.newProfileReturn
			? overview.querySelector("[data-profile-new]")
			: history.state?.profileReturnFocus
				? overview.querySelector(
						`[data-profile-open="${CSS.escape(history.state.profileReturnFocus)}"]`,
					)
				: null;
		focus?.focus({ preventScroll: true });
	}
}
/** "12.4 MB" from bytes. */
function formatBytes(bytes) {
	const units = ["B", "KB", "MB", "GB"];
	let value = Number(bytes) || 0;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
function runHref(runId) {
	const params = new URLSearchParams();
	if (state.project) params.set("project", state.project);
	params.set("run", runId);
	return `/?${params}`;
}
/** A coloured dot and a word (status is never colour alone). */
function stateLabel(tone, text) {
	return element(
		"span",
		{ class: `state-label ${tone}` },
		element("span", { class: "state-dot", "aria-hidden": "true" }),
		text,
	);
}
/** Raw results and the CLI equivalent, folded away (2026-11-11). */
function moreDetails(title, ...children) {
	return element(
		"details",
		{ class: "more-details" },
		element("summary", {}, title),
		children,
	);
}
const EXECUTOR_STATES = {
	ready: ["ok", "Ready"],
	"logged-out": ["warn", "Not logged in"],
	"not-installed": ["muted", "Not installed"],
};
/*
 * Executors (2026-11-11, owner): which CLIs can run workflows here and what to do about the rest,
 * then what to know and the defaults. Adapter and environment notes have one diagnostic view.
 */
async function renderExecutors(page) {
	page
		.querySelector("h1 + p")
		?.replaceChildren(
			"The coding-agent CLIs that run workflow stages, checked on this machine without a model call.",
		);
	const body = element("div", { "aria-live": "polite" });
	const show = async (refresh = false) => {
		const result = await managementApi(
			`/api/doctor${refresh ? "?refresh=1" : ""}`,
		);
		const data = result.data;
		const executors = data.executors || [];
		const ready = executors.filter((entry) => entry.usable).length;
		const showFix = executors.some(
			(entry) => entry.fix || (!entry.usable && entry.error),
		);
		const versionNotes = executors
			.filter((entry) => entry.versionMatchesVerified === false)
			.map((entry) => ({
				id: entry.id,
				text: `${entry.id}: installed ${entry.cliVersion} differs from the verified ${entry.verifiedVersion}; capability rows marked probed may not hold`,
			}))
			.filter((note) => data.warnings?.includes(note.text));
		const mergeVersions = versionNotes.length >= 2;
		const knows = [
			...(data.warnings || []).filter(
				(text) =>
					!mergeVersions || !versionNotes.some((note) => note.text === text),
			),
			...(data.node && !data.node.supported
				? [
						`Node ${data.node.version} is older than the required ${data.node.required}.`,
					]
				: []),
			...(data.defaultExecutor?.id && data.defaultExecutor.usable === false
				? [
						`Default executor ${data.defaultExecutor.id} is not ready. ${data.defaultExecutor.profile ? `Check profile "${data.defaultExecutor.profile}". ` : ""}${data.defaultExecutor.reason || data.defaultExecutor.source || ""}`,
					]
				: []),
			...(data.runIndex?.error ? [`Run index: ${data.runIndex.error}`] : []),
			...(data.runIndex?.hint ? [`Run index: ${data.runIndex.hint}`] : []),
			...(data.home && !data.home.writable
				? [`The home ${data.home.path} is not writable.`]
				: []),
		];
		if (mergeVersions) {
			const ids = versionNotes.map((note) => note.id);
			knows.push(
				`${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}: installed version differs from the tested one (see Version). Capability rows marked probed may not hold.`,
			);
		}
		body.replaceChildren();
		append(body, [
			managementPanel(
				"Status",
				element(
					"p",
					{ class: "lead" },
					`${ready} of ${executors.length} ready. `,
					data.defaultExecutor?.id
						? data.defaultExecutor.usable === false
							? `Default executor ${data.defaultExecutor.id} is not ready.`
							: [
									"Runs use ",
									element("strong", {}, data.defaultExecutor.id),
									" unless you choose another executor.",
								]
						: "No executor is ready to run workflows.",
				),
				element(
					"div",
					{
						class: "executor-status-scroll",
						tabindex: "0",
						role: "region",
						"aria-label": "Executor status",
					},
					propertyTable(
						[
							"Executor",
							"Status",
							"Version",
							...(showFix ? ["What to do"] : []),
						],
						executors.map((entry) => {
							const [tone, label] = EXECUTOR_STATES[entry.state] || [
								entry.usable ? "ok" : "warn",
								humanize(
									entry.state || (entry.usable ? "ready" : "unavailable"),
								),
							];
							return [
								element("strong", {}, entry.id),
								stateLabel(tone, label),
								entry.cliVersion
									? [
											entry.cliVersion,
											entry.versionMatchesVerified === false
												? element(
														"span",
														{ class: "muted" },
														`, tested on ${entry.verifiedVersion}`,
													)
												: null,
										]
									: "n/a",
								...(showFix
									? [entry.fix || (entry.usable ? "" : entry.error || "")]
									: []),
							];
						}),
						{ class: "property-table executors" },
					),
				),
			),
			knows.length
				? managementPanel(
						"Things to know",
						element(
							"ul",
							{ class: "notes-list" },
							knows.map((text) => element("li", {}, text)),
						),
					)
				: null,
			managementPanel(
				"Defaults",
				propertyTable(
					null,
					[
						[
							"Default executor",
							data.defaultExecutor?.id
								? element("strong", {}, data.defaultExecutor.id)
								: "none ready",
						],
						[
							"Permission mode",
							[
								element("strong", {}, data.permissionMode?.mode || "free"),
								element(
									"span",
									{ class: "muted" },
									`, ${data.permissionMode?.source === "default" ? "default" : "saved"}`,
								),
							],
						],
						[
							"Models and effort",
							element(
								"a",
								{
									href: `/?${new URLSearchParams({ ...(state.project ? { project: state.project } : {}), view: "profiles" })}`,
								},
								"Set per executor in Profiles",
							),
						],
					],
					{ class: "property-table keyed" },
				),
			),
			diagnosticView(
				"Executor diagnostics",
				executors.some((entry) => entry.notes?.length)
					? [
							element("h2", {}, "Adapter notes"),
							propertyTable(
								null,
								executors
									.filter((entry) => entry.notes?.length)
									.map((entry) => [
										entry.id,
										element(
											"ul",
											{ class: "notes-list" },
											entry.notes.map((note) => element("li", {}, note)),
										),
									]),
								{ class: "property-table keyed" },
							),
						]
					: null,
				element("h2", {}, "Environment"),
				propertyTable(
					null,
					[
						data.node
							? [
									"Node",
									`${data.node.version} (requires ${data.node.required})`,
								]
							: null,
						data.home
							? ["Home", element("span", { class: "mono" }, data.home.path)]
							: null,
						data.defaultExecutor
							? [
									"Default executor selection",
									readableDiagnostic(data.defaultExecutor),
								]
							: null,
						data.runIndex
							? [
									"Run index",
									data.runIndex.error
										? readableDiagnostic(
												Object.fromEntries(
													Object.entries(data.runIndex).filter(
														([key]) =>
															![
																"entries",
																"stale",
																"dangling",
																"prunable",
															].includes(key),
													),
												),
											)
										: readableDiagnostic(data.runIndex),
								]
							: null,
						data.host ? ["Host", data.host] : null,
					].filter(Boolean),
				),
			),
		]);
	};
	page.append(
		element(
			"div",
			{ class: "management-actions page-actions" },
			managementControl("Refresh", () => show(true), body, { write: false }),
		),
		body,
	);
	await show();
}

start();

/** "1 project · 2 active runs · 1 needs attention" (singular forms for one). */
function overviewSummary(projectCount, running, attention) {
	return `${projectCount} ${projectCount === 1 ? "project" : "projects"}, ${running} active ${running === 1 ? "run" : "runs"}, ${attention} ${attention === 1 ? "needs" : "need"} attention`;
}
