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
	blocked:
		"M5 8V4.2a1 1 0 0 1 2 0V7.5M7 7V3.2a1 1 0 0 1 2 0V7M9 7V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4.5-4 4.5-1.7 0-2.6-.8-3.5-2.2L2.3 9.6a1 1 0 0 1 1.6-1.1L5 9.6",
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
	return svg(
		"svg",
		{ width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": "true" },
		svg("rect", { x: 1, y: 1, width: 18, height: 18, rx: 5, fill: "#eeeff2" }),
		svg("path", {
			d: "M6.5 6.5l7 3.5-7 3.5",
			fill: "none",
			stroke: "#0b0c0f",
			"stroke-width": 1.4,
		}),
		svg("circle", { cx: 6.5, cy: 6.5, r: 2, fill: "#0b0c0f" }),
		svg("circle", { cx: 6.5, cy: 13.5, r: 2, fill: "#0b0c0f" }),
		svg("circle", { cx: 13.5, cy: 10, r: 2, fill: "#6ee7b7" }),
	);
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
		return `Finished ${ago(run.updatedAt, time).replace(/(\d)([mhd])/, "$1 $2")} with verdict ${run.verdict || "not passed"}. The final gate did not pass; the report explains why.${run.reportAvailable ? " Report is ready." : ""}`;
	if (run.status === "failed")
		return failed
			? `Stopped at ${failed.stageId}. ${/contract/.test(failed.statusDetail || "") ? "Output didn't match the contract." : "A task failed."} Inspect and resume when ready.`
			: "A task failed. Inspect and resume when ready.";
	if (run.status === "completed")
		return `Finished ${ago(run.updatedAt, time).replace(/(\d)([mhd])/, "$1 $2")}${run.verdict ? ` with verdict ${run.verdict}` : ""}.${run.reportAvailable ? " Report is ready." : ""}`;
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
		tab: choice("tab", ["output", "stderr", "events"]),
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
	const needs = runs.reduce((n, r) => n + (r.needsYou?.length || 0), 0);
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
			[glyph("blocked"), `Needs you  ${needs}`],
			() => {
				$("rail").querySelector(".need")?.focus();
			},
			{ class: "needs-button" },
		),
		readonly()
			? element("span", { class: "badge", id: "readonly-badge" }, "Read-only")
			: null,
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
function railLine(summary) {
	if (summary.status === "completed")
		return `Finished${summary.verdict ? ` · ${summary.verdict}` : ""}`;
	if (summary.status === "failed" && summary.verdictGate)
		return `Finished · ${summary.verdict || "gate not passed"}`;
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
function progress(completed, total) {
	return element("progress", {
		max: Math.max(1, total || 0),
		value: completed || 0,
		"aria-label": `${completed || 0} of ${total || 0} tasks complete`,
	});
}
function renderRail() {
	const focusedRun = document.activeElement?.closest(".run-row")?.dataset.run;
	const rail = $("rail"),
		scroll = rail.scrollTop;
	const needs = runs.flatMap((r) =>
		(r.needsYou || []).map((n) => ({ ...n, run: r })),
	);
	rail.replaceChildren();
	if (needs.length)
		rail.append(element("h2", { class: "rail-heading" }, "Needs you"));
	for (const need of needs)
		rail.append(
			button(
				[
					glyph(need.kind === "failed" ? "failed" : "blocked"),
					element(
						"span",
						{ class: "grow" },
						element(
							"b",
							{ class: "need-title" },
							need.kind === "approval" ? "Approve the controller?" : need.title,
						),
						element(
							"span",
							{ class: "need-action" },
							need.kind === "approval" ? "Review approval" : "Inspect & resume",
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
		);
	rail.append(element("h2", { class: "rail-heading muted" }, "Runs"));
	if (!runs.length)
		rail.append(element("p", { class: "muted" }, "No runs yet"));
	for (const summary of runs) {
		const counts = summary.taskSummary;
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
				glyph(summary.status),
				element(
					"span",
					{ class: "grow truncate", title: summary.name },
					summary.name,
				),
				element(
					"span",
					{ class: "elapsed muted", "data-run-elapsed": summary.runId },
					elapsed(summary),
				),
			),
			element(
				"div",
				{ class: "row run-progress" },
				progress(counts.completed, counts.total),
				element("span", {}, `${counts.completed} / ${counts.total}`),
			),
			element(
				"div",
				{ class: "run-line" },
				element("span", { class: "grow" }, railLine(summary)),
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
function renderHeader() {
	const actions = element("div", { class: "actions" });
	if (run.pendingApprovals?.length)
		actions.append(actionButton("Review approval…", "approve"));
	if (liveRun(run))
		actions.append(
			actionButton(
				stoppingRuns.has(run.runId) ? "Stopping…" : "□  Stop…",
				"stop",
			),
		);
	if (needsResume(run))
		actions.append(actionButton("Resume…", "resume", "primary"));
	actions.append(
		button(
			"Run details  ›",
			() => go({ view: "details", task: null, stage: null }),
			{ "aria-label": "Run details" },
		),
	);
	return element(
		"section",
		{ class: "run-header", id: "run-header" },
		element(
			"div",
			{ class: "row title-row" },
			element("h1", {}, run.name),
			element(
				"span",
				{ class: "badge row" },
				glyph(run.status),
				run.status === "failed" && run.verdictGate
					? `Finished · ${run.verdict || "gate not passed"}`
					: labels[run.status] || "Waiting",
			),
			actions,
		),
		element("p", { class: "sentence", id: "status-sentence" }, sentenceParts()),
		element(
			"div",
			{ class: "stat" },
			element(
				"strong",
				{ class: "headline-count", id: "task-count" },
				`${run.taskSummary.completed} / ${run.taskSummary.total}`,
			),
			"tasks complete",
			element(
				"span",
				{ class: "elapsed", id: "elapsed" },
				`Elapsed ${elapsed(run)}`,
			),
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
		if (!task.placeholder) stage.items.push(task);
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
		const states = (stage.items.length ? stage.items : stage.tasks).map(
			taskState,
		);
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
	const layers = [];
	for (const stage of stages.values()) {
		const n = level(stage.id);
		(layers[n] ||= []).push(stage);
	}
	return { stages, layers: layers.filter(Boolean), edges };
}
const activeAgents = (stage) =>
	stage.kind === "foreach" &&
	["running", "retry", "failed", "blocked"].includes(stage.status) &&
	stage.items.length;
function nodeHeight(stage) {
	if (stage.ghost) return 58;
	if (stage.approval) return 94;
	if (activeAgents(stage))
		return stage.items.length <= 6 ? 55 + stage.items.length * 25 : 104;
	if (stage.status === "pending") return stage.kind === "foreach" ? 54 : 42;
	return stage.kind === "foreach" ? 76 : 58;
}
function stageLine(stage) {
	if (stage.ghost) return "After approval";
	if (stage.approval) return "Awaiting your approval";
	if (stage.kind === "foreach" && stage.status === "completed") {
		const starts = stage.items.map((t) => date(t.startedAt)).filter(Boolean),
			ends = stage.items.map((t) => date(t.completedAt)).filter(Boolean);
		return starts.length && ends.length
			? `Done · ${duration(Math.max(...ends) - Math.min(...starts))}`
			: "Done";
	}
	return stage.items[0]
		? taskLine(stage.items[0])
		: labels[stage.status] || "Waiting";
}
function chooseStage(stage) {
	if (stage.ghost) return chooseStage(stage.parent);
	if (stage.kind !== "foreach" && stage.items.length === 1)
		go({ task: stage.items[0].specId });
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
		const dep = graphModel.stages.get(id);
		return settledStage(dep) || activeStage(dep);
	});
/** How an edge reads: where work has been (done), is (active/blocked), goes next, or later. */
function edgeState(from, to) {
	if (to.status === "failed") return "failed";
	if (to.status === "blocked") return "blocked";
	if (activeStage(to)) return "active";
	if (settledStage(to) || to.status === "interrupted") return "done";
	return settledStage(from) || activeStage(from) ? "next" : "later";
}
function renderGraph() {
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
	const defs = svg("defs");
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
	const width = model.layers.some((layer) => layer.length > 2) ? 340 : 440;
	let axis = 0;
	for (const layer of model.layers) {
		const total = horizontal
			? layer.reduce((sum, stage) => sum + nodeHeight(stage), 0) +
				(layer.length - 1) * 14
			: layer.length * width + (layer.length - 1) * 18;
		let side = -total / 2;
		const height = Math.max(...layer.map(nodeHeight));
		for (const stage of layer) {
			positions.set(stage.id, {
				x: horizontal ? axis : side,
				y: horizontal ? side : axis + (height - nodeHeight(stage)) / 2,
				w: width,
				h: nodeHeight(stage),
			});
			side += horizontal ? nodeHeight(stage) + 14 : width + 18;
		}
		// Room between layers so the edges and their arrowheads read as a path, not a seam.
		axis += horizontal ? width + 72 : height + 48;
	}
	for (const edge of model.edges) {
		const a = positions.get(edge.from),
			b = positions.get(edge.to);
		const x1 = horizontal ? a.x + a.w : a.x + a.w / 2,
			y1 = horizontal ? a.y + a.h / 2 : a.y + a.h;
		const x2 = horizontal ? b.x : b.x + b.w / 2,
			y2 = horizontal ? b.y + b.h / 2 : b.y;
		const d = horizontal
			? `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`
			: `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
		const state = edgeState(
			model.stages.get(edge.from),
			model.stages.get(edge.to),
		);
		edges.append(
			svg("path", {
				class: `edge ${state}`,
				d,
				"marker-end": `url(#arrow-${state})`,
				"data-edge": `${edge.from}>${edge.to}`,
			}),
		);
	}
	const priority = {
		running: 0,
		retry: 1,
		failed: 2,
		blocked: 3,
		completed: 4,
	};
	for (const stage of model.stages.values()) {
		const p = positions.get(stage.id);
		const node = svg("g", {
			class: `node ${stage.status}${stage.ghost ? " ghost" : ""}${nextStage(stage) ? " next" : ""}`,
			transform: `translate(${p.x},${p.y})`,
			tabindex: "0",
			role: "button",
			"data-stage": stage.id,
			"aria-label": `${stage.name || stage.id}, ${labels[stage.status] || "Waiting"}`,
		});
		node.append(
			svg("rect", { class: "outline", width: p.w, height: p.h, rx: 10 }),
			svg("title", {}, stage.name || stage.id),
			markIcon(stage.status, 12, 12),
			svg(
				"text",
				{ x: 36, y: 24, class: "node-name", "data-fit": p.w - 48 },
				stage.name || stage.id,
			),
		);
		node.addEventListener("click", () => chooseStage(stage));
		node.addEventListener("keydown", (event) => {
			if (["Enter", " "].includes(event.key)) {
				event.preventDefault();
				event.stopPropagation();
				chooseStage(stage);
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
					`${count("running")} running · ${count("retry")} retry · ${count("failed")} failed`,
				),
				svg(
					"text",
					{ x: 36, y: 72, class: "agent-summary" },
					`${stage.items.length} agents · inspect items`,
				),
			);
		} else if (stage.status !== "pending" || stage.ghost)
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
		if (stage.kind === "foreach") {
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
		for (const stage of model.stages.values()) {
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
	function reveal(id, focus = false) {
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
					[...model.stages.values()].find((s) =>
						["running", "retry", "blocked", "failed"].includes(s.status),
					)?.id ||
					[...model.stages.keys()].at(-1);
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
	requestAnimationFrame(() => {
		if (wrap.isConnected) {
			resize();
			observer.observe(wrap);
		}
	});
	graphControl = { destroy: () => observer.disconnect(), fit, reveal };
	return wrap;
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
function renderRun() {
	const active = document.activeElement;
	const focusStage = active?.closest(".node")?.dataset.stage,
		focusTask = active?.closest(".agent-row")?.dataset.task;
	graphModel = deriveGraph(run);
	$("center").replaceChildren(renderHeader());
	if (run.pendingApprovals?.length)
		$("center").append(
			element(
				"div",
				{ class: "approval-banner" },
				glyph("blocked"),
				`${run.pendingApprovals.length} approval${run.pendingApprovals.length === 1 ? " is" : "s are"} required before this run can continue`,
				actionButton("Review approval…", "approve"),
			),
		);
	$("center").append(renderGraph());
	renderSelection();
	renderModal();
	if (focusTask)
		document
			.querySelector(`[data-task="${CSS.escape(focusTask)}"]`)
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
		node.classList.toggle("selected", node.dataset.stage === selectedStage());
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
			inspectorHeader(name, status, [
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
						task.model || "No model",
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
		const tab =
			state.tab ||
			(status === "retry" || status === "failed" ? "stderr" : "output");
		inspector.append(
			element(
				"div",
				{ class: "tabs", role: "tablist", "aria-label": "Task logs" },
				["output", "stderr", "events"].map((stream) =>
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
									const tabs = ["output", "stderr", "events"];
									go({
										tab: tabs[
											(tabs.indexOf(stream) +
												(event.key === "ArrowRight" ? 1 : 2)) %
												3
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
				element("pre", { class: "log", id: "log-text", tabindex: "0" }),
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
		paintLogs();
	} else if (stage) renderItems(inspector, stage, same);
	if (!task) {
		logController?.abort();
		logGeneration++;
		logKey = "";
		logLoading = false;
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
	if (focusedTab)
		document
			.querySelector(`[data-tab="${CSS.escape(focusedTab)}"]`)
			?.focus({ preventScroll: true });
}
const itemFilters = new Map();
function renderItems(inspector, stage) {
	inspector.append(
		inspectorHeader(stage.id, stage.status),
		element(
			"p",
			{ class: "details-section" },
			`${labels[stage.status] || "Waiting"} · ${stage.done} / ${stage.items.length} done`,
		),
	);
	const key = `${run.runId}:${stage.id}`,
		filter = itemFilters.get(key) || {
			query: "",
			status: "all",
			view: stage.items.length > 6 ? "grid" : "table",
		};
	const input = element("input", {
		type: "search",
		placeholder: `Filter ${stage.items.length} items…`,
		"aria-label": "Find an agent",
		value: filter.query,
	});
	const filters = element("div", {
		class: "item-filters",
		"aria-label": "Filter agents by status",
	});
	const modes = element("div", {
		class: "items-mode",
		role: "group",
		"aria-label": "Agent view",
	});
	const list = element("div", { class: "item-list", "aria-label": "Agents" });
	function paint() {
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
				if (!count && status !== "all") return [];
				return [
					button(
						[
							status === "all" ? null : glyph(status),
							status === "all"
								? `All ${count}`
								: `${count} ${status === "retry" ? "auto-retry" : (labels[status] || "Waiting").toLowerCase()}`,
						],
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
		modes.replaceChildren(
			...["grid", "table"].map((view) =>
				button(
					view === "grid" ? "Grid" : "Table",
					() => {
						filter.view = view;
						paint();
						modes.querySelector(`[data-mode="${view}"]`)?.focus();
					},
					{ "data-mode": view, "aria-pressed": String(filter.view === view) },
				),
			),
		);
		const matches = stage.items.filter(
			(task) =>
				task.specId.toLowerCase().includes(filter.query.toLowerCase()) &&
				(filter.status === "all" || taskState(task) === filter.status),
		);
		list.classList.toggle("item-grid", filter.view === "grid");
		list.replaceChildren(
			...matches.map((task) =>
				button(
					filter.view === "grid"
						? glyph(taskState(task))
						: [
								element(
									"span",
									{},
									glyph(taskState(task)),
									task.specId.slice(stage.id.length + 1),
								),
								element("span", { class: "item-state" }, taskLine(task)),
							],
					() => go({ task: task.specId }),
					{
						"data-item": task.specId,
						title: `${task.specId} · ${taskLine(task)}`,
						"aria-label": `${task.specId} · ${taskLine(task)}`,
					},
				),
			),
		);
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
	}
	input.addEventListener("input", paint);
	inspector.append(
		element(
			"div",
			{ class: "items-progress" },
			progress(stage.done, stage.items.length),
		),
		filters,
		modes,
		element("div", { class: "items-tools" }, input),
		list,
	);
	paint();
}
function logText(tab) {
	const stream = logData?.streams?.find((s) => s.kind === tab);
	return stream?.lines?.join("\n") || "";
}
function paintLogs() {
	if (!$("log-text")) return;
	const task = selectedTask(),
		tab =
			state.tab ||
			(["retry", "failed"].includes(taskState(task)) ? "stderr" : "output");
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
		let list = null;
		// Deliberately text-only: no Markdown links, HTML, images or content-derived URLs. Inline
		// `**bold**` / `` `code` `` become <strong>/<code> text nodes; blank lines only end a block.
		const inline = (text) => {
			const nodes = [];
			const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
			let last = 0;
			for (const m of text.matchAll(re)) {
				if (m.index > last) nodes.push(text.slice(last, m.index));
				nodes.push(
					m[2] !== undefined
						? element("strong", {}, m[2])
						: element("code", {}, m[3]),
				);
				last = m.index + m[0].length;
			}
			if (last < text.length) nodes.push(text.slice(last));
			return nodes;
		};
		let paragraph = null;
		let table = null;
		for (const line of data.text.split("\n")) {
			const heading = /^#{1,6}\s+(.+)$/.exec(line),
				item = /^\s*[-*+]\s+(.+)$/.exec(line),
				row = /^\s*\|(.+)\|\s*$/.exec(line);
			if (row) {
				// Pipe tables: a separator row (|---|:--:|) is skipped; cells are text nodes.
				list = null;
				paragraph = null;
				const cells = row[1].split("|").map((c) => c.trim());
				if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
				if (!table) {
					table = element("table", { class: "report-table" });
					body.append(table);
				}
				const tag = table.childElementCount === 0 ? "th" : "td";
				table.append(
					element(
						"tr",
						{},
						...cells.map((c) => element(tag, {}, ...inline(c))),
					),
				);
				continue;
			}
			table = null;
			if (heading) {
				list = null;
				paragraph = null;
				body.append(element("h3", {}, ...inline(heading[1])));
			} else if (item) {
				paragraph = null;
				if (!list) {
					list = element("ul");
					body.append(list);
				}
				list.append(element("li", {}, ...inline(item[1])));
			} else if (!line.trim()) {
				list = null;
				paragraph = null;
			} else {
				list = null;
				if (!paragraph) {
					paragraph = element("p");
					body.append(paragraph);
				} else paragraph.append(" ");
				append(paragraph, inline(line));
			}
		}
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
		element("h3", {}, "Arrows"),
		...[
			["active", "Work is flowing into this stage now"],
			["next", "Where work goes next (dashed outline: the next stage)"],
			["done", "Already travelled"],
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
	runRevision++;
	run = data;
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
	for (const node of document.querySelectorAll("[data-stage-line]")) {
		const stage = graphModel?.stages.get(node.dataset.stageLine);
		if (stage && ["running", "retry"].includes(stage.status)) {
			const text = stageLine(stage);
			node.dataset.full = text;
			if (node.firstElementChild) node.firstElementChild.textContent = text;
		}
	}
	if ($("status-sentence"))
		$("status-sentence").replaceChildren(...sentenceParts());
	if ($("elapsed")) $("elapsed").textContent = `Elapsed ${elapsed(run)}`;
	const task = selectedTask();
	if (task && $("task-status")) $("task-status").textContent = taskLine(task);
	for (const node of document.querySelectorAll("[data-agent-state]")) {
		const task = run.tasks.find((t) => t.specId === node.dataset.agentState);
		if (task) {
			const text = agentState(task);
			node.dataset.full = text;
			if (node.firstElementChild) node.firstElementChild.textContent = text;
			else node.textContent = text;
		}
	}
}, 1000);
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
