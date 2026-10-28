// New in agent-workflow (WP34 item 2): Pi's UI for the profile picker (profile-picker.ts). Ported
// from pi-workflow 0.16.4 (b83cc4f) src/workflow-profile-tui.ts (`createNativeWorkflowProfileUi`,
// `renderWorkflowProfilePreview`, `selectNativeProfilePreview`): lists use Pi's native
// `ctx.ui.select`, names `ctx.ui.input`, yes/no `ctx.ui.confirm`, and the preview is a custom
// component (`ctx.ui.custom`) with a colour table and its actions. Changes: the table has one row
// per role (ROLE, EXECUTOR, MODEL, EFFORT) instead of per stage, each executor has its own colour
// (pi `accent`, codex `mdLink`, claude `mdHeading`), a role without an entry of its own is dimmed
// (it uses the default role), probe warnings and model-list notes follow the table; the component
// is self-contained (no pi-tui SelectList/DynamicBorder imports: the package builds without the
// optional Pi peer). Without `ctx.ui.custom` the preview falls back to `ctx.ui.select` with a text
// table.
import type { PiExtensionContext } from "./pi-types.js";
import type {
	PreviewAction,
	ProfilePickerUi,
	ProfilePreview,
	ProfilePreviewRow,
} from "./profile-picker.js";
import {
	accent,
	type Component,
	fg,
	fit,
	isCloseInput,
	isEnter,
	isKey,
	matchesKey,
	muted,
	padAnsi,
	safeLine,
	strong,
	type Theme,
	type Tui,
	visibleWidth,
	warning,
	wrapIndex,
} from "./tui-kit.js";

const MAX_WIDTH = 100;
const GAP = "  ";

/** The colour of an executor's name in the preview. */
export function executorColor(executor: string): string {
	if (executor === "pi") return "accent";
	if (executor === "codex") return "mdLink";
	if (executor === "claude") return "mdHeading";
	return "text";
}

function cell(value: string, width: number): string {
	return padAnsi(fit(safeLine(value), width), width);
}

/** The preview table: responsive columns (≥ 64 columns), else two lines per role. */
export function renderProfilePreview(
	preview: ProfilePreview,
	theme: Theme,
	width: number,
): string[] {
	const safe = Math.max(1, Math.min(width, MAX_WIDTH));
	const lines = [
		fit(
			` ${accent(theme, strong(theme, safeLine(preview.title)))}${muted(theme, `  ${safeLine(preview.subtitle)}`)}`,
			safe,
		),
	];
	const table = safe - 2;
	const role = Math.min(
		22,
		Math.max(8, ...preview.rows.map((row) => visibleWidth(row.role))),
	);
	const executor = Math.min(
		12,
		Math.max(8, ...preview.rows.map((row) => visibleWidth(row.executor))),
	);
	const effort = 9;
	const model = table - role - executor - effort - GAP.length * 3;
	const warnLine = (row: ProfilePreviewRow) =>
		row.warning
			? [fit(`   ${warning(theme, `⚠ ${safeLine(row.warning)}`)}`, safe)]
			: [];
	if (table >= 64 && model >= 16) {
		lines.push(
			` ${[
				fg(theme, "dim", cell("ROLE", role)),
				fg(theme, "dim", cell("EXECUTOR", executor)),
				fg(theme, "dim", cell("MODEL", model)),
				fg(theme, "dim", cell("EFFORT", effort)),
			].join(GAP)}`,
			fg(theme, "borderMuted", ` ${"─".repeat(table)}`),
		);
		for (const row of preview.rows) {
			const dim = row.inherited ? "dim" : undefined;
			lines.push(
				fit(
					` ${[
						fg(theme, dim ?? "muted", cell(row.role, role)),
						fg(
							theme,
							dim ?? executorColor(row.executor),
							cell(row.executor, executor),
						),
						fg(theme, dim ?? "text", cell(row.model, model)),
						fg(theme, dim ?? "muted", cell(row.effort, effort)),
					].join(GAP)}`,
					safe,
				),
				...warnLine(row),
			);
		}
	} else
		for (const row of preview.rows)
			lines.push(
				fit(
					` ${fg(theme, row.inherited ? "dim" : "text", safeLine(row.role))} ${fg(theme, row.inherited ? "dim" : executorColor(row.executor), `[${safeLine(row.executor)}]`)}`,
					safe,
				),
				fit(
					`   ${fg(theme, "text", safeLine(row.model))} ${fg(theme, "dim", "·")} ${muted(theme, safeLine(row.effort))}`,
					safe,
				),
				...warnLine(row),
			);
	if (preview.rows.some((row) => row.inherited))
		lines.push(
			fit(
				` ${fg(theme, "dim", "dimmed: no entry of its own, the default role applies")}`,
				safe,
			),
		);
	for (const note of preview.notes)
		lines.push(fit(` ${fg(theme, "dim", safeLine(note))}`, safe));
	return lines;
}

/** The preview with its actions (↑/↓, Enter; Esc/q = back). */
export class ProfilePreviewComponent implements Component {
	selected = 0;

	constructor(
		private readonly preview: ProfilePreview,
		private readonly tui: Tui,
		private readonly theme: Theme,
		private readonly done: (action: PreviewAction | undefined) => void,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const count = this.preview.actions.length;
		if (matchesKey(data, "escape") || isCloseInput(data)) this.done(undefined);
		else if (matchesKey(data, "up") || isKey(data, "k"))
			this.selected = wrapIndex(this.selected - 1, count);
		else if (matchesKey(data, "down") || isKey(data, "j"))
			this.selected = wrapIndex(this.selected + 1, count);
		else if (isEnter(data)) this.done(this.preview.actions[this.selected]?.id);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const safe = Math.max(1, Math.min(width, MAX_WIDTH));
		const rule = (color: string) => fg(t, color, "─".repeat(safe));
		return [
			rule("borderAccent"),
			...renderProfilePreview(this.preview, t, safe),
			"",
			...this.preview.actions.map((action, index) =>
				index === this.selected
					? fit(` ${accent(t, `→ ${action.label}`)}`, safe)
					: fit(`   ${fg(t, "text", action.label)}`, safe),
			),
			fit(` ${fg(t, "dim", "↑↓ navigate  enter select  esc back")}`, safe),
			rule("borderMuted"),
		];
	}
}

/** Pi's native UI for the picker. */
export function piProfilePickerUi(ctx: PiExtensionContext): ProfilePickerUi {
	const ui = ctx.ui;
	return {
		select: (title, options) => ui.select(title, options),
		input: async (title, placeholder) =>
			typeof ui.input === "function" ? ui.input(title, placeholder) : undefined,
		confirm: async (title, message) =>
			(await ui.confirm(title, message)) === true,
		notify: (message, level) => ui.notify(message, level),
		preview: async (preview) => {
			const custom = ui.custom;
			if (typeof custom === "function")
				return (await custom.call(
					ui,
					(
						tui: unknown,
						theme: unknown,
						_keybindings: unknown,
						done: (action: PreviewAction | undefined) => void,
					) =>
						new ProfilePreviewComponent(
							preview,
							tui as Tui,
							(theme ?? {}) as Theme,
							done,
						),
				)) as PreviewAction | undefined;
			const title = [
				`${preview.title} — ${preview.subtitle}`,
				...preview.rows.map(
					(row) =>
						`${row.role}${row.inherited ? " (default)" : ""}: ${row.executor} · ${row.model} · ${row.effort}${row.warning ? ` ⚠ ${row.warning}` : ""}`,
				),
				...preview.notes,
			].join("\n");
			const labels = preview.actions.map((action) => action.label);
			const picked = await ui.select(title, labels);
			return preview.actions.find((action) => action.label === picked)?.id;
		},
	};
}
