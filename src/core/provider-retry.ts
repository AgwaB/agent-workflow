// Provider hints are minimum waits, not values to truncate to our exponential-backoff cap.
// Only call this for a classified rate limit. Unrecognized/past hints leave the default policy intact.
function positiveDelay(value: number, nowMs: number): number | undefined {
	return Number.isFinite(value) &&
		value > 0 &&
		Number.isFinite(new Date(nowMs + Math.ceil(value)).getTime())
		? Math.ceil(value)
		: undefined;
}

function durationMs(text: string): number | undefined {
	let rest = text.trim(),
		total = 0;
	for (;;) {
		const part = rest.match(
			/^(?:and\s+)?(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/iu,
		);
		if (!part) break;
		const unit = part[2]!.toLowerCase();
		const multiplier =
			unit === "ms" || unit.startsWith("millisecond")
				? 1
				: unit.startsWith("s")
					? 1000
					: unit.startsWith("m")
						? 60_000
						: unit.startsWith("h")
							? 3_600_000
							: 86_400_000;
		total += Number(part[1]) * multiplier;
		rest = rest.slice(part[0].length).replace(/^\s*,?\s*/u, "");
	}
	if (total > 0) return total;
	// Retry-After's bare number is seconds. Never mistake the year of a date for seconds.
	const seconds = text.match(/^\s*(\d+(?:\.\d+)?)(?=\s*(?:$|[.;,]))/u);
	return seconds ? Number(seconds[1]) * 1000 : undefined;
}

function wallTime(format: Intl.DateTimeFormat, instant: number): number {
	const parts = Object.fromEntries(
		format.formatToParts(instant).map((p) => [p.type, p.value]),
	);
	return Date.UTC(
		Number(parts.year),
		Number(parts.month) - 1,
		Number(parts.day),
		Number(parts.hour),
		Number(parts.minute),
		Number(parts.second),
	);
}

function clockResetAt(
	match: RegExpMatchArray,
	nowMs: number,
): number | undefined {
	const hour = Number(match[1]),
		minute = Number(match[2] ?? 0);
	const period = match[3]?.toLowerCase();
	if (minute > 59 || (period ? hour < 1 || hour > 12 : hour > 23 || !match[2]))
		return undefined;
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-CA", {
			...(match[4] ? { timeZone: match[4].trim() } : {}),
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23",
		});
	} catch {
		return undefined; // An unknown timezone is not a license to guess another timezone.
	}
	const today = new Date(wallTime(format, nowMs));
	today.setUTCHours(
		period ? (hour % 12) + (period === "pm" ? 12 : 0) : hour,
		minute,
		0,
		0,
	);
	for (let day = 0; day < 2; day++) {
		const target = today.getTime() + day * 86_400_000;
		let candidate = target;
		for (let iteration = 0; iteration < 4; iteration++)
			candidate += target - wallTime(format, candidate);
		// A repeated DST clock is ambiguous: use its later occurrence, never retry early.
		const matches = Array.from(
			{ length: 9 },
			(_, index) => candidate + (index - 4) * 1_800_000,
		).filter(
			(instant) => wallTime(format, instant) === target && instant > nowMs,
		);
		if (matches.length) return Math.max(...matches);
		// A nonexistent local clock (DST jump) is not a next-day hint.
		if (wallTime(format, candidate) !== target) return undefined;
	}
	return undefined;
}

export function providerRetryAfterMs(
	text: string,
	nowMs = Date.now(),
): number | undefined {
	const delays: number[] = [];
	const add = (value: number | undefined) => {
		const valid = positiveDelay(value ?? Number.NaN, nowMs);
		if (valid !== undefined) delays.push(valid);
	};
	for (const match of text.matchAll(
		/\b(?:retry[-_ ]?after\s*[:=]|try again in)\s*([^\r\n|]+)/giu,
	)) {
		const body = match[1]!;
		add(durationMs(body));
		const httpDate = body.match(
			/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT/iu,
		);
		if (httpDate) add(Date.parse(httpDate[0]) - nowMs);
	}
	for (const match of text.matchAll(
		/\bresets?(?:[_ -]?at)?["']?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/giu,
	))
		add(Date.parse(match[1]!) - nowMs);
	for (const match of text.matchAll(
		/\bresets?_at["']?\s*[:=]\s*["']?(\d{10}(?:\.\d+)?)(?!\d)/giu,
	))
		add(Number(match[1]) * 1000 - nowMs);
	for (const match of text.matchAll(
		/\bresets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([^)\r\n]{1,100})\))?/giu,
	))
		add((clockResetAt(match, nowMs) ?? Number.NaN) - nowMs);
	return delays.length ? Math.max(...delays) : undefined;
}
