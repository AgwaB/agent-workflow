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
	attention: "M8 3v6M8 12h.01",
	retry: "M13 6a6 6 0 1 0 1 3M8 5v3.2l2 1.2M11 2l3 1-1 3",
	interrupted: "M5.5 5.5h5v5h-5z",
	skipped: "M4 12l8-8",
	td: "M5 2.5h6v3H5zM5 10.5h6v3H5zM8 5.5v5",
	lr: "M1.5 5h4v6h-4zM10.5 5h4v6h-4zM5.5 8h5",
	fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
	sidebar: "M2.5 3.5h11v9h-11zM6.5 3.5v9",
	agent: "M8 1.8l1.6 4.6 4.6 1.6-4.6 1.6L8 14.2 6.4 9.6 1.8 8l4.6-1.6z",
	code: "M5.5 4L1.8 8l3.7 4M10.5 4l3.7 4-3.7 4",
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
	if (!Number.isFinite(ms)) return "—";
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
	if (run.status === "interrupted")
		return "Stopped by you. Completed work is kept. Resume when ready.";
	if (
		tasks.some((t) => t.statusDetail === "executor_needs_decision") ||
		run.needsYou?.some((n) => n.kind === "decision")
	)
		return `${reviewing ? "Reviewing" : "Work"} is paused. The executor couldn't confirm whether one task ran — you need to decide.`;
	if (run.status === "failed" && run.verdictGate)
		return `Finished ${ago(run.updatedAt, time).replace(/(\d)([mhd])/, "$1 $2")} with verdict ${run.verdict ? verdictWord(run.verdict) : "not passed"}. The final gate did not pass; the report explains why.${run.reportAvailable ? " Report is ready." : ""}`;
	if (run.status === "failed")
		return failed
			? `Stopped at ${failed.stageId}. ${/contract/.test(failed.statusDetail || "") ? "Output didn't match the contract." : "A task failed."} Inspect and resume when ready.`
			: "A task failed. Inspect and resume when ready.";
	if (run.status === "completed")
		return `Finished ${ago(run.updatedAt, time).replace(/(\d)([mhd])/, "$1 $2")}.${run.reportAvailable ? " Report is ready." : ""}`;
	if (run.status === "blocked")
		return "Work is paused. Review the run details before continuing.";
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
			? `Waiting to retry · attempt ${task.retry.attempt}${task.retry.maxAttempts ? ` of ${task.retry.maxAttempts}` : ""}${task.retry.nextRetryAt ? ` · next in ${countdown(task.retry.nextRetryAt)}` : ""}`
			: "Waiting for an automatic retry";
	if (state === "running")
		return `Running${task.startedAt ? ` · ${duration(now() - date(task.startedAt))}` : ""}`;
	return `${state === "completed" ? "Done" : labels[state] || "Waiting"}${task.startedAt && task.completedAt ? ` · ${duration(task.elapsedMs ?? date(task.completedAt) - date(task.startedAt))}` : ""}`;
}
const cost = (usage) =>
	usage?.costUsd == null
		? "Not collected"
		: `$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 4 : 2)}`;
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
			"report",
			"details",
			"workflows",
			"profiles",
			"maintenance",
			"executors",
		]),
		dialog: choice("dialog", ["stop", "resume"]),
		layout: choice("layout", ["td", "lr"]) || "td",
	};
}
let state = readState();
let projects = [];
let session,
	runs = [],
	run = null,
	graphModel = null,
	graphControl = null;
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
		if (value && !(key === "layout" && value === "td")) params.set(key, value);
	history[replace ? "replaceState" : "pushState"](
		null,
		"",
		`${location.pathname}${params.size ? `?${params}` : ""}`,
	);
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
	const switching = patch.run && patch.run !== state.run;
	if (switching)
		state = {
			...state,
			task: null,
			stage: null,
			tab: null,
			view: null,
			dialog: null,
		};
	if (Object.hasOwn(patch, "task")) state.stage = null;
	if (Object.hasOwn(patch, "stage")) state.task = null;
	if (patch.task || patch.stage) state.view = null;
	state = { ...state, ...patch };
	urlState(replace);
	if (railOpen) toggleRail(false);
	if (switching) loadRun();
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
				if (!railShown()) toggleRail(true);
				$("rail").querySelector(".need")?.focus();
			},
			{ class: `needs-button${needs ? "" : " none"}` },
		),
		readonly()
			? element("span", { class: "badge", id: "readonly-badge" }, "Read-only")
			: null,
		themeButton(),
		element("span", { id: "connection", class: "connection", role: "status" }),
	]);
	applyRail();
	updateConnection();
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
			? "Signed out — use the printed URL"
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
function railLine(summary) {
	if (
		summary.status === "completed" ||
		(summary.status === "failed" && summary.verdictGate)
	) {
		const outcome = finishedOutcome(summary);
		if (outcome.caveats) return "Finished · with caveats";
		if (shortfall(summary)) return outcome.word;
		return `Finished${summary.verdict ? ` · ${verdictWord(summary.verdict)}` : ""}`;
	}
	if (summary.status === "failed")
		return summary.needsYou?.[0]?.title || "A task failed";
	if (summary.status === "blocked") return "Decision required";
	if (summary.status === "interrupted") return "Stopped";
	return summary.status === "running"
		? summary.name.includes("review")
			? "Reviewing is under way"
			: "Work is under way"
		: "Waiting to start";
}
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
function visibleNeeds() {
	const dismissed = dismissedNeeds();
	return allNeeds().filter(
		(need) => need.kind !== "failed" || !dismissed.has(need.key),
	);
}
function setNeedDismissed(keys, dismissed) {
	const current = dismissedNeeds();
	for (const key of keys)
		if (dismissed) current.add(key);
		else current.delete(key);
	saveDismissedNeeds(current);
	renderTop();
	renderRail();
}

function renderRail() {
	const focusedProject = document.activeElement === $("project-switcher");
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
			["Runs", "Workflows", "Profiles", "Maintenance", "Executors"].map(
				(title) => {
					const view = title.toLowerCase();
					const params = new URLSearchParams();
					if (state.project) params.set("project", state.project);
					if (view !== "runs") params.set("view", view);
					return element(
						"a",
						{
							href: `/?${params}`,
							"aria-current":
								(state.view || "runs") === view ||
								(view === "runs" && !managementView())
									? "page"
									: null,
						},
						title,
					);
				},
			),
		),
	);
	if (managementView()) return;
	if (needs.length || hidden.length)
		rail.append(element("h2", { class: "rail-heading" }, "Needs you"));
	for (const need of needs)
		rail.append(
			element(
				"div",
				{ class: "need-item" },
				button(
					[
						glyph(need.kind === "failed" ? "failed" : "blocked"),
						element(
							"span",
							{ class: "grow" },
							element("b", { class: "need-title" }, need.title),
							element("span", { class: "need-action" }, "Inspect & resume"),
							element("small", {}, `${need.run.name} ${ago(need.since)}`),
						),
					],
					() => {
						const target =
							need.run.runId === run?.runId
								? run.tasks.find((t) =>
										[t.taskId, t.specId].includes(need.taskId),
									)?.specId
								: need.taskId;
						go({
							run: need.run.runId,
							task: target || null,
							dialog: "resume",
						});
					},
					{ class: "need" },
				),
				need.kind === "failed"
					? button(
							"×",
							() => {
								// Focus the need now at this position (the next, else the previous one),
								// else the restore link.
								const index = [
									...rail.querySelectorAll(".need-item"),
								].findIndex((item) =>
									item.querySelector(`[data-need="${CSS.escape(need.key)}"]`),
								);
								setNeedDismissed([need.key], true);
								const left = [...$("rail").querySelectorAll(".need")];
								(
									left[Math.min(index, left.length - 1)] ??
									$("rail").querySelector(".need-restore")
								)?.focus({ preventScroll: true });
							},
							{
								class: "need-dismiss",
								"data-need": need.key,
								"aria-label": `Dismiss: ${need.title}`,
								title: "Dismiss (this browser; a new failure shows again)",
							},
						)
					: null,
			),
		);
	if (hidden.length)
		rail.append(
			button(
				`Show ${hidden.length} dismissed`,
				() => {
					setNeedDismissed(
						hidden.map((need) => need.key),
						false,
					);
					$("rail").querySelector(".need")?.focus({ preventScroll: true });
				},
				{ class: "need-restore link" },
			),
		);
	rail.append(element("h2", { class: "rail-heading muted" }, "Runs"));
	if (!runs.length)
		rail.append(element("p", { class: "muted" }, "No runs yet"));
	for (const summary of runs) {
		const counts = summary.agentSummary || summary.taskSummary;
		const display = summary.runId === run?.runId ? run : summary;
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
						: display.needsYou?.length ||
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
			),
			summary.taskPreview
				? element(
						"p",
						{ class: "run-task", title: summary.taskPreview },
						summary.taskPreview,
					)
				: null,
			element(
				"div",
				{ class: "row run-progress" },
				progress(counts.completed, counts.total, summary.status),
				element("span", {}, `${counts.completed} / ${counts.total}`),
			),
			element(
				"div",
				{ class: "run-line" },
				element("span", { class: "grow" }, railLine(display)),
				element(
					"span",
					{ class: "elapsed muted", "data-run-elapsed": summary.runId },
					elapsed(summary),
				),
				summary.status === "completed" && summary.reportAvailable
					? element(
							"a",
							{
								href: `?run=${encodeURIComponent(summary.runId)}&view=report`,
								onclick: (event) => {
									event.preventDefault();
									event.stopPropagation();
									go({ run: summary.runId, view: "report" });
								},
							},
							"Report ↗",
						)
					: null,
			),
		);
		rail.append(row);
	}
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
	if (run.status === "blocked" || run.needsYou?.length)
		return ["blocked", "Needs you"];
	return [run.status, labels[run.status] || "Waiting"];
}
function heroSubline() {
	const tasks = agentTasks(run),
		done = tasks.filter((t) => t.status === "completed").length;
	const noun = tasks.length === 1 ? "agent" : "agents";
	return `${run.name} · ${elapsed(run)} · ${liveRun(run) ? `${done} of ${tasks.length} ${noun} done` : `${tasks.length} ${noun}`}`;
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
	// Only a run that finished its work has a result; a failed or stopped run keeps "Status", so an
	// earlier stage's summary never reads as the outcome of a run that did not get there.
	const result =
		!liveRun(run) &&
		(run.status === "completed" || run.verdictGate) &&
		(run.verdict || run.summary || run.tasks.some((t) => t.outcome));
	const summary =
		run.summary ||
		[...run.tasks]
			.reverse()
			.find(
				(t) => t.outcome?.text && t.kind !== "foreach" && t.kind !== "support",
			)?.outcome?.text;
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
				.join(" · ") ||
			(stage.items.length ? `${stage.items.length} done` : "No agents ran")
		);
	}
	const only = stage.items[0];
	if (!only) return labels[stage.status] || "Waiting";
	if (only.status === "failed" && stage.kind === "support" && only.lastMessage)
		return `Failed — ${only.lastMessage}`;
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
	return [said, took].filter(Boolean).join(" · ") || "Done";
}
/** "dedup: raw=3, unique=3, duplicates=0" → "raw 3 · unique 3 · duplicates 0" (code-step results). */
function readablePairs(text) {
	const body = text.replace(/^[\w-]+:\s*/, "");
	const pairs = body.split(/,\s*/);
	return pairs.length > 1 && pairs.every((pair) => /^[\w-]+=\S+$/.test(pair))
		? pairs.map((pair) => pair.replace("=", " ")).join(" · ")
		: text;
}
function chooseStage(stage) {
	if (stage.ghost) return chooseStage(stage.parent);
	// 2026-11-03 (owner): a one-agent stage opens like a many-agent one — its readable result
	// first (renderSingle); "Open agent ›" leads to the raw output, logs and events.
	if (!stage.items.length && stage.tasks.length === 1)
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
function renderGraph() {
	// First drawing of this run in this tab: replay how the work travelled (cards and edges
	// appear layer by layer). Redraws after a status change do not.
	const replay = graphControl?.runId !== run.runId;
	graphControl?.destroy();
	const model = graphModel;
	// Each graph shape keeps its own view: showing the code steps fits the taller graph anew.
	const viewKey = `${run.runId}:${state.layout}:${showCode}`;
	const savedView = graphViews.get(viewKey);
	const wrap = element("div", { class: "canvas", id: "canvas" });
	const drawing = svg("svg", {
		class: "graph",
		role: "group",
		"aria-label": `Graph of ${run.name}. Arrow keys move between stages; Enter opens.`,
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
				id: "failure-hatch",
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
					id: `arrow-${state}`,
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
		horizontal = state.layout === "lr";
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
				y: horizontal ? side : axis + (height - nodeHeight(stage)) / 2,
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
		const state = edgeState(
			model.nodes.get(edge.from),
			model.nodes.get(edge.to),
		);
		const link = svg(
			"g",
			{ class: `link ${state}`, "data-link": `${edge.from}>${edge.to}` },
			svg("path", {
				class: `edge ${state}`,
				d,
				"marker-end": `url(#arrow-${state})`,
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
			? `${stage.name ? `${stage.name} · ` : ""}${stage.members.length} in parallel`
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
			class: `node ${stage.status}${stage.ghost ? " ghost" : ""}${stage.kind === "support" ? " support" : ""}${group ? " group" : ""}${nextStage(stage) ? " next" : ""}`,
			transform: `translate(${p.x},${p.y})`,
			tabindex: "0",
			role: "button",
			"data-stage": stage.id,
			...(group
				? { "data-members": stage.members.map((s) => s.id).join(",") }
				: {}),
			"aria-label": `${group ? title : stage.name || stage.id}, ${labels[stage.status] || "Waiting"}${blockedCount ? `, ${blockedCount} actions blocked` : ""}`,
		});
		node.append(
			svg("rect", { class: "outline", width: p.w, height: p.h, rx: 10 }),
			svg(
				"title",
				{},
				group
					? title
					: `${title}${stage.kind === "support" ? " · code step (no model)" : ""}`,
			),
			// 2026-11-03 (owner): the graph shows the process; what agents concluded ("2 weaken ·
			// 1 keep", "Needs work") stays in the card's text and in the result, not in its mark.
			markIcon(stage.status, 12, 12),
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
		const open = () => chooseStage(group ? stage.members[0] : stage);
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
					"aria-label": `${member.name || member.id}, ${labels[member.status] || "Waiting"}`,
				});
				row.append(
					svg("rect", {
						x: 8,
						y: y - 17,
						width: p.w - 16,
						height: 25,
						fill: "transparent",
					}),
					markIcon(member.status, 15, y - 11, 13),
					svg(
						"text",
						{ x: 36, y, class: "agent-name", "data-fit": p.w - 150 },
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
						},
						stageLine(member),
					),
				);
				row.addEventListener("click", (event) => {
					event.stopPropagation();
					chooseStage(member);
				});
				row.addEventListener("keydown", (event) => {
					if (["Enter", " "].includes(event.key)) {
						event.preventDefault();
						event.stopPropagation();
						chooseStage(member);
					}
				});
				node.append(row);
			});
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
					{ x: p.w - 14, y: p.h - 10, "text-anchor": "end", class: "fraction" },
					`${stage.done}/${stage.members.length}`,
				),
			);
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
						? `${stage.items.length} agents · inspect items`
						: `${stage.done} of ${stage.items.length} done · ${count("running")} running`,
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
					stageLine(stage),
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
							...(tone === "err" ? { fill: "url(#failure-hatch)" } : {}),
							"data-segment": task.specId,
							"aria-label": `${task.title || task.specId}, ${labels[status] || "Waiting"}${tone === "err" ? ", failed" : task.outcome?.status && task.outcome.tone !== "ok" ? `, ${task.outcome.status}` : ""}`,
						},
						svg(
							"title",
							{},
							`${task.title || task.specId} · ${task.outcome?.status || labels[status] || "Waiting"}`,
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
		const [xMin, xMax] = range(16, 16, wrap.clientWidth, b.x0, b.w);
		const [yMin, yMax] = range(16, 76, wrap.clientHeight, b.y0, b.h);
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
			dy = (wrap.clientHeight - 76) * 0.8;
		if (side === "left") view.x += dx;
		else if (side === "right") view.x -= dx;
		else if (side === "top") view.y += dy;
		else view.y -= dy;
		apply();
	}
	function updateHints() {
		const W = wrap.clientWidth,
			H = wrap.clientHeight - 60;
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
			const text = `${count[side]} more${live[side] ? " \u00b7 active" : ""}`;
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
		graphViews.set(viewKey, { ...view });
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
		const available = Math.max(100, wrap.clientHeight - 140);
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
				h * k > available ? 44 - y0 * k : 44 + (available - h * k) / 2 - y0 * k,
		};
		apply();
	}
	function reveal(stageId, focus = false) {
		const id = model.owner.get(stageId) ?? stageId;
		const p = positions.get(id);
		if (!p) return;
		if (
			!focus &&
			p.x * view.k + view.x >= 0 &&
			p.y * view.k + view.y >= 0 &&
			(p.x + p.w) * view.k + view.x < wrap.clientWidth &&
			(p.y + p.h) * view.k + view.y < wrap.clientHeight - 60
		)
			return;
		view.manual = true;
		if (focus) view.k = Math.min(1.15, (wrap.clientWidth - 32) / p.w);
		view.x = wrap.clientWidth / 2 - (p.x + p.w / 2) * view.k;
		view.y = (wrap.clientHeight - 60) / 2 - (p.y + p.h / 2) * view.k;
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
		if (dragged && !dragged.moved && !$("inspector").hidden) closeInspector();
		dragged = null;
	});
	wrap.addEventListener("pointercancel", () => {
		dragged = null;
	});
	// Code steps are hidden unless this switch shows them (owner's pick, 2026-11-03).
	if (model.codeSteps)
		wrap.append(
			element(
				"button",
				{
					type: "button",
					class: "code-switch",
					role: "switch",
					"aria-checked": String(showCode),
					title: showCode
						? "Hide the steps the engine runs itself"
						: "Show the steps the engine runs itself (no model)",
				},
				element("span", { class: "track", "aria-hidden": "true" }),
				kindIcon("code"),
				element(
					"span",
					{
						class: "code-switch-count",
						"data-short": showCode
							? `${model.codeSteps} shown`
							: model.hiddenCode
								? `${model.hiddenCode} hidden`
								: "Code",
					},
					showCode
						? `${model.codeSteps} code step${model.codeSteps === 1 ? "" : "s"} shown`
						: model.hiddenCode
							? `${model.hiddenCode} code step${model.hiddenCode === 1 ? "" : "s"} hidden`
							: "Code steps",
				),
				element(
					"span",
					{ class: "code-switch-action" },
					showCode ? "Hide" : "Show",
				),
			),
		);
	wrap.querySelector(".code-switch")?.addEventListener("click", toggleCode);
	wrap.append(
		element(
			"div",
			{ class: "toolbar", role: "toolbar", "aria-label": "Graph view" },
			button([markIcon("fit"), "Fit"], fit, { title: "Fit graph (F)" }),
			button("Focus", () => {
				const id =
					selectedStage() ||
					[...model.nodes.values()].find((s) =>
						["running", "retry", "blocked", "failed"].includes(s.status),
					)?.id ||
					[...model.nodes.keys()].at(-1);
				reveal(id, true);
			}),
			button(markIcon("td"), () => changeLayout("td"), {
				"aria-label": "Top-down",
				title: "Top-down",
				"aria-pressed": String(!horizontal),
			}),
			button(markIcon("lr"), () => changeLayout("lr"), {
				"aria-label": "Left-right",
				title: "Left-right",
				"aria-pressed": String(horizontal),
			}),
			button("?", openStatusKey, { "aria-label": "Status key" }),
		),
	);
	function resize() {
		if (!view.manual) return fit();
		view.x += (wrap.clientWidth - (view.width || wrap.clientWidth)) / 2;
		view.y += (wrap.clientHeight - (view.height || wrap.clientHeight)) / 2;
		apply();
	}
	wrap.append(...Object.values(hints));
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
		if (wrap.isConnected) {
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
	graphControl = {
		destroy: () => {
			observer.disconnect();
			for (const animation of packets) animation.cancel();
		},
		fit,
		reveal,
		handoff,
		morph,
	};
	return wrap;
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
function toggleCode() {
	showCode = !showCode;
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
	const signature = graphSignature(graphModel, state.layout);
	const canvas = $("canvas");
	const keepGraph =
		canvas &&
		graphControl?.signature === signature &&
		graphControl.runId === run.runId;
	if (keepGraph) {
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
function usageRows(usage) {
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
		usage?.tasksReporting != null
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
				`${sample.tool}${sample.command ? `: ${sample.command}` : ""} — ${sample.reason}${sample.source ? ` (${sample.source} policy)` : " (source unknown)"}`,
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
	const task = selectedTask(),
		stage = graphModel?.stages.get(state.stage);
	const visible = !!task || !!stage || state.view === "details";
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
	for (const node of document.querySelectorAll(".node"))
		node.classList.toggle(
			"selected",
			node.dataset.stage === selectedStage() ||
				(node.dataset.members?.split(",") ?? []).includes(selectedStage()),
		);
	for (const row of document.querySelectorAll(".stage-row"))
		row.classList.toggle("selected", row.dataset.stage === selectedStage());
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
				element("h3", {}, "Launch command"),
				run.launch?.command
					? commandBlock(run.launch.command)
					: element("p", { class: "muted" }, "Not collected"),
				definition([
					["Host", run.launch?.host || run.host || "Not collected"],
					["Permission mode", run.permissionMode || "Not collected"],
					...usageRows(run.usage),
				]),
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
			(status === "failed"
				? task.lastMessage || "A task failed. Inspect the logs before resuming."
				: null);
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
				element(
					"p",
					{ class: "executor-line" },
					[
						task.executor || run.executor || "No executor",
						task.model || "default model",
						task.effort || "default",
					].join(" · "),
				),
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
				["Agent", task.agent || "Not collected"],
				task.retry
					? [
							"Attempts",
							`Attempt ${task.retry.attempt}${task.retry.maxAttempts ? ` of ${task.retry.maxAttempts}` : ""}${task.retry.nextRetryAt ? ` · scheduled ${task.retry.nextRetryAt}` : ""}`,
						]
					: null,
				["Started", task.startedAt || "Not started"],
				["Ended", task.completedAt || "—"],
				...usageRows(task.usage),
				["Depends on", task.dependsOn?.join(", ") || "None"],
				task.worktree
					? [
							"Worktree",
							[task.worktree.branch, task.worktree.path]
								.filter(Boolean)
								.join(" · ") || "Not collected",
						]
					: null,
			]),
			element("h3", {}, "Terminal handoff"),
			["stderr", "output"].map((stream) =>
				commandBlock(
					`agent-workflow logs ${shellArg(run.runId)} --task ${shellArg(task.specId)} --stream ${stream}`,
				),
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
			task.outcome.text ? ` · ${task.outcome.text}` : null,
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
	const open = button("Open agent ›", () => go({ task: task.specId }), {
		class: "item-open",
	});
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
					: `${taskLine(task)} — no result yet.`,
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
			`‹ ${humanize(stage.id)} · ${stage.items.length} agents`,
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
			[taskLine(task), task.executor || run.executor, task.model, task.effort]
				.filter(Boolean)
				.join(" · "),
		),
		itemExpansion(task, "stage-result", false, "single"),
	);
}
function renderItems(inspector, stage, previous = new Map()) {
	if (stage.kind !== "foreach" && stage.items.length === 1)
		return renderSingle(inspector, stage);
	inspector.append(
		inspectorHeader(humanize(stage.id), stage.status),
		element(
			"p",
			{ class: "agents-meta" },
			`${stage.items.length} agents · ${stage.done} done`,
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
							title: `${task.title || task.specId} · ${taskLine(task)}${task.outcome?.text ? ` · ${task.outcome.text}` : ""}`,
							"aria-label": `${task.title || task.specId} · ${taskLine(task)}`,
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
							: "No result yet — the task has not finished."),
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
				: "No logs yet — this task has not started.");
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
	reportGeneration++;
	$("dialog").close();
	modalKey = "";
	if (update && (state.dialog || state.view === "report")) {
		state.dialog = null;
		if (state.view === "report") state.view = null;
		urlState();
	}
	if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}
function renderModal() {
	if (!run) return;
	if (!state.dialog && state.view === "report") {
		if (modalKey !== `report:${run.runId}`) openReport();
		return;
	}
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
				"Records a durable stop intent, then waits for the active supervisor to confirm (up to 15 s). Stop requested — waiting for supervisor confirmation, then Stopped. In-flight usage may not be collected.",
			),
		];
	} else if (kind === "resume") {
		title = `Resume ${run.name}?`;
		confirm = "Resume run";
		content = [
			element(
				"p",
				{},
				"Resets failed, interrupted and resumable blocked tasks, then continues. Completed tasks are not relaunched.",
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
				readonly() ? "Read-only — action disabled" : "Esc to cancel",
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
				index ? "; " : main ? " — " : "",
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
function reportPage(dialog) {
	const page = dialog.dataset.page ?? document.documentElement.dataset.theme;
	if (page === "light" || page === "dark") return page;
	return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
/** Called once the report dialog is open (openDialog clears the previous page choice). */
function reportPageButton(dialog) {
	const stored = storedReportPage();
	if (stored) dialog.dataset.page = stored;
	const control = button(
		"",
		() => {
			const next = reportPage(dialog) === "dark" ? "light" : "dark";
			try {
				localStorage.setItem(REPORT_PAGE_KEY, next);
			} catch {
				// The choice then lasts for this report only.
			}
			dialog.dataset.page = next;
			label();
		},
		{ class: "report-page" },
	);
	const label = () => {
		control.textContent =
			reportPage(dialog) === "dark" ? "Light page" : "Dark page";
	};
	label();
	return control;
}
/** The report's sections (its `##` headings) as a contents list; nothing for a short report. */
function reportContents(container) {
	const sections = [...container.querySelectorAll(".md-h2")];
	if (sections.length < 3) return null;
	// On a phone the list folds behind "Contents" (it took half the first screen).
	const nav = element(
		"nav",
		{ class: "report-toc", "aria-label": "Report sections" },
		element("span", { class: "muted toc-label" }, "Contents"),
		button("Contents", () => toggle(), {
			class: "toc-toggle",
			"aria-expanded": "false",
		}),
		...sections.map((heading) =>
			button(
				heading.textContent,
				() => {
					toggle(false);
					heading.scrollIntoView({ block: "start", behavior: "smooth" });
				},
				{ class: "toc-entry" },
			),
		),
	);
	const toggle = (open = !nav.classList.contains("open")) => {
		nav.classList.toggle("open", open);
		nav
			.querySelector(".toc-toggle")
			.setAttribute("aria-expanded", String(open));
	};
	return nav;
}
async function openReport() {
	const id = run.runId,
		generation = ++reportGeneration;
	const body = element(
		"div",
		{ class: "report-content", id: "report-content" },
		"Loading report…",
	);
	openDialog(
		`report:${id}`,
		[
			element("h2", { id: "dialog-title" }, `${run.name} · Report`),
			body,
			element(
				"footer",
				{},
				button("Close", () => dismissDialog(), { "data-cancel": "true" }),
			),
		],
		"report",
	);
	const footer = $("dialog").querySelector("footer");
	footer.prepend(reportPageButton($("dialog")));
	try {
		const data = await api(`/api/runs/${encodeURIComponent(id)}/report`);
		if (generation !== reportGeneration || modalKey !== `report:${id}`) return;
		body.replaceChildren();
		renderTextMarkdown(body, data.text);
		reportBlocks(body);
		const contents = reportContents(body);
		if (contents) body.prepend(contents);
		if (data.truncated)
			body.append(
				element("p", { class: "muted" }, "Report truncated by the host."),
			);
	} catch (error) {
		if (generation === reportGeneration)
			body.textContent = `Report unavailable: ${error.message}`;
	}
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
					? "Auto-retry — no action"
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
	const entries = [
		...runs.map((r) => ({
			text: `${r.name} · ${r.runId.slice(-6)}`,
			choose: () => go({ run: r.runId, dialog: null, view: null }),
		})),
		...[...(graphModel?.stages.values() || [])]
			.filter((s) => !s.ghost)
			.map((s) => ({
				text: s.id,
				choose: () => {
					state.dialog = null;
					chooseStage(s);
				},
			})),
	];
	function paint() {
		matches = entries.filter((entry) =>
			entry.text.toLowerCase().includes(input.value.toLowerCase()),
		);
		selected = Math.max(0, Math.min(selected, matches.length - 1));
		list.replaceChildren(
			...matches.map((entry, i) =>
				button(
					entry.text,
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
			),
		);
		if (!matches.length)
			list.append(element("p", { class: "muted" }, "No matches"));
		input.setAttribute(
			"aria-activedescendant",
			matches.length ? `palette-${selected}` : "",
		);
		list.children[selected]?.scrollIntoView({ block: "nearest" });
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
	renderTop();
	renderRail();
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
	// 2026-11-03: a stage the user was watching stays selected after the run finishes and hides the
	// result; when the run leaves `running`, a stage selection (not a task) is cleared.
	const finishing = run?.status === "running" && data.status !== "running";
	runRevision++;
	run = data;
	if (finishing && state.stage && !state.task) {
		state.stage = null;
		urlState(true);
	}
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
			if (!state.run && runs.length) {
				const first = runs.find((r) => r.status === "running") || runs[0];
				go({ run: first.runId }, true);
			}
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
window.addEventListener("popstate", () => {
	if (
		managementView() ||
		["workflows", "profiles", "maintenance", "executors"].includes(
			readState().view,
		)
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
		else {
			state.run =
				runs.find((r) => r.status === "running")?.runId || runs[0]?.runId;
			if (state.run) loadRun();
		}
	} else if (run) renderRun();
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
		if (summary) node.textContent = elapsed(summary);
	}
	if (!run) return;
	refreshGraphTexts();
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
	for (const node of document.querySelectorAll("[data-stage-line]")) {
		const stage = graphModel?.stages.get(node.dataset.stageLine);
		if (stage && ["running", "retry"].includes(stage.status)) {
			const text = stageLine(stage);
			node.dataset.full = text;
			if (node.firstElementChild) node.firstElementChild.textContent = text;
		}
	}
	for (const node of document.querySelectorAll("[data-agent-state]")) {
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
								project.pathMissing ? " · path missing" : "",
							),
							element(
								"p",
								{},
								`${project.counts.running} active · ${project.counts.needsAttention} need attention`,
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
		if (!state.run) {
			state.run =
				runs.find((r) => r.status === "running")?.runId ||
				runs[0]?.runId ||
				null;
			urlState(true);
		}
		if (state.run) await loadRun();
		else {
			$("center").replaceChildren(
				element(
					"p",
					{ class: "empty" },
					"No runs in this project. Start one from your terminal.",
				),
			);
			connectEvents();
		}
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
	return ["workflows", "profiles", "maintenance", "executors"].includes(
		state.view,
	);
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
function managementResult(value) {
	return element(
		"div",
		{ class: "management-result", role: "status" },
		element("pre", {}, value.text || JSON.stringify(value, null, 2)),
		element(
			"details",
			{},
			element("summary", {}, "Structured details"),
			element("pre", {}, JSON.stringify(value.data || value, null, 2)),
		),
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
async function modelControls(saved = {}, prefix = "") {
	const data = (await managementApi("/api/executors/models")).data;
	const ids = data.executors.map((entry) => entry.id);
	if (saved.executor && !ids.includes(saved.executor)) ids.push(saved.executor);
	const exec = choices(`${prefix}Executor`, ["", ...ids], saved.executor || "");
	const model = input(`${prefix}Model`, saved.model || "", {
		placeholder: "Executor default",
	});
	const effort = choices(
		`${prefix}Effort`,
		["", ...EFFORT_LEVELS],
		saved.effort || "",
	);
	const list = element("datalist", { id: `models-${++modelControlId}` });
	model.setAttribute("list", list.id);
	const note = element("small", { class: "muted" });
	const update = () => {
		const entry = data.executors.find((entry) => entry.id === exec.value);
		list.replaceChildren(
			...(entry?.models || []).map((id) => element("option", { value: id })),
		);
		note.textContent =
			entry?.note || "Choose an executor for its model suggestions.";
	};
	exec.addEventListener("change", update);
	update();
	return {
		node: element(
			"div",
			{ class: "management-fields" },
			field("Executor", exec),
			field("Model", model),
			field("Effort", effort),
			list,
			note,
		),
		values: () =>
			Object.fromEntries(
				[
					["executor", exec.value],
					["model", model.value],
					["effort", effort.value],
				].filter(([, value]) => value),
			),
	};
}
let modelControlId = 0;
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
async function roleEditor(roles = {}) {
	const rows = element("div", { class: "management-role-rows" });
	const entries = [];
	async function add(key = "", value = {}) {
		const role = input("Role name", key, {
			placeholder: "default, verification, agent:reader…",
		});
		const model = await modelControls(value, `Role ${key || "new"} `);
		const row = element(
			"div",
			{ class: "management-role" },
			field("Role", role),
			model.node,
		);
		const entry = { role, model, row };
		entries.push(entry);
		row.append(
			button(
				"Remove role",
				() => {
					entries.splice(entries.indexOf(entry), 1);
					row.remove();
				},
				{ disabled: readonly() },
			),
		);
		rows.append(row);
	}
	for (const [key, value] of Object.entries(roles)) await add(key, value);
	const errors = element("div");
	return {
		node: element(
			"div",
			{},
			rows,
			managementControl(
				"Add role",
				async () => {
					await add();
					errors.replaceChildren();
				},
				errors,
			),
			errors,
		),
		values: () =>
			Object.fromEntries(
				entries.map(({ role, model }) => {
					if (!role.value.trim())
						throw new Error("Enter a name for each role.");
					return [role.value.trim(), model.values()];
				}),
			),
	};
}
async function renderManagement() {
	connection = "Live";
	lastEvent = Date.now();
	renderTop();
	renderRail();
	const title = humanize(state.view);
	const page = element(
		"div",
		{ class: "management-page", "data-management": state.view },
		element("h1", {}, title),
		element(
			"p",
			{ class: "muted" },
			["profiles", "executors"].includes(state.view)
				? "User level · shared by every project and host"
				: "Selected project · shared host actions",
		),
	);
	$("center").replaceChildren(page);
	try {
		if (["workflows", "maintenance"].includes(state.view) && !state.project) {
			page.append(
				element(
					"p",
					{ class: "empty" },
					"Choose a project in the sidebar to manage its workflows and history.",
				),
			);
			return;
		}
		if (state.view === "workflows") await renderWorkflows(page);
		if (state.view === "profiles") await renderProfiles(page);
		if (state.view === "maintenance") await renderMaintenance(page);
		if (state.view === "executors") await renderExecutors(page);
	} catch (error) {
		page.append(
			element("p", { role: "alert", class: "management-error" }, error.message),
			button("Try again", renderManagement),
		);
	}
}
async function renderWorkflows(page) {
	const [catalog, agents] = await Promise.all([
		managementApi(projectRoute("workflows")),
		managementApi(projectRoute("agents")),
	]);
	const list = managementPanel("Available workflows");
	const detail = element("div", { "aria-live": "polite" });
	page.append(list, detail);
	if (!catalog.data.workflows.length)
		list.append(
			element(
				"p",
				{},
				"No workflows yet. Add a workflow definition to .agent-workflow/workflows, or install a workflow bundle. Run agent-workflow list to discover it.",
			),
		);
	for (const workflow of catalog.data.workflows) {
		list.append(
			element(
				"article",
				{ class: "management-list-row" },
				managementControl(
					workflow.name,
					async () => {
						const data = await managementApi(
							projectRoute(`workflows/${encodeURIComponent(workflow.name)}`),
						);
						// Display authored stage/agent names, not a second compiler or execution plan.
						const authored = JSON.parse(data.spec.data.spec);
						const stages = Array.isArray(authored.artifactGraph?.stages)
							? authored.artifactGraph.stages
							: [];
						const panel = managementPanel(
							workflow.name,
							element("h3", {}, "Stages and agents"),
							element(
								"ul",
								{},
								stages.map((stage) =>
									element(
										"li",
										{},
										`${stage.id} · ${stage.type || (stage.support ? "code" : "stage")} · ${stage.agent || authored.defaults?.agent || "executor default"}`,
									),
								),
							),
							managementResult(data.validation),
							element(
								"details",
								{},
								element("summary", {}, "Stages and agents · resolved spec"),
								element("pre", {}, data.spec.data.spec),
							),
							element(
								"details",
								{},
								element("summary", {}, "Compiled roles"),
								managementResult(data.roles),
							),
						);
						detail.replaceChildren(panel);
						const options = await modelControls();
						const profiles =
							(await managementApi("/api/profiles")).data.profiles || [];
						const profile = choices("Check profile", [
							"",
							...new Set([
								...profiles.map((p) => p.name),
								...Object.keys(authored.executionProfiles || {}),
								"pi",
								"claude",
								"codex",
								"mixed",
							]),
						]);
						const permission = choices("Check permission mode", [
							"",
							"free",
							"safe",
						]);
						const output = element("div");
						const command = element("div");
						const selected = () => ({
							...options.values(),
							...(profile.value ? { profile: profile.value } : {}),
							...(permission.value ? { permissionMode: permission.value } : {}),
						});
						const awCommand = `aw run ${shellArg(workflow.name)} "<task>"`;
						const update = () => {
							const flags = Object.entries(selected())
								.map(
									([key, value]) =>
										` --${key === "permissionMode" ? "permission-mode" : key} ${shellArg(value)}`,
								)
								.join("");
							command.replaceChildren(commandHint(awCommand));
							if (flags)
								command.append(
									element(
										"p",
										{ class: "muted" },
										"aw uses saved defaults; for these explicit Check overrides use the CLI:",
									),
									commandHint(
										`agent-workflow run ${shellArg(workflow.name)} "<task>"${flags}`,
									),
								);
						};
						const form = element(
							"div",
							{ class: "management-fields", onchange: update, oninput: update },
							options.node,
							field("Profile (optional)", profile),
							field("Permission mode", permission),
						);
						panel.append(
							element("h3", {}, "Check · no run or model call"),
							form,
							managementControl(
								"Check",
								async () => {
									output.replaceChildren(
										managementResult(
											await managementWrite(
												projectRoute(
													`workflows/${encodeURIComponent(workflow.name)}/check`,
												),
												"POST",
												selected(),
											),
										),
									);
								},
								output,
								{ "data-management-action": "check" },
							),
							output,
							command,
						);
						update();
					},
					detail,
					{ write: false },
				),
				element("p", {}, workflow.description || "No description."),
				element(
					"small",
					{ class: "muted" },
					`Source: ${workflow.scope || "catalog"} · ${workflow.specPath} · aliases: ${workflow.aliases.join(", ") || "none"}${workflow.agent ? ` · agent: ${workflow.agent}` : ""}${workflow.readOnly !== undefined ? ` · read-only: ${workflow.readOnly}` : ""}`,
				),
				workflow.routing
					? element(
							"p",
							{ class: "muted" },
							Object.entries(workflow.routing)
								.map(([key, hints]) => `${humanize(key)}: ${hints.join("; ")}`)
								.join(" · "),
						)
					: null,
			),
		);
	}
	page.append(
		managementPanel(
			"Agents",
			agents.data.agents.length
				? agents.data.agents.map((agent) =>
						element(
							"article",
							{ class: "management-list-row" },
							element("h3", {}, agent.displayName),
							element("p", {}, agent.description || "No description."),
							element(
								"small",
								{ class: "muted" },
								`${agent.scope} · ${agent.sourcePath}${agent.model ? ` · ${agent.model}` : ""}`,
							),
						),
					)
				: element(
						"p",
						{},
						"No agents yet. Add an agent to .agent-workflow/agents.",
					),
		),
	);
}
/** `role  executor:model:effort` lines of a role map, as the CLI shows them. */
function roleTable(roles = {}) {
	const order = [
		"default",
		"planning",
		"research-execution",
		"synthesis",
		"verification",
		"final-judgment",
	];
	const keys = Object.keys(roles).sort(
		(a, b) =>
			(order.includes(a) ? order.indexOf(a) : order.length) -
				(order.includes(b) ? order.indexOf(b) : order.length) ||
			a.localeCompare(b),
	);
	if (!keys.length)
		return element("p", { class: "muted" }, "No model or effort set.");
	const width = Math.max(...keys.map((key) => key.length));
	return element(
		"pre",
		{ class: "management-role-table" },
		keys
			.map((key) => {
				const entry = roles[key];
				return `${key.padEnd(width)}  ${entry.executor || "-"}:${entry.model || "-"}:${entry.effort || "-"}`;
			})
			.join("\n"),
	);
}
async function renderProfiles(page) {
	const [result, presets, preferences] = await Promise.all([
		managementApi("/api/profiles"),
		managementApi("/api/profiles/presets"),
		managementApi("/api/workflow-preferences"),
	]);
	const data = result.data;
	const list = managementPanel("Saved profiles");
	const editor = element("div");
	const errors = element("div");
	page.append(list, errors, editor);
	if (!data.profiles.length)
		list.append(
			element(
				"p",
				{},
				"No profiles yet. Choose New profile below, or run agent-workflow profile set <name> --executor <id>.",
			),
		);
	list.append(
		element("p", { class: "muted" }, `Default: ${data.default || "none"}`),
	);
	const executorDefaults = data.executorDefaults || [];
	const executorProfileNames = new Set(
		executorDefaults.map((entry) => entry.executor),
	);
	for (const profile of data.profiles)
		list.append(
			element(
				"div",
				{ class: "management-list-row" },
				managementControl(
					profile.name,
					async () => {
						await edit(profile);
					},
					errors,
					{ write: false },
				),
				element(
					"small",
					{ class: "muted" },
					[
						executorProfileNames.has(profile.name)
							? `default profile of ${profile.name} stages`
							: "",
						profile.executor,
						profile.model,
						profile.permissionMode,
					]
						.filter(Boolean)
						.join(" · "),
				),
				managementControl(
					`Use ${profile.name} by default`,
					async () => {
						await managementWrite("/api/profiles-default", "PUT", {
							name: profile.name,
						});
						await renderManagement();
					},
					errors,
				),
				managementControl(
					`Delete ${profile.name}`,
					async () => {
						await managementWrite(
							`/api/profiles/${encodeURIComponent(profile.name)}`,
							"DELETE",
						);
						await renderManagement();
					},
					errors,
				),
			),
		);
	list.append(
		managementControl(
			"Clear default",
			async () => {
				await managementWrite("/api/profiles-default", "PUT", { name: null });
				await renderManagement();
			},
			errors,
		),
		managementControl(
			"New profile",
			async () => {
				await edit({});
			},
			errors,
			{ write: false },
		),
	);
	// Executor default profiles: the model/effort of each executor's stages where nothing else sets
	// them. Editing one saves a profile named after the executor that holds only the changes.
	const executorPanel = managementPanel(
		"Executor default profiles",
		element(
			"p",
			{ class: "muted" },
			"Model and effort of each executor's stages where the workflow, the launch and the chosen profile set none. Your changes apply on top of the built-in profile.",
		),
	);
	for (const entry of executorDefaults) {
		const saved = data.profiles.find(
			(profile) => profile.name === entry.executor,
		);
		executorPanel.append(
			element(
				"div",
				{
					class: "management-list-row management-executor-default",
					"data-executor-default": entry.executor,
				},
				element("strong", {}, entry.executor),
				managementControl(
					`Edit ${entry.executor} default`,
					async () => {
						await edit(saved || { name: entry.executor }, entry);
					},
					errors,
					{ write: false },
				),
				...(saved
					? [
							managementControl(
								`Restore built-in ${entry.executor}`,
								async () => {
									await managementWrite(
										`/api/profiles/${encodeURIComponent(entry.executor)}`,
										"DELETE",
									);
									await renderManagement();
								},
								errors,
							),
						]
					: []),
				element("p", { class: "muted" }, entry.note),
			),
			roleTable(entry.roles),
		);
	}
	list.after(executorPanel);
	async function edit(profile, executorDefault) {
		const id = input("Profile name", profile.name || "", {
			maxlength: 64,
			readonly: !!profile.name,
		});
		const models = await modelControls(profile);
		const roles = await roleEditor(profile.roles);
		const permission = choices(
			"Profile permission mode",
			["", "free", "safe"],
			profile.permissionMode || "",
		);
		const preset = choices("Profile preset", [
			["", "None (keep current)"],
			...presets.data.presets.map((p) => [p.id, `${p.id} — ${p.description}`]),
		]);
		const strict = input(
			"Strict capabilities (comma separated)",
			(profile.strictCapabilities || []).join(", "),
		);
		const output = element("div");
		editor.replaceChildren(
			managementPanel(
				profile.name ? `Edit ${profile.name}` : "New profile",
				...(executorDefault
					? [
							element(
								"p",
								{ class: "muted" },
								`Changes to the default profile of ${executorDefault.executor} stages. Leave a field empty to keep what it runs now:`,
							),
							roleTable(executorDefault.roles),
						]
					: []),
				field("Name", id),
				field("Start from preset", preset),
				models.node,
				field("Permission mode", permission),
				field("Strict capabilities (comma separated)", strict),
				element("h3", {}, "Role assignments"),
				roles.node,
				managementControl(
					"Save profile",
					async () => {
						const values = {
							...models.values(),
							...(permission.value ? { permissionMode: permission.value } : {}),
							...(strict.value.trim()
								? {
										strictCapabilities: strict.value
											.split(",")
											.map((s) => s.trim())
											.filter(Boolean),
									}
								: {}),
							roles: roles.values(),
						};
						const unset = [
							"executor",
							"model",
							"effort",
							"permissionMode",
							"strictCapabilities",
						].filter((key) => values[key] === undefined);
						// Removing a role is explicit: the host API deliberately merges role maps.
						unset.push(
							...Object.keys(profile.roles || {})
								.filter((key) => !Object.hasOwn(values.roles, key))
								.map((key) => `roles.${key}`),
						);
						const saved = await managementWrite(
							`/api/profiles/${encodeURIComponent(id.value)}`,
							"PUT",
							{
								values,
								unset,
								...(preset.value ? { preset: preset.value } : {}),
							},
						);
						await renderManagement();
						$("center")
							.querySelector(".management-page")
							.append(managementResult(saved));
					},
					output,
					{ "data-management-action": "save-profile" },
				),
				output,
				commandHint(
					`agent-workflow profile set ${shellArg(profile.name || "<name>")} --executor <id>`,
				),
			),
		);
	}
	page.append(
		managementPanel(
			"Presets",
			presets.data.presets.map((preset) =>
				element(
					"details",
					{},
					element("summary", {}, `${preset.id} — ${preset.description}`),
					element("pre", {}, JSON.stringify(preset.roles, null, 2)),
				),
			),
		),
	);
	const prefPanel = managementPanel(
		"Per-workflow preferences",
		element(
			"p",
			{ class: "muted" },
			"Stored at user level; workflow definitions and declared profiles are resolved in the selected project.",
		),
	);
	page.append(prefPanel);
	if (!state.project) {
		prefPanel.append(
			element("p", {}, "Choose a project to edit workflow preferences."),
		);
		return;
	}
	const workflows = (await managementApi(projectRoute("workflows"))).data
		.workflows;
	const prefOutput = element("div");
	const prefEditor = element("div");
	for (const workflow of workflows) {
		const saved = preferences.data.preferences.find(
			(pref) => pref.workflow === workflow.name,
		);
		prefPanel.append(
			managementControl(
				`${workflow.name}${saved?.profile ? ` · ${saved.profile}` : ""}`,
				async () => {
					const path = `/api/workflow-preferences/${encodeURIComponent(workflow.name)}?project=${encodeURIComponent(state.project)}`;
					const current = (await managementApi(path)).data.preference || {};
					const profile = input(
						"Workflow preferred profile",
						current.profile || "",
						{ placeholder: "Declared profile, saved profile or preset" },
					);
					const roles = await roleEditor(current.roles);
					prefEditor.replaceChildren(
						element("h3", {}, workflow.name),
						field("Profile", profile),
						roles.node,
						managementControl(
							"Save workflow preference",
							async () => {
								const values = roles.values();
								const unset = [
									...(!profile.value ? ["profile"] : []),
									...Object.keys(current.roles || {})
										.filter((key) => !Object.hasOwn(values, key))
										.map((key) => `roles.${key}`),
								];
								prefOutput.replaceChildren(
									managementResult(
										await managementWrite(path, "PUT", {
											...(profile.value ? { profile: profile.value } : {}),
											roles: values,
											unset,
										}),
									),
								);
							},
							prefOutput,
						),
						managementControl(
							"Clear workflow preference",
							async () => {
								prefOutput.replaceChildren(
									managementResult(await managementWrite(path, "DELETE")),
								);
							},
							prefOutput,
						),
						commandHint(
							`agent-workflow profile workflow show ${shellArg(workflow.name)}`,
						),
					);
					prefOutput.replaceChildren();
				},
				prefOutput,
				{ write: false },
			),
		);
	}
	if (!workflows.length)
		prefPanel.append(
			element(
				"p",
				{},
				"Add a workflow to .agent-workflow/workflows to save preferences for it.",
			),
		);
	prefPanel.append(prefEditor, prefOutput);
}
async function renderMaintenance(page) {
	const keep = input("Keep newest terminal runs", "50", {
		type: "number",
		min: 0,
		max: 100000,
	});
	const older = input("Older than days (optional)", "", {
		type: "number",
		min: 0,
		max: 36500,
	});
	const output = element("div");
	let preview;
	const params = () => ({
		keep: Number(keep.value),
		...(older.value !== "" ? { olderThanDays: Number(older.value) } : {}),
	});
	const remove = managementControl(
		"Delete previewed data",
		async () => {
			const shown = preview;
			preview = null;
			remove.hidden = true;
			try {
				output.replaceChildren(
					managementResult(
						await managementWrite(projectRoute("prune"), "POST", {
							...shown.params,
							digest: shown.result.digest,
						}),
					),
				);
			} catch (error) {
				// Mismatch never deletes. The new preview is displayed; a fresh Preview is required.
				throw error;
			}
		},
		output,
		{ "data-management-action": "prune-delete" },
	);
	remove.hidden = true;
	const invalidate = () => {
		preview = null;
		remove.hidden = true;
	};
	keep.addEventListener("input", invalidate);
	older.addEventListener("input", invalidate);
	const panel = managementPanel(
		"Prune history",
		element(
			"p",
			{},
			"Preview exactly what will be deleted, including executor attempt state and stale launch claims. Active runs and protected evidence stay. Delete is refused if the preview changes.",
		),
		element(
			"div",
			{ class: "management-fields" },
			field("Keep newest terminal runs", keep),
			field("Older than days (optional)", older),
		),
		managementControl(
			"Preview prune",
			async () => {
				invalidate();
				const selected = params();
				const result = await managementWrite(
					projectRoute("prune/preview"),
					"POST",
					selected,
				);
				preview = { params: selected, result };
				output.replaceChildren(
					managementResult(result),
					element("h3", {}, "Run selection and protections"),
				);
				for (const run of result.data.runs)
					output.append(
						element(
							"p",
							{},
							`${run.runId}: ${run.protected ? "Protected" : run.selected ? "Would delete" : "Kept"} · ${run.status} · ${run.bytes} bytes`,
						),
					);
				remove.hidden = !result.ok;
			},
			output,
			{ "data-management-action": "prune-preview" },
		),
		remove,
		output,
		commandHint(
			"agent-workflow prune --keep <N> [--older-than <days>] [--yes]",
		),
	);
	page.append(panel);
	const notices = await managementApi(projectRoute("notices"));
	const noticeOutput = element("div");
	const noticePanel = managementPanel(
		"Notices",
		element(
			"p",
			{ class: "muted" },
			"Acknowledgements only hide notifications; history and resume authority are unchanged.",
		),
	);
	page.append(noticePanel);
	for (const entry of notices.data.notices || []) {
		const reason = input(`Reason for ${entry.runId}`);
		noticePanel.append(
			element(
				"article",
				{ class: "management-list-row" },
				element("h3", {}, entry.runId),
				element("p", {}, `${entry.status} · ${entry.updatedAt}`),
				field("Reason", reason),
				managementControl(
					"Acknowledge",
					async () => {
						noticeOutput.replaceChildren(
							managementResult(
								await managementWrite(
									projectRoute(
										`notices/${encodeURIComponent(entry.runId)}/acknowledge`,
									),
									"POST",
									{ state: entry.sha256, reason: reason.value },
								),
							),
						);
					},
					noticeOutput,
				),
			),
		);
	}
	for (const entry of notices.data.acknowledgements || [])
		noticePanel.append(
			element(
				"article",
				{ class: "management-list-row" },
				element(
					"p",
					{},
					`${entry.runId} · ${entry.active ? "Acknowledged" : "State changed"} · ${entry.reason}`,
				),
				managementControl(
					"Clear acknowledgement",
					async () => {
						noticeOutput.replaceChildren(
							managementResult(
								await managementWrite(
									projectRoute(
										`notices/${encodeURIComponent(entry.runId)}/clear`,
									),
									"POST",
								),
							),
						);
					},
					noticeOutput,
				),
			),
		);
	if (!(notices.data.notices?.length || notices.data.acknowledgements?.length))
		noticePanel.append(element("p", {}, "No notices or acknowledgements."));
	if (notices.data.warnings?.length)
		noticePanel.append(element("pre", {}, notices.data.warnings.join("\n")));
	noticePanel.append(noticeOutput, commandHint("agent-workflow notices list"));
}
async function renderExecutors(page) {
	const output = element("div");
	const show = async (refresh = false) => {
		const result = await managementApi(
			`/api/doctor${refresh ? "?refresh=1" : ""}`,
		);
		output.replaceChildren(managementResult(result));
	};
	page.append(
		managementPanel(
			"Executor health",
			element(
				"p",
				{ class: "muted" },
				"Cached for 60 seconds. Refresh runs bounded executor probes; it never calls a model.",
			),
			managementControl(
				"Refresh",
				async () => {
					await show(true);
				},
				output,
				{ write: false },
			),
			output,
			commandHint("agent-workflow doctor"),
		),
	);
	await show();
}

start();

/** "1 project · 2 active runs · 1 needs attention" (singular forms for one). */
function overviewSummary(projectCount, running, attention) {
	return `${projectCount} ${projectCount === 1 ? "project" : "projects"} · ${running} active ${running === 1 ? "run" : "runs"} · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
}
