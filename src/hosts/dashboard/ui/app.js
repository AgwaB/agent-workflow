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
	retry: "M13 6a6 6 0 1 0 1 3M8 5v3.2l2 1.2M11 2l3 1-1 3",
	interrupted: "M5.5 5.5h5v5h-5z",
	skipped: "M4 12l8-8",
	td: "M5 2.5h6v3H5zM5 10.5h6v3H5zM8 5.5v5",
	lr: "M1.5 5h4v6h-4zM10.5 5h4v6h-4zM5.5 8h5",
	fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
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
const rejected = (run) =>
	run.statusDetail === "dynamic_approval_rejected" ||
	run.tasks?.some((t) => t.statusDetail === "dynamic_approval_rejected");
// A verdict-gated "failed" run finished its work: Resume would relaunch nothing useful.
const needsResume = (run) =>
	!rejected(run) &&
	!(run.status === "failed" && run.verdictGate) &&
	(["failed", "interrupted"].includes(run.status) ||
		run.tasks?.some((t) =>
			["executor_needs_decision", "dynamic_approval_approved"].includes(
				t.statusDetail,
			),
		));
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
	if (rejected(run))
		return "Stopped by you. The controller was rejected; the run stays blocked until you stop it.";
	if (
		run.pendingApprovals?.length ||
		run.needsYou?.some((n) => n.kind === "approval")
	)
		return `Waiting for you. The controller needs approval before it can ${/mode:\s*graph-splice/.test(run.pendingApprovals?.[0]?.message || "") ? "add stages" : "continue"}.`;
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
		return `Finished ${ago(run.updatedAt, time).replace(/(\d)([mhd])/, "$1 $2")}${run.verdict ? ` with verdict ${verdictWord(run.verdict)}` : ""}.${run.reportAvailable ? " Report is ready." : ""}`;
	if (tasks.some((t) => t.statusDetail === "dynamic_approval_approved"))
		return "Approved by you. Resume separately to run the controller.";
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
		run: params.get("run"),
		task: params.get("task"),
		stage: params.get("stage"),
		tab: choice("tab", ["result", "output", "stderr", "events"]),
		view: choice("view", ["report", "details"]),
		dialog: choice("dialog", ["stop", "resume", "approve", "reject"]),
		layout: choice("layout", ["td", "lr"]) || "td",
	};
}
let state = readState();
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
	const response = await fetch(path, {
		credentials: "same-origin",
		...options,
		signal: options.signal || AbortSignal.timeout(20000),
	});
	const data = await response.json();
	if (!response.ok)
		throw new Error(data.error || `Request failed (${response.status})`);
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
		element("span", { class: "brand row" }, logo(), "agent-workflow"),
		element("span", { class: "muted", "aria-hidden": "true" }, "/"),
		element("span", { class: "project", id: "project" }, session.project.name),
		button(
			[
				element("span", { class: "search-label" }, "⌕  Jump to run, stage…"),
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
	if (summary.status === "completed")
		return `Finished${incomplete(summary) ? " · incomplete" : summary.verdict ? ` · ${verdictWord(summary.verdict)}` : ""}`;
	if (summary.status === "failed" && summary.verdictGate)
		return `Finished · ${summary.verdict ? verdictWord(summary.verdict) : "gate not passed"}`;
	if (summary.status === "failed")
		return summary.needsYou?.[0]?.title || "A task failed";
	if (rejected(summary)) return "Controller rejected";
	if (summary.needsYou?.some((n) => n.kind === "approval"))
		return "Approval required";
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
	const focusedRun = document.activeElement?.closest(".run-row")?.dataset.run;
	const rail = $("rail"),
		scroll = rail.scrollTop;
	const needs = visibleNeeds();
	const hidden = allNeeds().filter(
		(need) => !needs.some((shown) => shown.key === need.key),
	);
	rail.replaceChildren();
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
							element(
								"b",
								{ class: "need-title" },
								need.kind === "approval"
									? "Approve the controller?"
									: need.title,
							),
							element(
								"span",
								{ class: "need-action" },
								need.kind === "approval"
									? "Review approval"
									: "Inspect & resume",
							),
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
							dialog: need.kind === "approval" ? "approve" : "resume",
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
								(!liveRun(display) && incomplete(display))
							? "blocked"
							: summary.status,
				),
				element(
					"span",
					{ class: "grow truncate", title: summary.name },
					summary.name,
				),
			),
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
const incomplete = (run) =>
	Boolean(
		run.verdictGate ||
			(run.verdict &&
				!/^(?:pass(?:ed)?|ok|success|complete(?:d)?)$/i.test(run.verdict)) ||
			run.tasks?.some((t) => t.outcome && t.outcome.tone !== "ok"),
	);
function heroState(run) {
	if (run.status === "failed" && !run.verdictGate) return ["failed", "Failed"];
	if (run.status === "completed" || run.verdictGate)
		return ["completed", "Finished"];
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
				status === "failed" ? "✕" : status === "blocked" ? "!" : done,
			),
		);
	badgeStates.set(run.runId, status);
	return badge;
}
function renderHeader() {
	const [status, title] = heroState(run);
	const actions = element("div", { class: "actions" });
	if (run.pendingApprovals?.length)
		actions.append(actionButton("Review approval…", "approve"));
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
				result && incomplete(run)
					? element("span", { class: "incomplete" }, "Incomplete")
					: null,
			),
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
export function deriveGraph(projection) {
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
		stage.approval = projection.pendingApprovals?.find((a) =>
			stage.tasks.some(
				(t) =>
					[a.controllerSpecId, a.taskId].includes(t.specId) ||
					a.taskId === t.taskId,
			),
		);
		for (const dep of stage.deps) stages.get(dep).kids.add(stage.id);
	}
	for (const stage of [...stages.values()])
		if (stage.kind === "dynamic" && stage.approval && !stage.kids.size) {
			const id = `__after_${stage.id}`;
			stages.set(id, {
				id,
				name: "Generated stages",
				kind: "ghost",
				ghost: true,
				tasks: [],
				items: [],
				status: "pending",
				done: 0,
				deps: new Set([stage.id]),
				kids: new Set(),
				parent: stage,
			});
			stage.kids.add(id);
		}
	const edges = [];
	for (const stage of stages.values())
		for (const dep of stage.deps) {
			const seen = new Set([dep]),
				stack = [...stages.get(dep).kids].filter((id) => id !== stage.id);
			let implied = false;
			while (stack.length) {
				const next = stack.pop();
				if (next === stage.id) {
					implied = true;
					break;
				}
				if (seen.has(next)) continue;
				seen.add(next);
				stack.push(...stages.get(next).kids);
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
			...[...stages.get(id).deps].map((dep) => level(dep) + 1),
		);
		visiting.delete(id);
		levels.set(id, value);
		return value;
	};
	for (const stage of stages.values()) level(stage.id);
	// Stages that share the same inputs and the same outputs are parallel siblings: one stacked
	// card with a row per stage (GitHub Actions stacks such jobs the same way), so a fan-out/join
	// is one card and one edge instead of n×m crossing lines. Foreach, approval and ghost stages
	// keep their own card.
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
	const nodes = new Map(),
		groups = new Map(),
		owner = new Map(),
		buckets = new Map();
	for (const stage of stages.values()) {
		const key =
			stage.kind === "foreach" || stage.approval || stage.ghost
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
	for (const stage of stages.values())
		if (!owner.has(stage.id)) owner.set(stage.id, stage.id);
	// Cards in spec order. A stage that stands alone is its own card; its deps/kids are
	// translated to card ids (a neighbour may now live inside a stacked card). The stage object
	// itself stays untouched.
	for (const stage of stages.values()) {
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
	if (stage.kind === "support" && !stage.approval) return 34;
	if (stage.approval) return 94;
	if (activeAgents(stage))
		return stage.items.length <= 6 ? 55 + stage.items.length * 25 : 76;
	if (stage.status === "pending") return stage.kind === "foreach" ? 54 : 42;
	return stage.kind === "foreach" ? 76 : 58;
}
function stageLine(stage) {
	if (stage.ghost) return "After approval";
	if (stage.approval) return "Awaiting your approval";
	if (stage.kind === "dynamic" && stage.items.length > 1)
		return `${stage.done} of ${stage.items.length} agents done`;
	if (stage.kind === "foreach" && stage.status === "completed") {
		const starts = stage.items.map((t) => date(t.startedAt)).filter(Boolean),
			ends = stage.items.map((t) => date(t.completedAt)).filter(Boolean);
		return starts.length && ends.length
			? `${stage.items.length} agents · ${duration(Math.max(...ends) - Math.min(...starts))}`
			: `${stage.items.length} agents done`;
	}
	return stage.items[0]
		? taskLine(stage.items[0])
		: labels[stage.status] || "Waiting";
}
function chooseStage(stage) {
	if (stage.ghost) return chooseStage(stage.parent);
	if (stage.kind !== "foreach" && stage.items.length === 1)
		go({ task: stage.items[0].specId });
	else if (!stage.items.length && stage.tasks.length === 1)
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
	const viewKey = `${run.runId}:${state.layout}`;
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
		const helpers =
			layer.every((stage) => stage.kind === "support") ||
			model.layers[n + 1]?.every((stage) => stage.kind === "support");
		const gap = horizontal ? 80 : helpers ? 26 : 56,
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
	for (const stage of model.nodes.values()) {
		const p = positions.get(stage.id);
		const group = stage.kind === "group";
		const title = group
			? `${stage.name ? `${stage.name} · ` : ""}${stage.members.length} in parallel`
			: humanize(stage.short || stage.name || stage.id);
		const node = svg("g", {
			class: `node ${stage.status}${stage.ghost ? " ghost" : ""}${stage.kind === "support" ? " support" : ""}${!group && stage.kind !== "foreach" && stage.status === "completed" && stage.items[0]?.outcome?.tone === "warn" ? " outcome-warn" : ""}${group ? " group" : ""}${nextStage(stage) ? " next" : ""}`,
			transform: `translate(${p.x},${p.y})`,
			tabindex: "0",
			role: "button",
			"data-stage": stage.id,
			...(group
				? { "data-members": stage.members.map((s) => s.id).join(",") }
				: {}),
			"aria-label": `${group ? title : stage.name || stage.id}, ${labels[stage.status] || "Waiting"}`,
		});
		node.append(
			svg("rect", { class: "outline", width: p.w, height: p.h, rx: 10 }),
			svg("title", {}, group ? title : stage.name || stage.id),
			markIcon(stage.status, 12, 12),
			svg(
				"text",
				{ x: 36, y: 24, class: "node-name", "data-fit": p.w - 48 },
				title,
			),
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
		} else if (
			(stage.status !== "pending" || stage.ghost) &&
			stage.kind !== "support"
		)
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
						status === "failed"
							? "err"
							: status === "completed"
								? task.outcome?.tone || "ok"
								: "";
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
							"aria-label": `${task.title || task.specId}, ${labels[status] || "Waiting"}${tone === "warn" || tone === "err" ? `, ${task.outcome?.status || tone}` : ""}`,
						},
						svg(
							"title",
							{},
							`${task.title || task.specId} · ${task.outcome?.status || labels[status] || "Waiting"}`,
						),
					),
				);
			});
		} else if (stage.kind === "foreach") {
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
		if (stage.approval) {
			node.append(
				svg("line", { x1: 1, x2: 1, y1: 9, y2: p.h - 9, class: "gate-edge" }),
			);
			const foreign = svg("foreignObject", {
				x: 30,
				y: 54,
				width: p.w - 40,
				height: 32,
			});
			const action = actionButton("Review approval…", "approve");
			action.addEventListener("click", (event) => event.stopPropagation());
			action.addEventListener("keydown", (event) => event.stopPropagation());
			foreign.append(action);
			node.append(foreign);
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
		// SVG presentation attributes keep text >=14px at Fit without inline CSS. Below the Fit
		// floor (an explicit zoom-out) the text shrinks with the boxes instead of spilling over them.
		for (const text of nodes.querySelectorAll("text")) {
			if (text.closest(".morph-old")) continue; // a fading copy keeps its fitted text
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
		if (dragged) {
			view.manual = true;
			view.x = dragged.vx + event.clientX - dragged.x;
			view.y = dragged.vy + event.clientY - dragged.y;
			apply();
		}
	});
	wrap.addEventListener("pointerup", () => {
		dragged = null;
	});
	wrap.addEventListener("pointercancel", () => {
		dragged = null;
	});
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
	function morph(previous) {
		if (reducedMotion()) return;
		requestAnimationFrame(() => {
			if (!wrap.isConnected) return;
			const motion = { duration: 400, easing: "cubic-bezier(.3,0,.2,1)" };
			const parse = (value) => {
				const m =
					/translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(
						value || "",
					);
				return m ? { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) } : null;
			};
			const before = parse(previous.view),
				after = parse(viewport.getAttribute("transform"));
			// Where an old user-space point lands in the new view's user space.
			const map = (x, y) =>
				before && after
					? {
							x: (before.x + before.k * x - after.x) / after.k,
							y: (before.y + before.k * y - after.y) / after.k,
						}
					: { x, y };
			const shift = map(0, 0);
			for (const node of nodes.querySelectorAll(":scope > .node[data-stage]")) {
				const now = positions.get(node.dataset.stage),
					was = previous.nodes.get(node.dataset.stage);
				if (!now) continue;
				if (!was) {
					node.animate(
						[{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }],
						motion,
					);
					continue;
				}
				const from = map(was.x, was.y);
				if (Math.abs(from.x - now.x) > 0.5 || Math.abs(from.y - now.y) > 0.5)
					node.animate(
						[
							{ transform: `translate(${from.x}px, ${from.y}px)` },
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
			const shape = (value) => value?.replace(/[-\d.e]+/g, "#");
			for (const path of edges.querySelectorAll("path.edge[data-edge]")) {
				const was = previous.edges.get(path.dataset.edge),
					d = path.getAttribute("d"),
					link = path.closest(".link");
				const moved = Math.abs(shift.x) > 0.5 || Math.abs(shift.y) > 0.5;
				if (was === d && !moved) continue;
				if (was && shape(was) === shape(d)) {
					// Same path shape: bend from the old path (in the old view) to the new one.
					path.animate(
						[{ d: `path("${was}")` }, { d: `path("${d}")` }],
						motion,
					);
					if (moved && link)
						link.animate(
							[
								{ transform: `translate(${shift.x}px, ${shift.y}px)` },
								{ transform: "translate(0px, 0px)" },
							],
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
			});
	}
	for (const path of canvas.querySelectorAll("path.edge[data-edge]"))
		edges.set(path.dataset.edge, path.getAttribute("d"));
	const view = canvas.querySelector("svg.graph > g")?.getAttribute("transform");
	return { nodes, edges, view };
}
function agentState(task) {
	return taskState(task) === "retry"
		? task.retry?.nextRetryAt
			? `retry in ${countdown(task.retry.nextRetryAt)}`
			: "waiting to retry"
		: task.status === "completed"
			? "done"
			: (labels[task.status] || "Waiting").toLowerCase();
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
function graphSignature(model, layout) {
	return JSON.stringify([
		layout,
		[...model.nodes.values()].map((node) => [
			node.id,
			node.status,
			nextStage(node),
			nodeHeight(node),
			node.done,
			node.items[0]?.outcome?.tone,
			node.approval?.requestId ?? null,
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
	graphModel = deriveGraph(run);
	const signature = graphSignature(graphModel, state.layout);
	const canvas = $("canvas");
	const keepGraph =
		canvas &&
		graphControl?.signature === signature &&
		graphControl.runId === run.runId;
	const banner = run.pendingApprovals?.length
		? element(
				"div",
				{ class: "approval-banner" },
				glyph("blocked"),
				`${run.pendingApprovals.length} approval${run.pendingApprovals.length === 1 ? " is" : "s are"} required before this run can continue`,
				actionButton("Review approval…", "approve"),
			)
		: null;
	if (keepGraph) {
		// The canvas stays in place (removing and re-adding it would restart its animations).
		for (const child of [...$("center").children])
			if (child !== canvas) child.remove();
		$("center").prepend(renderHeader(), ...(banner ? [banner] : []));
		refreshGraphTexts();
	} else {
		// A status change that reshapes the graph (a card collapses, rows appear) moves the cards
		// from where they were instead of jumping: remember the drawn boxes before replacing them.
		const previous =
			canvas && graphControl?.runId === run.runId ? graphGeometry() : null;
		$("center").replaceChildren(renderHeader(), ...(banner ? [banner] : []));
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
function renderSelection() {
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
	inspector.dataset.key = key;
	inspector.hidden = !visible;
	$("body").classList.toggle("inspecting", visible);
	for (const node of document.querySelectorAll(".node"))
		node.classList.toggle(
			"selected",
			node.dataset.stage === selectedStage() ||
				(node.dataset.members?.split(",") ?? []).includes(selectedStage()),
		);
	for (const row of document.querySelectorAll(".stage-row"))
		row.classList.toggle("selected", row.dataset.stage === selectedStage());
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
	} else if (task) {
		const status = taskState(task);
		const name =
			task.kind === "foreach"
				? task.specId.slice(task.stageId.length + 1)
				: task.specId;
		const reasons = {
			executor_needs_decision:
				"The executor could not confirm whether the earlier attempt ran; review before resuming.",
			dynamic_approval_rejected:
				"The controller will not run or be asked again. This run stays blocked; you can stop it.",
			dynamic_approval_approved:
				"Approval recorded. Resume separately to run the controller and continue.",
		};
		const reason =
			task.retry?.reason ||
			reasons[task.statusDetail] ||
			(status === "failed"
				? task.lastMessage || "A task failed. Inspect the logs before resuming."
				: null);
		inspector.append(
			inspectorHeader(task.title || name, status, [
				taskAnnotation(task),
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
		const approval = run.pendingApprovals?.find(
			(a) =>
				[a.controllerSpecId, a.taskId].includes(task.specId) ||
				a.taskId === task.taskId,
		);
		if (approval)
			inspector.append(
				element(
					"div",
					{ class: "details-section" },
					actionButton("Review approval…", "approve"),
				),
			);
		else if (reasons[task.statusDetail])
			inspector.append(
				element(
					"div",
					{ class: "details-section" },
					actionButton(
						rejected(run) ? "Stop run…" : "Review & resume…",
						rejected(run) ? "stop" : "resume",
					),
				),
			);
		const tab = state.tab || defaultTaskTab(task);
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
					class: "output",
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
	if (!task) {
		logController?.abort();
		logGeneration++;
		logKey = "";
		logLoading = false;
		resultController?.abort();
		resultGeneration++;
		resultKey = "";
		resultLoading = false;
	}
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
function renderItems(inspector, stage, previous = new Map()) {
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
		const query = filter.query.toLowerCase();
		const matches = stage.items.filter(
			(task) =>
				`${task.specId} ${task.title || ""}`.toLowerCase().includes(query) &&
				(filter.status === "all" || taskState(task) === filter.status),
		);
		list.replaceChildren();
		for (const [group, title] of [
			["running", "Running"],
			["look", "Needs a look"],
			["waiting", "Waiting"],
			["done", "Done"],
		]) {
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
				const annotation = group === "done" ? null : taskAnnotation(task);
				const content = element(
					"span",
					{ class: "agent-content" },
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
				list.append(
					button(content, () => go({ task: task.specId }), {
						class: `agent-item ${status}`,
						"data-item": task.specId,
						"data-row-group": group,
						title: `${task.title || task.specId} · ${taskLine(task)}${task.outcome?.text ? ` · ${task.outcome.text}` : ""}`,
						"aria-label": `${task.title || task.specId} · ${taskLine(task)}`,
					}),
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
						{ duration: 260, easing: "ease-out" },
					);
				else if (nudge)
					row.firstElementChild.animate(
						[
							{ transform: `translateY(${nudge}px)` },
							{ transform: "translateY(0)" },
						],
						{ duration: 200, easing: "ease-out" },
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
	const kind = state.dialog,
		approval =
			run.pendingApprovals?.find(
				(a) =>
					[a.controllerSpecId, a.taskId].includes(selectedTask()?.specId) ||
					a.taskId === selectedTask()?.taskId,
			) || run.pendingApprovals?.[0];
	if (
		((kind === "approve" || kind === "reject") && !approval) ||
		(kind === "stop" && !liveRun(run)) ||
		(kind === "resume" && !needsResume(run))
	) {
		state.dialog = null;
		urlState(true);
		if (modalKey) dismissDialog(false);
		return;
	}
	const key = `${run.runId}:${kind}:${approval?.requestId || ""}`;
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
	} else {
		title =
			kind === "approve"
				? approval.title || "Run dynamic workflow controller?"
				: "Reject dynamic controller?";
		confirm = kind === "approve" ? "Approve" : "Reject";
		content = [
			element(
				"p",
				{ class: "muted" },
				`${approval.controllerSpecId} in ${run.name}`,
			),
			element("pre", { class: "scope" }, approval.message),
			element(
				"p",
				{},
				kind === "reject"
					? "The controller will not run for this run and will not be asked again. The run STAYS BLOCKED. You can stop it; nothing resumes automatically. Completed work is kept."
					: run.tasks.some(
								(t) =>
									["failed", "interrupted"].includes(t.status) ||
									t.statusDetail === "executor_needs_decision",
							)
						? "Only the approval decision is recorded. Resume separately: this run also has failed, interrupted or needs-decision tasks. Completed tasks are not relaunched."
						: "Approving runs the controller and then resumes the run. Completed tasks are not relaunched.",
			),
		];
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
			kind === "approve"
				? button("Reject…", () => go({ dialog: "reject" }), {
						disabled: readonly() || busy,
						"data-mutation": "true",
					})
				: null,
			button("Cancel", () => dismissDialog(), { "data-cancel": "true" }),
			button(confirm, () => mutate(runId, kind, approval), {
				id: "confirm-action",
				class: "primary",
				disabled: readonly() || busy,
				"data-mutation": "true",
			}),
		),
	]);
}
async function mutate(runId, kind, approval) {
	if (readonly() || busy) return;
	busy = true;
	const actionModal = modalKey;
	renderModal();
	const action = kind === "reject" ? "approve" : kind;
	try {
		const result = await api(
			`/api/runs/${encodeURIComponent(runId)}/${action}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AW-CSRF": session.csrf,
				},
				body: JSON.stringify(
					action === "approve"
						? { requestId: approval.requestId, decision: kind }
						: {},
				),
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
 * Untrusted Markdown as text nodes: headings, bullet lists, pipe tables, paragraphs, inline
 * `**bold**` / `` `code` ``. No links, HTML, images or content-derived URLs (report and task result).
 */
function renderTextMarkdown(container, text) {
	let list = null;
	// Deliberately text-only: no Markdown links, HTML, images or content-derived URLs. Inline
	// `**bold**` / `*emphasis*` / `` `code` `` become <strong>/<em>/<code> text nodes; blank lines
	// only end a block.
	const inline = (text) => {
		const nodes = [];
		const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*)/g;
		let last = 0;
		for (const m of text.matchAll(re)) {
			if (m.index > last) nodes.push(text.slice(last, m.index));
			nodes.push(
				m[2] !== undefined
					? element("strong", {}, m[2])
					: m[3] !== undefined
						? element("code", {}, m[3])
						: element("em", {}, m[4]),
			);
			last = m.index + m[0].length;
		}
		if (last < text.length) nodes.push(text.slice(last));
		return nodes;
	};
	let paragraph = null;
	let table = null;
	for (const line of text.split("\n")) {
		const heading = /^#{1,6}\s+(.+)$/.exec(line),
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
				element("tr", {}, ...cells.map((c) => element(tag, {}, ...inline(c)))),
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
			container.append(element("h3", {}, ...inline(heading[1])));
		} else if (item || numbered) {
			paragraph = null;
			const tag = item ? "ul" : "ol";
			if (!list || list.tagName.toLowerCase() !== tag) {
				list = element(tag);
				container.append(list);
			}
			list.append(element("li", {}, ...inline((item ?? numbered)[1])));
		} else if (!line.trim()) {
			list = null;
			paragraph = null;
		} else {
			list = null;
			if (!paragraph) {
				paragraph = element("p");
				container.append(paragraph);
			} else paragraph.append(" ");
			append(paragraph, inline(line));
		}
	}
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
	try {
		const data = await api(`/api/runs/${encodeURIComponent(id)}/report`);
		if (generation !== reportGeneration || modalKey !== `report:${id}`) return;
		body.replaceChildren();
		renderTextMarkdown(body, data.text);
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
			"Amber marks approvals and executor decisions. Red marks failures.",
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
		`/api/events${id ? `?run=${encodeURIComponent(id)}` : ""}`,
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
	$("body").classList.remove("inspecting");
	$("center").replaceChildren(element("p", { class: "empty" }, "Loading run…"));
	connection = "Reconnecting";
	lastEvent = 0;
	updateConnection();
	renderRail();
	const generation = loadGeneration;
	try {
		await refreshRun();
	} catch (error) {
		if (generation !== loadGeneration || error.name === "AbortError") return;
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
		closeInspector();
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
	if (event.persisted && session) loadRun();
});
async function start() {
	try {
		session = await api("/api/session");
		syncClock(session.serverTime);
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
start();
