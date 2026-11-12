// Profile picker: choose a preset, saved profile, or Custom; preview and edit per-role
// executor/model/effort. Read model lists and completeness notes through executor probes.
// All reads and writes use the host API; write nothing until Save. Save either a user
// profile or a workflow preference. The UI interface is scriptable for tests.
import { roleKeyProblem, sortedRoleKeys } from "../../core/role-profiles.js";
import {
	EFFORT_LEVELS,
	WORKFLOW_PROFILE_ROLES,
	type WorkflowRoleAssignment,
	type WorkflowRoleMap,
} from "../../core/types.js";
import type {
	ExecutorModelList,
	HostApiContext,
	ProfileRequest,
	WorkflowPreferenceRequest,
} from "../api.js";
import { effortChoicesFor } from "../executor-models.js";
import { isExecutorProfileName } from "../user-profiles.js";
import type { PiHostApi } from "./host.js";

export type PreviewAction = "save" | "edit" | "back";

export interface ProfilePreviewRow {
	role: string;
	executor: string;
	model: string;
	effort: string;
	/** No entry of its own: the `default` role's values apply. */
	inherited: boolean;
	warning?: string;
}

export interface ProfilePreview {
	title: string;
	subtitle: string;
	rows: ProfilePreviewRow[];
	/** One line per executor in use: its probe's model-list note. */
	notes: string[];
	actions: Array<{ id: PreviewAction; label: string }>;
}

export interface ProfilePickerUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	preview(preview: ProfilePreview): Promise<PreviewAction | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export type ProfilePickerApi = Pick<
	PiHostApi,
	| "profileAction"
	| "workflowPreferenceAction"
	| "executorModelsAction"
	| "listWorkflowsAction"
>;

export type ProfilePickerResult =
	| { status: "cancelled" }
	| { status: "saved"; text: string; scope: "user" | "workflow" };

interface Choice {
	kind: "preset" | "saved";
	id: string;
	label: string;
	roles: WorkflowRoleMap;
}

type Scope = { kind: "user" } | { kind: "workflow"; workflow: string };

export const SCOPE_USER = "Every workflow: a saved user profile";
export const SCOPE_WORKFLOW = "One workflow: its saved preference…";
export const CUSTOM_CHOICE = "Custom…";
export const NEW_PROFILE = "Save as a new profile…";
const OTHER_MODEL = "Other model id…";
const EXECUTOR_DEFAULT_MODEL = "(executor default)";
const DEFAULT_EFFORT = "(default)";
const INHERIT_EXECUTOR = "(the default role's executor)";
const ADD_AGENT_ROLE = "Add an agent role (agent:<name>)…";
const DONE = "Done";
const REMOVE_ROLE = "Remove this role (use the default role)";
const PRESET_TITLES: Record<string, string> = {
	codex: "Codex",
	claude: "Claude",
	pi: "Pi",
	mixed: "Mixed",
};

function clone(roles: WorkflowRoleMap | undefined): WorkflowRoleMap {
	return Object.fromEntries(
		Object.entries(roles ?? {}).map(([key, value]) => [key, { ...value }]),
	);
}

function sameAssignment(
	left: WorkflowRoleAssignment | undefined,
	right: WorkflowRoleAssignment | undefined,
): boolean {
	return (
		left?.executor === right?.executor &&
		left?.model === right?.model &&
		left?.effort === right?.effort
	);
}

function sameRoles(left: WorkflowRoleMap, right: WorkflowRoleMap): boolean {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].every((key) => sameAssignment(left[key], right[key]));
}

export function formatAssignment(
	assignment: WorkflowRoleAssignment | undefined,
): string {
	return `${assignment?.executor ?? "-"}:${assignment?.model ?? "-"}:${assignment?.effort ?? "-"}`;
}

/** Role keys shown: default, every profile role, then the map's agent roles. */
export function previewRoleKeys(roles: WorkflowRoleMap): string[] {
	return [
		...new Set([
			"default",
			...WORKFLOW_PROFILE_ROLES,
			...sortedRoleKeys(roles).filter((key) => key.startsWith("agent:")),
		]),
	];
}

function listed(model: string, models: readonly string[]): boolean {
	return models.some(
		(entry) =>
			entry === model ||
			entry.endsWith(`/${model}`) ||
			model.endsWith(`/${entry}`),
	);
}

/** Preview rows and notes of a role map (the effective values of each role). */
export function profilePreviewRows(
	roles: WorkflowRoleMap,
	executors: readonly ExecutorModelList[],
): { rows: ProfilePreviewRow[]; notes: string[] } {
	const fallback = roles.default ?? {};
	const used = new Set<string>();
	const rows = previewRoleKeys(roles).map((role): ProfilePreviewRow => {
		const own = roles[role];
		const inherited = own === undefined && role !== "default";
		const executor = own?.executor ?? fallback.executor;
		// A role entry's model/effort belong to its executor; an inherited role takes the default's.
		const source = own ?? fallback;
		const row: ProfilePreviewRow = {
			role,
			executor: executor ?? "(run executor)",
			model: source.model ?? EXECUTOR_DEFAULT_MODEL,
			effort: source.effort ?? DEFAULT_EFFORT,
			inherited,
		};
		if (executor) {
			used.add(executor);
			const probe = executors.find((entry) => entry.id === executor);
			if (probe && !probe.usable) row.warning = `${executor} is ${probe.state}`;
			else if (
				source.model &&
				probe?.models &&
				!listed(source.model, probe.models)
			)
				row.warning = probe.modelListComplete
					? `${source.model} is not in ${executor}'s complete model list: refused at launch`
					: `${source.model} is not in ${executor}'s probe list (partial): noted at launch`;
		}
		return row;
	});
	const notes = [...used].sort().map((id) => {
		const probe = executors.find((entry) => entry.id === id);
		return `${id}: ${probe ? probe.note : "not probed"}`;
	});
	return { rows, notes };
}

class Picker {
	private executors: ExecutorModelList[] | undefined;

	constructor(
		private readonly ui: ProfilePickerUi,
		private readonly api: ProfilePickerApi,
		private readonly host: HostApiContext,
	) {}

	private async models(): Promise<ExecutorModelList[]> {
		this.executors ??= (
			await this.api.executorModelsAction(this.host, {})
		).data.executors;
		return this.executors;
	}

	async run(workflow?: string): Promise<ProfilePickerResult> {
		const scope = await this.chooseScope(workflow);
		if (!scope) return { status: "cancelled" };
		const presets =
			(await this.api.profileAction(this.host, { op: "presets" })).data
				.presets ?? [];
		const listedProfiles = (
			await this.api.profileAction(this.host, { op: "list" })
		).data;
		let preference: { profile?: string; roles?: WorkflowRoleMap } | undefined;
		let workflowName: string | undefined;
		if (scope.kind === "workflow") {
			const shown = await this.api.workflowPreferenceAction(this.host, {
				op: "show",
				workflow: scope.workflow,
			});
			preference = shown.data.preference;
			workflowName = shown.data.workflow ?? scope.workflow;
		}
		const choices: Choice[] = [
			...presets.map((preset) => ({
				kind: "preset" as const,
				id: preset.id,
				label: `${PRESET_TITLES[preset.id] ?? preset.id} — ${preset.description}`,
				roles: clone({
					...preset.roles,
					default: { ...preset.roles.default, executor: preset.executor },
				}),
			})),
			...(listedProfiles.profiles ?? []).map((profile) => ({
				kind: "saved" as const,
				id: profile.name,
				label: `Saved: ${profile.name}${isExecutorProfileName(profile.name) ? ` (default profile of ${profile.name} stages)` : ""}`,
				roles: clone({
					...(profile.executor || profile.model || profile.effort
						? {
								default: {
									...(profile.executor ? { executor: profile.executor } : {}),
									...(profile.model ? { model: profile.model } : {}),
									...(profile.effort ? { effort: profile.effort } : {}),
								},
							}
						: {}),
					...profile.roles,
				}),
			})),
		];
		const current =
			scope.kind === "workflow" ? preference?.profile : listedProfiles.default;
		const mark = (choice: Choice) =>
			choice.id === current
				? scope.kind === "workflow"
					? " (saved for this workflow)"
					: " (default)"
				: "";
		while (true) {
			const labels = [
				...choices.map((c) => `${c.label}${mark(c)}`),
				CUSTOM_CHOICE,
			];
			const picked = await this.ui.select(
				scope.kind === "workflow"
					? `Execution profile for workflow ${workflowName}\nSaved as this workflow's preference (every host's launches use it).`
					: "Execution profile for every workflow\nSaved as a user profile; make it the default to use it when a launch names none.",
				labels,
			);
			if (picked === undefined) return { status: "cancelled" };
			const index = labels.indexOf(picked);
			const custom = picked === CUSTOM_CHOICE;
			const base: Choice | undefined = custom
				? (choices.find((c) => c.id === current) ??
					choices.find((c) => c.id === "pi") ??
					choices[0])
				: choices[index];
			if (!base) continue;
			let roles = clone(base.roles);
			if (scope.kind === "workflow" && preference?.profile === base.id)
				roles = { ...roles, ...clone(preference.roles) };
			if (custom) roles = await this.editRoles(roles);
			const saved = await this.previewLoop(
				scope,
				workflowName,
				base,
				roles,
				custom,
			);
			if (saved) return saved;
		}
	}

	private async chooseScope(workflow?: string): Promise<Scope | undefined> {
		if (workflow) return { kind: "workflow", workflow };
		const scope = await this.ui.select("Configure execution profiles for", [
			SCOPE_USER,
			SCOPE_WORKFLOW,
		]);
		if (scope === SCOPE_USER) return { kind: "user" };
		if (scope !== SCOPE_WORKFLOW) return undefined;
		const listed = await this.api.listWorkflowsAction(this.host, {});
		const names = [
			...new Set(listed.data.workflows.map((entry) => entry.name)),
		];
		if (names.length === 0) {
			this.ui.notify("No workflows found.", "warning");
			return undefined;
		}
		const name = await this.ui.select("Choose a workflow", names);
		return name ? { kind: "workflow", workflow: name } : undefined;
	}

	private async previewLoop(
		scope: Scope,
		workflowName: string | undefined,
		base: Choice,
		initial: WorkflowRoleMap,
		custom: boolean,
	): Promise<ProfilePickerResult | undefined> {
		let roles = initial;
		while (true) {
			const edited = custom || !sameRoles(roles, base.roles);
			const { rows, notes } = profilePreviewRows(roles, await this.models());
			const action = await this.ui.preview({
				title: edited
					? `Custom (from ${base.kind === "preset" ? (PRESET_TITLES[base.id] ?? base.id) : base.id})`
					: base.kind === "preset"
						? (PRESET_TITLES[base.id] ?? base.id)
						: `Saved: ${base.id}`,
				subtitle:
					scope.kind === "workflow"
						? `role preview · workflow ${workflowName}`
						: "role preview · user profile",
				rows,
				notes,
				actions: [
					{ id: "save", label: "Save" },
					{ id: "edit", label: "Edit a role…" },
					{ id: "back", label: "Back to profiles" },
				],
			});
			if (action === undefined || action === "back") return undefined;
			if (action === "edit") {
				roles = await this.editRoles(roles);
				continue;
			}
			try {
				const saved =
					scope.kind === "workflow"
						? await this.saveWorkflow(scope.workflow, base, roles)
						: await this.saveUser(base, roles, edited);
				if (saved) return saved;
			} catch (error) {
				this.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		}
	}

	private async saveWorkflow(
		workflow: string,
		base: Choice,
		roles: WorkflowRoleMap,
	): Promise<ProfilePickerResult> {
		const overrides: WorkflowRoleMap = {};
		for (const [key, value] of Object.entries(roles))
			if (!sameAssignment(value, base.roles[key])) overrides[key] = value;
		const dropped = Object.keys(base.roles).filter((key) => !roles[key]);
		if (dropped.length)
			this.ui.notify(
				`A workflow preference adds role overrides to ${base.id}; it cannot remove ${dropped.join(", ")} (kept from ${base.id}).`,
				"warning",
			);
		const request: WorkflowPreferenceRequest = {
			op: "set",
			workflow,
			profile: base.id,
			unset: ["roles"],
			...(Object.keys(overrides).length ? { roles: overrides } : {}),
		};
		const saved = await this.api.workflowPreferenceAction(this.host, request);
		return { status: "saved", scope: "workflow", text: saved.text };
	}

	private async saveUser(
		base: Choice,
		roles: WorkflowRoleMap,
		edited: boolean,
	): Promise<ProfilePickerResult | undefined> {
		if (base.kind === "saved" && !edited) {
			const yes = await this.ui.confirm(
				`Make "${base.id}" the default profile?`,
				"Launches that name no profile (and have no per-workflow preference) use the default profile.",
			);
			if (!yes) return undefined;
			const saved = await this.api.profileAction(this.host, {
				op: "default",
				name: base.id,
			});
			return { status: "saved", scope: "user", text: saved.text };
		}
		const update =
			base.kind === "saved" ? `Update saved profile "${base.id}"` : undefined;
		const target = await this.ui.select("Save the profile as", [
			...(update ? [update] : []),
			NEW_PROFILE,
		]);
		if (target === undefined) return undefined;
		let name = base.id;
		if (target === NEW_PROFILE) {
			const typed = (
				await this.ui.input(
					"Profile name (letters, digits, . _ -)",
					base.kind === "preset" ? base.id : "",
				)
			)?.trim();
			if (!typed) return undefined;
			name = typed;
		}
		// A profile named after an executor is that executor's default profile: say so before saving.
		if (
			isExecutorProfileName(name) &&
			!(await this.ui.confirm(
				`"${name}" is the default profile of ${name} stages`,
				`Saving it changes the model and effort ${name} stages use where the workflow, the launch and the chosen profile set none. profile delete ${name} restores the built-in one.`,
			))
		)
			return undefined;
		const makeDefault = await this.ui.confirm(
			`Make "${name}" the default profile?`,
			"Launches that name no profile (and have no per-workflow preference) use the default profile.",
		);
		const request: ProfileRequest =
			base.kind === "preset" && !edited
				? {
						op: "set",
						name,
						preset: base.id,
						...(makeDefault ? { makeDefault } : {}),
					}
				: {
						op: "set",
						name,
						values: {
							...(roles.default?.executor
								? { executor: roles.default.executor }
								: {}),
							roles,
						},
						unset: ["roles"],
						...(makeDefault ? { makeDefault } : {}),
					};
		const saved = await this.api.profileAction(this.host, request);
		return { status: "saved", scope: "user", text: saved.text };
	}

	/** Per-role editing; returns the edited copy (nothing is saved here). */
	private async editRoles(initial: WorkflowRoleMap): Promise<WorkflowRoleMap> {
		const roles = clone(initial);
		while (true) {
			const keys = previewRoleKeys(roles);
			const labels = keys.map(
				(key) =>
					`${key} — ${roles[key] ? formatAssignment(roles[key]) : "(uses default)"}`,
			);
			const picked = await this.ui.select("Edit which role?", [
				...labels,
				ADD_AGENT_ROLE,
				DONE,
			]);
			if (picked === undefined || picked === DONE) return roles;
			let key = keys[labels.indexOf(picked)];
			if (picked === ADD_AGENT_ROLE) {
				const name = (
					await this.ui.input("Agent name (role agent:<name>)")
				)?.trim();
				if (!name) continue;
				const problem = roleKeyProblem(`agent:${name}`);
				if (problem) {
					this.ui.notify(problem, "error");
					continue;
				}
				key = `agent:${name}`;
			}
			if (key) await this.editRole(roles, key);
		}
	}

	private async editRole(roles: WorkflowRoleMap, key: string): Promise<void> {
		while (true) {
			const entry = roles[key] ?? {};
			const executor = entry.executor ?? roles.default?.executor;
			const options = [
				`Executor: ${entry.executor ?? INHERIT_EXECUTOR}`,
				`Model: ${entry.model ?? EXECUTOR_DEFAULT_MODEL}`,
				`Effort: ${entry.effort ?? DEFAULT_EFFORT}`,
				...(key !== "default" && roles[key] ? [REMOVE_ROLE] : []),
				DONE,
			];
			const field = await this.ui.select(
				`Edit role ${key}\nCurrent: ${formatAssignment(roles[key])}`,
				options,
			);
			if (field === undefined || field === DONE) return;
			if (field === REMOVE_ROLE) {
				delete roles[key];
				return;
			}
			const next: WorkflowRoleAssignment = { ...entry };
			if (field.startsWith("Executor:")) {
				const executors = await this.models();
				const labels = executors.map(
					(probe) => `${probe.id}${probe.usable ? "" : ` (${probe.state})`}`,
				);
				const choice = await this.ui.select(`Executor for ${key}`, [
					...(key === "default" ? [] : [INHERIT_EXECUTOR]),
					...labels,
				]);
				if (choice === undefined) continue;
				const id =
					choice === INHERIT_EXECUTOR
						? undefined
						: executors[labels.indexOf(choice)]?.id;
				if (id !== next.executor) {
					// A model id belongs to its executor.
					delete next.model;
					if (id === undefined) delete next.executor;
					else next.executor = id;
				}
			} else if (field.startsWith("Model:")) {
				const probe = (await this.models()).find(
					(entry) => entry.id === executor,
				);
				const models = probe?.models ?? [];
				const choice = await this.ui.select(
					`Model for ${key} on ${executor ?? "the run executor"}\n${probe?.note ?? "no probe for this executor"}`,
					[EXECUTOR_DEFAULT_MODEL, ...models, OTHER_MODEL],
				);
				if (choice === undefined) continue;
				if (choice === EXECUTOR_DEFAULT_MODEL) delete next.model;
				else if (choice === OTHER_MODEL) {
					const typed = (await this.ui.input("Model id"))?.trim();
					if (!typed) continue;
					if (/\s/.test(typed)) {
						this.ui.notify("A model id has no spaces.", "error");
						continue;
					}
					next.model = typed;
				} else next.model = choice;
			} else if (field.startsWith("Effort:")) {
				// 2026-11-12 (owner: effort by executor and model): the levels of this executor and
				// model, as in the dashboard; a saved level they lack stays choosable to keep it.
				const probe = (await this.models()).find(
					(entry) => entry.id === executor,
				);
				const { levels, note } = effortChoicesFor(
					probe,
					next.model,
					EFFORT_LEVELS,
				);
				const kept =
					next.effort && !levels.includes(next.effort) ? [next.effort] : [];
				const choice = await this.ui.select(`Effort for ${key}\n${note}`, [
					DEFAULT_EFFORT,
					...levels,
					...kept,
				]);
				if (choice === undefined) continue;
				if (choice === DEFAULT_EFFORT) delete next.effort;
				else next.effort = choice as WorkflowRoleAssignment["effort"];
			}
			if (Object.keys(next).length === 0) delete roles[key];
			else roles[key] = next;
		}
	}
}

/**
 * Run the picker. `workflow` skips the scope question and configures that workflow's preference
 * (the launch-time chooser's "Custom…"). Nothing is written unless the user saves.
 */
export async function runProfilePicker(
	ui: ProfilePickerUi,
	api: ProfilePickerApi,
	host: HostApiContext,
	options: { workflow?: string } = {},
): Promise<ProfilePickerResult> {
	return new Picker(ui, api, host).run(options.workflow);
}
