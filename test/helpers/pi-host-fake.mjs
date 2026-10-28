// New in agent-workflow (WP16): a fake Pi ExtensionAPI / ExtensionContext for the Pi host tests that
// need the WP16 surfaces: `pi.sendMessage` (recorded), `ctx.ui.setStatus` (recorded, with the
// current footer state) and `ctx.sessionManager.getSessionId()`.

/**
 * Fake ExtensionAPI: commands, tools, event handlers and sent custom messages. WP19 round 2:
 * `history` (shared with `fakeCtx`) makes sent custom messages appear in the session history, as a
 * message Pi processed and persisted does.
 */
export function fakePi({ history } = {}) {
	const commands = new Map();
	const tools = new Map();
	const handlers = new Map();
	const messages = [];
	return {
		commands,
		tools,
		handlers,
		messages,
		sendFailures: 0,
		registerCommand(name, options) {
			if (commands.has(name)) throw new Error(`duplicate command ${name}`);
			commands.set(name, options);
		},
		registerTool(tool) {
			if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
			tools.set(tool.name, tool);
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		getThinkingLevel: () => "medium",
		sendMessage(message, options) {
			if (this.sendFailures > 0) {
				this.sendFailures -= 1;
				throw new Error("sendMessage failed (test)");
			}
			messages.push({ message, options });
			history?.push({
				type: "custom_message",
				customType: message.customType,
				details: message.details,
			});
		},
	};
}

/**
 * Fake ExtensionContext with a dialog UI (rpc) or none (json), a session id and a footer. With
 * `history`, `sessionManager.getEntries()` returns it (WP19 round 2). WP33: widgets are recorded;
 * `custom: true` adds `ui.custom` (resolves when the component calls `done`).
 */
export function fakeCtx(
	cwd,
	{ hasUI = true, sessionId = "session-a", select, mode, history, custom } = {},
) {
	const notes = [];
	const statuses = [];
	const selects = [];
	const footer = new Map();
	// WP33: `setWidget` records (key → current lines) and the `ctx.ui.custom` components shown.
	const widgetCalls = [];
	const widgets = new Map();
	const customs = [];
	return {
		cwd,
		hasUI,
		mode: mode ?? (hasUI ? "rpc" : "json"),
		model: { provider: "anthropic", id: "claude-test" },
		modelRegistry: { getAvailable: () => [] },
		sessionManager:
			sessionId === undefined
				? undefined
				: {
						getSessionId: () => sessionId,
						...(history ? { getEntries: () => history } : {}),
					},
		notes,
		statuses,
		selects,
		footer,
		widgetCalls,
		widgets,
		customs,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async () => true,
			select: async (title, options) => {
				selects.push({ title, options });
				return select ? select(options) : undefined;
			},
			setStatus: (key, text) => {
				statuses.push({ key, text });
				if (text === undefined) footer.delete(key);
				else footer.set(key, text);
			},
			setWidget: (key, lines, options) => {
				widgetCalls.push({ key, lines, options });
				if (lines === undefined) widgets.delete(key);
				else widgets.set(key, lines);
			},
			...(custom
				? {
						custom: (factory) =>
							new Promise((resolve) => {
								const component = factory({}, {}, {}, resolve);
								customs.push(component);
							}),
					}
				: {}),
		},
	};
}

export async function eventually(check, what, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
}
