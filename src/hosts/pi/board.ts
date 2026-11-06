// The TUI-only /aw board navigates runs, stages, tasks, details, and launch commands.
// Every read and action goes through the host API. Stop, resume, and approval decisions
// require confirmation. Refresh every two seconds; other modes use text commands.
import type { LogsTask, RunSummary } from "../api.js";
import {
	type BoardTask,
	elapsedText,
	formatTokenCount,
	progressBar,
	shortModel,
	sortTasks,
	stageGroups,
	statusColor,
	statusForSummary,
	statusGlyph,
	statusLabel,
	summarizeTasks,
	taskElapsed,
	taskRuntime,
	timestampText,
} from "./board-format.js";
import type { AwBoardSource, BoardRunDetail } from "./board-source.js";
import type { PiExtensionContext } from "./pi-types.js";
import {
	accent,
	boxed,
	type Component,
	chip,
	clampIndex,
	errorText,
	escapeForDisplay,
	fg,
	fit,
	isCloseInput,
	isEnter,
	isKey,
	joinColumns,
	joinFixedColumns,
	kvRow,
	matchesKey,
	metaLine,
	muted,
	navHint,
	padAnsi,
	safeLine,
	selectedLine,
	strong,
	type Theme,
	type Tui,
	visibleWindow,
	warning,
	wrapByWidth,
	wrapIndex,
} from "./tui-kit.js";

export const BOARD_REFRESH_MS = 2_000;
const MAX_LIST_ROWS = 18;
const LOG_VIEW_LINES = 16;
const LAUNCH_VIEW_LINES = 18;
const LOG_STREAMS = ["output", "stderr", "events"] as const;
type LogStreamKind = (typeof LOG_STREAMS)[number];
type ViewMode = "runs" | "stages" | "tasks" | "task";
type Prompt = { kind: "stop" | "resume"; runId: string; label: string };

const RESUMABLE = new Set(["failed", "interrupted", "blocked"]);

export interface AwBoardOptions {
	initialRunId?: string;
	/** Refresh interval; 0 disables the timer (tests). */
	refreshMs?: number;
	now?: () => number;
}

export class AwBoard implements Component {
	mode: ViewMode = "runs";
	runs: RunSummary[] = [];
	detail: BoardRunDetail | undefined;
	logs: LogsTask | undefined;
	message = "";
	error = "";
	prompt: Prompt | undefined;
	launchOpen = false;
	busy = false;
	private selectedRun = 0;
	private selectedStage = 0;
	private selectedTask = 0;
	private selectedTaskId = "";
	private logStream: LogStreamKind = "output";
	private logScroll = 0;
	private launchScroll = 0;
	private loading = true;
	private initialPending: string | undefined;
	private reloadActive = false;
	private reloadQueued = false;
	private generation = 0;
	private closed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly now: () => number;

	constructor(
		private readonly source: AwBoardSource,
		private readonly tui: Tui,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly options: AwBoardOptions = {},
	) {
		this.initialPending = options.initialRunId;
		this.now = options.now ?? Date.now;
	}

	start(): Promise<void> {
		const first = this.reload();
		const every = this.options.refreshMs ?? BOARD_REFRESH_MS;
		if (every > 0) {
			this.timer = setInterval(() => void this.reload(), every);
			this.timer.unref?.();
		}
		return first;
	}

	dispose(): void {
		this.closed = true;
		this.generation += 1;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	private render_(): void {
		if (!this.closed) this.tui.requestRender();
	}

	close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
		// A tall custom panel is replaced by the editor: repaint fully.
		this.tui.requestRender(true);
	}

	// --- input ------------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.prompt) {
			this.handlePromptInput(data);
			return;
		}
		if (isCloseInput(data)) {
			this.close();
			return;
		}
		if (this.launchOpen) {
			this.handleLaunchInput(data);
			return;
		}
		if (isKey(data, "r")) {
			this.message = "refreshing";
			void this.reload().then(() => {
				if (this.message === "refreshing") this.message = "refreshed";
				this.render_();
			});
			this.render_();
			return;
		}
		if (isKey(data, "v") && this.mode !== "task") {
			this.openLaunch();
			return;
		}
		if (isKey(data, "c") && this.mode !== "task") {
			void this.copyLaunch();
			return;
		}
		if (isKey(data, "s")) return this.ask("stop");
		if (isKey(data, "u")) return this.ask("resume");
		if (this.mode === "task") this.handleTaskInput(data);
		else this.handleBoardInput(data);
	}

	private handleBoardInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			isKey(data, "b") ||
			matchesKey(data, "backspace") ||
			matchesKey(data, "left") ||
			isKey(data, "h")
		)
			return this.drillUp();
		if (matchesKey(data, "right") || isKey(data, "l") || isEnter(data))
			return this.drillDown();
		if (
			matchesKey(data, "up") ||
			isKey(data, "k") ||
			data === "[" ||
			isKey(data, "p")
		)
			return this.move(-1);
		if (
			matchesKey(data, "down") ||
			isKey(data, "j") ||
			data === "]" ||
			isKey(data, "n")
		)
			return this.move(1);
	}

	private handleTaskInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			isKey(data, "b") ||
			matchesKey(data, "backspace")
		)
			return this.drillUp();
		if (matchesKey(data, "left")) return this.switchStream(-1);
		if (matchesKey(data, "right")) return this.switchStream(1);
		if (matchesKey(data, "up")) return this.scrollLogs(-1);
		if (matchesKey(data, "down")) return this.scrollLogs(1);
		if (data === "[" || isKey(data, "p")) return this.moveTask(-1);
		if (data === "]" || isKey(data, "n")) return this.moveTask(1);
	}

	private handleLaunchInput(data: string): void {
		if (matchesKey(data, "escape") || isKey(data, "b")) {
			this.launchOpen = false;
			this.message = "";
		} else if (matchesKey(data, "up"))
			this.launchScroll = Math.max(0, this.launchScroll - 1);
		else if (matchesKey(data, "down")) this.launchScroll += 1;
		else if (isKey(data, "c")) void this.copyLaunch();
		this.render_();
	}

	private handlePromptInput(data: string): void {
		const prompt = this.prompt!;
		if (matchesKey(data, "escape") || isKey(data, "q")) {
			this.prompt = undefined;
			this.message = "cancelled";
			this.render_();
			return;
		}
		if (isKey(data, "y")) {
			this.prompt = undefined;
			void this.perform(prompt);
			return;
		}
		if (isKey(data, "n")) {
			this.prompt = undefined;
			this.message = "cancelled";
			this.render_();
		}
	}

	// --- navigation ---------------------------------------------------------------------------

	private drillUp(): void {
		this.message = "";
		if (this.mode === "task") this.mode = "tasks";
		else if (this.mode === "tasks") this.mode = "stages";
		else if (this.mode === "stages") this.mode = "runs";
		else return this.close();
		this.render_();
	}

	private drillDown(): void {
		this.message = "";
		if (this.mode === "runs") {
			if (this.runs.length === 0) return;
			this.mode = "stages";
		} else if (this.mode === "stages") {
			if (!this.detail) return;
			this.mode = "tasks";
		} else if (this.mode === "tasks") {
			if (!this.currentTask()) return;
			this.mode = "task";
			this.logs = undefined;
			this.logScroll = 0;
			void this.reload();
		}
		this.render_();
	}

	private move(delta: number): void {
		this.message = "";
		if (this.mode === "runs") {
			if (this.runs.length === 0) return;
			this.selectedRun = wrapIndex(this.selectedRun + delta, this.runs.length);
			this.selectedStage = 0;
			this.selectedTask = 0;
			this.selectedTaskId = "";
			this.detail = undefined;
			this.launchScroll = 0;
			this.generation += 1;
			void this.reload();
		} else if (this.mode === "stages") {
			const stages = this.stages();
			this.selectedStage = wrapIndex(this.selectedStage + delta, stages.length);
			this.selectedTask = 0;
			this.selectedTaskId = "";
		} else if (this.mode === "tasks") this.moveTask(delta);
		this.render_();
	}

	private moveTask(delta: number): void {
		const tasks = this.stageTasks();
		this.selectedTask = wrapIndex(this.selectedTask + delta, tasks.length);
		this.selectedTaskId = tasks[this.selectedTask]?.taskId ?? "";
		this.logs = undefined;
		this.logScroll = 0;
		if (this.mode === "task") void this.reload();
		this.render_();
	}

	private switchStream(delta: number): void {
		const index = LOG_STREAMS.indexOf(this.logStream);
		this.logStream = LOG_STREAMS[wrapIndex(index + delta, LOG_STREAMS.length)]!;
		this.logScroll = 0;
		this.render_();
	}

	private scrollLogs(delta: number): void {
		const max = Math.max(0, this.streamLines().length - LOG_VIEW_LINES);
		this.logScroll = Math.max(0, Math.min(max, this.logScroll + delta));
		this.render_();
	}

	// --- data ---------------------------------------------------------------------------------

	selectedRunSummary(): RunSummary | undefined {
		return this.runs[this.selectedRun];
	}

	private stages() {
		return this.detail ? stageGroups(this.detail.run, this.detail.record) : [];
	}

	private currentStageId(): string | undefined {
		return this.stages()[this.selectedStage]?.id;
	}

	private stageTasks(): BoardTask[] {
		return sortTasks(this.stages()[this.selectedStage]?.tasks ?? []);
	}

	currentTask(): BoardTask | undefined {
		return this.stageTasks()[this.selectedTask];
	}

	private streamLines(): string[] {
		const stream = this.logs?.streams.find(
			(entry) => entry.kind === this.logStream,
		);
		if (!stream) return [];
		if (stream.refused) return [`(not read: ${stream.refused})`];
		return stream.lines;
	}

	async reload(): Promise<void> {
		if (this.closed) return;
		if (this.reloadActive) {
			this.reloadQueued = true;
			return;
		}
		this.reloadActive = true;
		const generation = this.generation;
		try {
			const previous = this.selectedRunSummary()?.runId;
			const runs = await this.source.listRuns();
			if (this.closed || generation !== this.generation) return;
			// /aw <child run>: a run omitted from the top-level list stays listed first.
			const pinned = this.options.initialRunId;
			if (
				pinned &&
				!runs.some(
					(run) => run.runId === pinned || run.runId.startsWith(pinned),
				)
			) {
				const extra =
					this.detail?.run.runId.startsWith(pinned) === true
						? this.detail.run
						: (await this.source.runDetail(pinned).catch(() => undefined))?.run;
				if (this.closed || generation !== this.generation) return;
				if (extra) runs.unshift(extra);
			}
			this.runs = runs;
			const wanted = this.initialPending ?? previous;
			const index = wanted
				? runs.findIndex(
						(run) => run.runId === wanted || run.runId.startsWith(wanted),
					)
				: -1;
			this.selectedRun =
				index >= 0 ? index : clampIndex(this.selectedRun, runs.length);
			if (this.initialPending) {
				if (index >= 0) this.mode = "stages";
				this.initialPending = undefined;
			}
			const selected = this.selectedRunSummary();
			if (!selected) {
				this.detail = undefined;
			} else {
				const detail = await this.source.runDetail(selected.runId);
				if (this.closed || generation !== this.generation) return;
				this.detail = detail;
				this.clampSelection();
				const task = this.currentTask();
				if (this.mode === "task" && task) {
					const logs = await this.source
						.taskLogs(selected.runId, task.taskId)
						.catch(() => undefined);
					if (this.closed || generation !== this.generation) return;
					this.logs = logs;
				}
			}
			this.error = "";
		} catch (error) {
			if (!this.closed && generation === this.generation)
				this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.reloadActive = false;
			this.render_();
			if (this.reloadQueued && !this.closed) {
				this.reloadQueued = false;
				void this.reload();
			}
		}
	}

	private clampSelection(): void {
		const stages = this.stages();
		this.selectedStage = clampIndex(this.selectedStage, stages.length);
		const tasks = this.stageTasks();
		const kept = this.selectedTaskId
			? tasks.findIndex((task) => task.taskId === this.selectedTaskId)
			: -1;
		this.selectedTask =
			kept >= 0 ? kept : clampIndex(this.selectedTask, tasks.length);
		this.selectedTaskId = tasks[this.selectedTask]?.taskId ?? "";
	}

	// --- actions ------------------------------------------------------------------------------

	private launchText(): string | undefined {
		const command = this.detail?.launch?.command;
		return command?.state === "captured" ? command.text : undefined;
	}

	private launchUnavailable(): string {
		const launch = this.detail?.launch;
		if (!this.detail) return "launch command unavailable: run not loaded";
		if (!launch) return "launch command unavailable: not captured";
		if (launch.command.state === "unavailable")
			return `launch command unavailable: ${launch.command.reason}`;
		return `launch command unavailable: ${launch.command.error ?? "artifact missing"}`;
	}

	private openLaunch(): void {
		if (this.launchText() === undefined)
			this.message = this.launchUnavailable();
		else {
			this.launchOpen = true;
			this.launchScroll = 0;
			this.message = "";
		}
		this.render_();
	}

	private async copyLaunch(): Promise<void> {
		const text = this.launchText();
		if (text === undefined) {
			this.message = this.launchUnavailable();
			this.render_();
			return;
		}
		try {
			await this.source.copy(text);
			this.message = "Launch command copied";
		} catch {
			this.message = "Launch command copy failed";
		}
		this.render_();
	}

	private ask(kind: Prompt["kind"]): void {
		const run = this.detail?.run;
		const label = run?.name ?? run?.runId ?? "";
		if (!run || this.busy) {
			this.message = this.busy ? "busy" : "no run selected";
		} else if (kind === "stop") {
			if (run.status === "running" || run.status === "blocked")
				this.prompt = { kind, runId: run.runId, label };
			else this.message = `stop: run is ${run.status}`;
		} else if (kind === "resume") {
			if (RESUMABLE.has(run.status))
				this.prompt = { kind, runId: run.runId, label };
			else this.message = `resume: run is ${run.status}`;
		}
		this.render_();
	}

	private async perform(prompt: Prompt): Promise<void> {
		this.busy = true;
		this.message = `${prompt.kind === "stop" ? "stopping" : "resuming"}…`;
		this.render_();
		try {
			const outcome =
				prompt.kind === "stop"
					? await this.source.stop(prompt.runId)
					: await this.source.resume(prompt.runId);
			this.message = safeLine(outcome.text.split("\n")[0] ?? "");
		} catch (error) {
			this.message = safeLine(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.busy = false;
			await this.reload();
		}
	}

	// --- rendering ----------------------------------------------------------------------------

	render(width: number): string[] {
		const viewport = Math.max(1, Math.floor(width || 1));
		// Keep a right gutter: some terminals leave stale cells in the last columns.
		const content = Math.max(1, viewport - 2);
		const lines = this.launchOpen
			? this.renderLaunch(content)
			: this.mode === "task" && this.detail && this.currentTask()
				? this.renderTask(content, this.currentTask()!)
				: this.renderBoard(content);
		if (this.prompt) lines.push(...this.renderPrompt(content));
		else {
			if (this.message) lines.push(accent(this.theme, safeLine(this.message)));
			if (this.error) lines.push(errorText(this.theme, safeLine(this.error)));
		}
		return lines.map((line) => padAnsi(fit(line, content), viewport));
	}

	private renderPrompt(width: number): string[] {
		const prompt = this.prompt!;
		const t = this.theme;
		return boxed(
			t,
			prompt.kind === "stop" ? "Stop run?" : "Resume run?",
			width,
			[
				`${prompt.kind === "stop" ? "Stop" : "Resume"} ${safeLine(prompt.label)} (${prompt.runId})?`,
				navHint(t, "y yes · n no · Esc cancel"),
			],
			"warning",
		);
	}

	private header(width: number): string[] {
		const t = this.theme;
		const summary =
			this.mode !== "runs" && this.detail
				? this.detail.run.taskSummary
				: undefined;
		const count = (status: string) =>
			this.runs.filter((run) => run.status === status).length;
		const running = summary ? summary.running : count("running");
		const blocked = summary ? summary.blocked : count("blocked");
		const failed = summary
			? summary.failed + summary.interrupted
			: count("failed") + count("interrupted");
		const done = summary ? summary.completed : count("completed");
		return [
			...boxed(
				t,
				"✦ agent-workflow board",
				width,
				[
					`${chip(t, "mode", this.mode === "task" ? "detail" : this.mode, "accent")} ${chip(t, "running", String(running), "accent")} ${chip(t, "blocked", String(blocked), "warning")} ${chip(t, "failed", String(failed), "error")} ${chip(t, "done", String(done), "success")} ${muted(t, "·")} ${fg(t, "text", this.breadcrumb())}`,
				],
				"borderAccent",
			),
			"",
		];
	}

	private breadcrumb(): string {
		const parts = ["aw"];
		const run = this.selectedRunSummary();
		if (run && this.mode !== "runs")
			parts.push(safeLine(run.name ?? run.runId));
		const stage = this.currentStageId();
		if (stage && (this.mode === "tasks" || this.mode === "task"))
			parts.push(safeLine(stage));
		const task = this.currentTask();
		if (task && this.mode === "task") parts.push(safeLine(task.displayName));
		return parts.join(" › ");
	}

	private footer(width: number): string {
		const launch =
			this.launchText() !== undefined ? " · v launch · c copy" : "";
		const actions = " · s stop · u resume";
		const text =
			this.mode === "task"
				? `←/→ output/stderr/events · ↑/↓ scroll · [/] task · b/Esc back · r refresh${actions} · q close`
				: this.mode === "tasks"
					? `Enter/→ logs · b/Esc/← stages · ↑/↓ move · r refresh${launch}${actions} · q close`
					: this.mode === "stages"
						? `Enter/→ tasks · b/Esc/← runs · ↑/↓ move · r refresh${launch}${actions} · q close`
						: `Enter/→ stages · ↑/↓ move · r refresh${launch}${actions} · q/Esc close`;
		return fit(navHint(this.theme, text), width);
	}

	private renderBoard(width: number): string[] {
		const t = this.theme;
		const lines = this.header(width);
		if (this.loading && this.runs.length === 0)
			lines.push(...boxed(t, "Loading", width, [muted(t, "loading runs…")]));
		else if (this.runs.length === 0)
			lines.push(
				...boxed(t, "Runs", width, [
					muted(t, "no agent-workflow runs in this project"),
				]),
			);
		else if (this.mode === "runs")
			lines.push(
				...this.twoPane(
					width,
					"Selected",
					this.summaryLines(false),
					"Runs",
					this.runLines(this.mainWidth(width)),
				),
			);
		else if (this.mode === "stages")
			lines.push(
				...this.twoPane(
					width,
					"Run summary",
					this.summaryLines(true),
					"Stages",
					this.stageLines(this.mainWidth(width)),
				),
			);
		else
			lines.push(
				...this.twoPane(
					width,
					"Stages",
					this.stageLines(width < 92 ? width - 4 : 30),
					`${safeLine(this.currentStageId() ?? "Stage")} tasks`,
					this.taskLines(this.mainWidth(width)),
				),
			);
		lines.push("", this.footer(width));
		return lines;
	}

	private twoPane(
		width: number,
		leftTitle: string,
		left: string[],
		rightTitle: string,
		right: string[],
	): string[] {
		const t = this.theme;
		if (width < 92)
			return [
				...boxed(t, leftTitle, width, left),
				"",
				...boxed(t, rightTitle, width, right, "borderAccent"),
			];
		const leftWidth = Math.min(40, Math.max(28, Math.floor(width * 0.34)));
		const rightWidth = Math.max(40, width - leftWidth - 1);
		const leftBox = boxed(t, leftTitle, leftWidth, left);
		const rightBox = boxed(t, rightTitle, rightWidth, right, "borderAccent");
		const rows: string[] = [];
		for (let i = 0; i < Math.max(leftBox.length, rightBox.length); i += 1)
			rows.push(
				joinFixedColumns(
					[leftBox[i] ?? "", rightBox[i] ?? ""],
					[leftWidth, rightWidth],
				),
			);
		return rows;
	}

	private mainWidth(width: number): number {
		if (width < 92) return width - 4;
		return width - Math.min(40, Math.max(28, Math.floor(width * 0.34))) - 5;
	}

	private runLines(width: number): string[] {
		const t = this.theme;
		const window = visibleWindow(this.runs, this.selectedRun, MAX_LIST_ROWS);
		const lines: string[] = [];
		if (window.hiddenBefore > 0)
			lines.push(muted(t, `  ${window.hiddenBefore} more runs above`));
		for (const { item: run, index } of window.rows) {
			const selected = index === this.selectedRun;
			const name = safeLine(run.name ?? run.runId);
			const left = `${selected ? accent(t, "› ") : "  "}${statusGlyph(t, run.status)} ${selected ? strong(t, name) : name}`;
			const executors = run.executors?.length
				? ` ${muted(t, run.executors.join("+"))}`
				: run.executor
					? ` ${muted(t, run.executor)}`
					: "";
			const right = `${padAnsi(statusLabel(t, run.status), 11)} ${progressBar(t, run.taskSummary, 5)}${executors}`;
			lines.push(
				selectedLine(
					t,
					joinColumns(left, right, width, Math.max(16, width - 40)),
					width,
					selected,
				),
			);
		}
		if (window.hiddenAfter > 0)
			lines.push(muted(t, `  ${window.hiddenAfter} more runs below`));
		return lines;
	}

	private summaryLines(full: boolean): string[] {
		const t = this.theme;
		const summary = this.selectedRunSummary();
		if (!summary) return [muted(t, "none")];
		const detail =
			this.detail?.run.runId === summary.runId ? this.detail : undefined;
		const run = detail?.run ?? summary;
		const lines = [
			`${statusGlyph(t, run.status)} ${strong(t, safeLine(run.name ?? run.type))} ${statusLabel(t, run.status)}`,
			`${progressBar(t, run.taskSummary, 8)} ${muted(t, `· running ${run.taskSummary.running}`)}`,
			kvRow(t, "run", run.runId),
			metaLine(t, [
				["started", timestampText(run.createdAt)],
				[
					"elapsed",
					elapsedText(
						run.createdAt,
						run.updatedAt,
						run.status === "running",
						this.now(),
					),
				],
			]),
			kvRow(
				t,
				"executor",
				run.executors?.length
					? `${run.executors.join(", ")} (mixed)`
					: (run.executor ?? "(default)"),
			),
		];
		if (!detail) return lines;
		const status = detail.run;
		if (status.verdict)
			lines.push(kvRow(t, "verdict", safeLine(status.verdict), "accent"));
		for (const artifact of status.reportArtifacts)
			lines.push(
				kvRow(t, artifact.label.toLowerCase(), safeLine(artifact.path)),
			);
		if (full && status.parentUsage) {
			const total = formatTokenCount(status.parentUsage.totalTokens);
			if (total) lines.push(kvRow(t, "parent usage", `${total} tokens`));
		}
		const launch = detail.launch;
		lines.push("", accent(t, "Launch"));
		if (!launch) lines.push(kvRow(t, "command", "unavailable (not captured)"));
		else {
			lines.push(kvRow(t, "source", `${launch.source} · ${launch.entry}`));
			if (full) {
				lines.push(kvRow(t, "profile", safeLine(launch.profile)));
				lines.push(
					kvRow(
						t,
						"task",
						`${launch.task.characters} chars · ${launch.task.lines} line${launch.task.lines === 1 ? "" : "s"}`,
					),
				);
			}
			lines.push(
				kvRow(
					t,
					"command",
					this.launchText() !== undefined
						? "available · v view · c copy"
						: this.launchUnavailable().replace(
								"launch command unavailable: ",
								"unavailable: ",
							),
				),
			);
		}
		return lines;
	}

	private stageLines(width: number): string[] {
		const t = this.theme;
		const stages = this.stages();
		if (stages.length === 0) return [muted(t, "loading…")];
		return stages.map((stage, index) => {
			const selected = index === this.selectedStage;
			const summary = summarizeTasks(stage.tasks);
			const status = statusForSummary(summary);
			const label = `${selected ? accent(t, "› ") : "  "}${statusGlyph(t, status)} ${selected ? strong(t, safeLine(stage.id)) : safeLine(stage.id)}`;
			const right = `${statusLabel(t, status === "completed" ? "done" : status)} ${progressBar(t, summary, 6)}`;
			return selectedLine(
				t,
				joinColumns(label, right, width, Math.max(12, Math.floor(width * 0.5))),
				width,
				selected,
			);
		});
	}

	private taskLines(width: number): string[] {
		const t = this.theme;
		const tasks = this.stageTasks();
		if (tasks.length === 0 || !this.detail)
			return [muted(t, "  no tasks in this stage")];
		const run = this.detail.run;
		const window = visibleWindow(tasks, this.selectedTask, MAX_LIST_ROWS);
		const lines: string[] = [];
		if (window.hiddenBefore > 0)
			lines.push(muted(t, `  ${window.hiddenBefore} more tasks above`));
		for (const { item: task, index } of window.rows) {
			const selected = index === this.selectedTask;
			const name = safeLine(task.displayName);
			const runtime = taskRuntime(run, task);
			const left = `${selected ? accent(t, "› ") : "  "}${statusGlyph(t, task.status)} ${selected ? strong(t, name) : name}`;
			const right = `${fg(t, statusColor(task.status), task.status === "completed" ? "done" : task.status)} ${muted(t, "·")} ${muted(t, `${runtime.executor} ${shortModel(runtime.model)} ${runtime.effort}`)}`;
			lines.push(
				selectedLine(
					t,
					joinColumns(
						left,
						right,
						width,
						Math.max(18, Math.floor(width * 0.42)),
					),
					width,
					selected,
				),
			);
		}
		if (window.hiddenAfter > 0)
			lines.push(muted(t, `  ${window.hiddenAfter} more tasks below`));
		return lines;
	}

	private renderTask(width: number, task: BoardTask): string[] {
		const t = this.theme;
		const detail = this.detail!;
		const runtime = taskRuntime(detail.run, task);
		const status = detail.run.tasks.find(
			(entry) => entry.taskId === task.taskId,
		);
		const info = [
			`${statusGlyph(t, task.status)} ${strong(t, safeLine(task.displayName))} ${statusLabel(t, task.status)} ${muted(t, this.breadcrumb())}`,
			metaLine(t, [
				["stage", safeLine(task.stageId ?? "(none)")],
				["agent", safeLine(task.agent)],
				["elapsed", taskElapsed(task, this.now())],
			]),
			metaLine(t, [
				["executor", runtime.executor],
				["model", safeLine(runtime.model)],
				["effort", runtime.effort],
			]),
			kvRow(
				t,
				"detail",
				safeLine(status?.statusDetail ?? String(task.statusDetail)),
			),
			...(task.lastMessage
				? [kvRow(t, "last", safeLine(task.lastMessage), "warning")]
				: []),
			...(detail.run.verdict
				? [kvRow(t, "run verdict", safeLine(detail.run.verdict), "accent")]
				: []),
			kvRow(
				t,
				"logs",
				`/aw logs ${detail.run.runId} --task ${task.specId || task.taskId}`,
			),
		];
		const source = this.streamLines();
		const total = source.length;
		const start = Math.min(this.logScroll, Math.max(0, total - LOG_VIEW_LINES));
		const end = Math.min(total, start + LOG_VIEW_LINES);
		const stream = this.logs?.streams.find(
			(entry) => entry.kind === this.logStream,
		);
		const viewer = [
			`${LOG_STREAMS.map((kind) => (kind === this.logStream ? accent(t, strong(t, `[${kind}]`)) : muted(t, kind))).join("  ")}`,
			metaLine(t, [
				["lines", total === 0 ? "0 / 0" : `${start + 1}-${end} / ${total}`],
				...(stream?.path
					? ([["file", safeLine(stream.path)]] as Array<[string, string]>)
					: []),
			]),
			"",
			...(total === 0
				? [muted(t, this.logs ? "(empty)" : "loading…")]
				: source.slice(start, end).map((line) => safeLine(line))),
		];
		return [
			...this.header(width),
			...boxed(t, "Task", width, info, statusColor(task.status)),
			"",
			...boxed(t, "Logs", width, viewer, "borderAccent"),
			"",
			this.footer(width),
		];
	}

	private renderLaunch(width: number): string[] {
		const t = this.theme;
		const wrapped = wrapByWidth(
			escapeForDisplay(this.launchText() ?? ""),
			Math.max(1, width - 4),
		);
		const maxStart = Math.max(0, wrapped.length - LAUNCH_VIEW_LINES);
		this.launchScroll = Math.min(this.launchScroll, maxStart);
		const start = this.launchScroll;
		const end = Math.min(wrapped.length, start + LAUNCH_VIEW_LINES);
		return [
			...boxed(
				t,
				"Launch command",
				width,
				[
					warning(t, "Redacted at capture · control characters escaped"),
					muted(t, "Clipboard retention is controlled by the OS/terminal."),
					"",
					...wrapped.slice(start, end),
					"",
					muted(t, `${start + 1}-${end} / ${wrapped.length}`),
				],
				"borderAccent",
			),
			"",
			fit(
				navHint(t, "↑/↓ scroll · c copy exact command · b/Esc back · q close"),
				width,
			),
		];
	}
}

/**
 * Open the board in the TUI and resolve when it closes. initialRunId selects that
 * run and opens its stages.
 */
export async function showAwBoard(
	ctx: PiExtensionContext,
	source: AwBoardSource,
	options: AwBoardOptions = {},
): Promise<void> {
	const custom = ctx.ui.custom;
	if (typeof custom !== "function") return;
	await custom.call(
		ctx.ui,
		(tui, theme, _keybindings, done: (v: void) => void) => {
			const board = new AwBoard(
				source,
				tui as Tui,
				(theme ?? {}) as Theme,
				() => done(undefined),
				options,
			);
			void board.start();
			return board;
		},
	);
}

/** The board needs Pi's TUI (`ctx.ui.custom`); RPC, print and JSON modes keep the text commands. */
export function boardAvailable(ctx: PiExtensionContext): boolean {
	return (
		ctx.hasUI === true &&
		ctx.mode === "tui" &&
		typeof ctx.ui.custom === "function"
	);
}
