// 2026-11-08 (context-quality backlog K1): deterministic conflict detection on structured fact-slot
// data. Research-question workers report extractedFacts per plan slot; when two observations of the
// same slot and entity carry different structured values (a date, or a short numeric value) the slot
// is contested: the normalizer must route it to verification and the final packet keeps the slot
// `conflicting` until a verified claim states one of the values. Free-text values are never compared:
// on recorded runs 100 of 271 (slot, factType) groups had textually different prose values and none
// of them was a real conflict.
//
// 2026-11-08 (K1 local documents): a worker records a local file's statement as a fact whose entity is
// the file ("notes.md") with the value in prose ("메모는 … RFC 9000 … 2022년 5월 발행이라고 주장한다"), so it
// never shared a (slot, entity) group with the external observation. Such a fact is compared under the
// entity its text names when the text states exactly one year-month and names entities of one slot.
import { asArray, stringOf } from "./source-access.mjs";

export const SLOT_CONFLICTS_SCHEMA = "deep-research-slot-conflicts-v1";

const MONTHS = new Map(
	[
		["january", 1],
		["jan", 1],
		["february", 2],
		["feb", 2],
		["march", 3],
		["mar", 3],
		["april", 4],
		["apr", 4],
		["may", 5],
		["june", 6],
		["jun", 6],
		["july", 7],
		["jul", 7],
		["august", 8],
		["aug", 8],
		["september", 9],
		["sep", 9],
		["sept", 9],
		["october", 10],
		["oct", 10],
		["november", 11],
		["nov", 11],
		["december", 12],
		["dec", 12],
	],
);
const MONTH_NAME = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
// A whole-string date: 2021, 2021-05, 2021-05-27, 2021/05, May 2021, 27 May 2021, May 27, 2021,
// 2021년 5월(27일). Ranges, lists and qualifiers ("2024 snapshot") do not parse.
const DATE_PATTERNS = [
	{
		re: /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/,
		pick: (m) => ({ year: m[1], month: m[2] }),
	},
	{
		re: new RegExp(`^(?:\\d{1,2}\\s+)?${MONTH_NAME}\\.?\\s*(?:\\d{1,2},?\\s+)?(\\d{4})$`, "i"),
		pick: (m) => ({ year: m[2], month: MONTHS.get(m[1].toLowerCase()) }),
	},
	{
		re: /^(\d{4})\s*년(?:\s*(\d{1,2})\s*월(?:\s*\d{1,2}\s*일)?)?$/,
		pick: (m) => ({ year: m[1], month: m[2] }),
	},
];

/** `{ year, month? }` for a whole-string date, else null. */
export function parseStructuredDate(value) {
	const text = stringOf(value)?.trim();
	if (!text) return null;
	for (const { re, pick } of DATE_PATTERNS) {
		const match = re.exec(text);
		if (!match) continue;
		const picked = pick(match);
		const year = Number(picked.year);
		const month = picked.month === undefined ? undefined : Number(picked.month);
		if (!Number.isInteger(year) || year < 1000 || year > 2999) return null;
		if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12))
			return null;
		return month === undefined ? { year } : { year, month };
	}
	return null;
}

/** Dates found anywhere in free text (claim text), for resolution checks. */
export function structuredDatesIn(text) {
	const value = stringOf(text);
	if (!value) return [];
	const found = [];
	const patterns = [
		/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g,
		new RegExp(`\\b${MONTH_NAME}\\.?\\s+(?:\\d{1,2},?\\s+)?(\\d{4})\\b`, "gi"),
		/(\d{4})\s*년\s*(\d{1,2})\s*월/g,
	];
	for (const [index, re] of patterns.entries()) {
		for (const match of value.matchAll(re)) {
			const parsed =
				index === 1
					? parseStructuredDate(`${match[1]} ${match[2]}`)
					: parseStructuredDate(`${match[1]}-${match[2]}`);
			if (parsed) found.push(parsed);
		}
	}
	return found;
}

const NUMERIC_FACT_TYPES = new Set([
	"numeric",
	"number",
	"count",
	"quantity",
	"price",
	"pricing",
	"cost",
	"limit",
	"ttl",
	"size",
	"percentage",
	"percent",
	"rate",
	"measurement",
	"duration",
	"amount",
]);
const MAX_NUMERIC_SCALAR_CHARS = 40;

/** Numeric tokens of a short scalar value (`"RFC 9000"` → `["9000"]`), else null when not structured. */
export function numericTokensOfScalar(value) {
	if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
	const text = stringOf(value)?.trim();
	if (!text || text.length > MAX_NUMERIC_SCALAR_CHARS) return null;
	const tokens = [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) =>
		m[0].replace(/,/g, ""),
	);
	return tokens.length > 0 ? [...new Set(tokens)] : null;
}

export function numericTokensIn(text) {
	const value = stringOf(text);
	if (!value) return [];
	return [...new Set([...value.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,/g, "")))];
}

const formatDate = (date) =>
	date.month === undefined
		? String(date.year)
		: `${date.year}-${String(date.month).padStart(2, "0")}`;

function datesConflict(left, right) {
	if (left.year !== right.year) return true;
	return (
		left.month !== undefined && right.month !== undefined && left.month !== right.month
	);
}

const normalizeEntity = (value) =>
	(stringOf(value) ?? "")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, " ")
		.trim();

/**
 * The words around a short scalar's numbers ("RFC 9000" → "rfc", "50%" → "percent", "1 MB" → "mb").
 * Approximation words are not a unit ("about 500 ms" compares with "700 ms"; re-review 2026-11-09);
 * bound words ("at least", "up to") stay, since a bound does not contradict a value inside it.
 */
function unitOfScalar(value) {
	return normalizeEntity(
		String(value ?? "")
			.toLowerCase()
			.replace(/%/g, " percent ")
			.replace(/~|≈|\b(?:about|approx|approximately|roughly|around|circa|ca|nearly)\b|약|대략|거의/gu, " ")
			.replace(/\d+(?:[.,]\d+)*/g, " "),
	);
}

function isNumericFactType(factType) {
	return NUMERIC_FACT_TYPES.has((stringOf(factType) ?? "").toLowerCase());
}

/**
 * Structured observation of one extracted fact: its date (from dateOrYear, or the value when the
 * fact type is a date) and, for numeric fact types with a short scalar value, its numeric tokens.
 */
function observe(fact) {
	const factType = (stringOf(fact.factType) ?? "").toLowerCase();
	const date =
		parseStructuredDate(fact.dateOrYear) ??
		(factType === "date" ? parseStructuredDate(fact.value) : null);
	const numbers = isNumericFactType(factType) ? numericTokensOfScalar(fact.value) : null;
	return { date, numbers };
}

function sourceOf(fact) {
	return {
		documents: [stringOf(fact.localDocument)].filter(Boolean),
		factIds: [fact.id].filter(Boolean),
		sourceIds: [fact.sourceId].filter(Boolean),
		sourceTypes: [stringOf(fact.sourceType)].filter(Boolean),
		sourceUrls: asArray(fact.sourceUrls).map(stringOf).filter(Boolean),
		sourceRefs: asArray(fact.sourceRefs).map(stringOf).filter(Boolean),
		files: [stringOf(fact.file)].filter(Boolean),
		sourceQualities: [stringOf(fact.sourceQuality)].filter(Boolean),
	};
}

function mergeSource(target, source) {
	for (const key of Object.keys(source)) {
		target[key] = [...new Set([...(target[key] ?? []), ...source[key]])];
	}
	return target;
}

function groupValues(facts, keyOf, formatOf) {
	const byValue = new Map();
	for (const fact of facts) {
		const key = keyOf(fact);
		if (key === null) continue;
		const entry = byValue.get(key) ?? { normalized: formatOf(fact), raw: [], ...sourceOf({}) };
		const raw = stringOf(fact.dateOrYear) ?? stringOf(fact.value);
		if (raw && !entry.raw.includes(raw)) entry.raw.push(raw);
		mergeSource(entry, sourceOf(fact));
		byValue.set(key, entry);
	}
	return byValue;
}

const LOCAL_DOCUMENT =
	/(?:^|[\s/"'(])[\w.-]+\.(?:md|markdown|txt|rst|adoc|json|ya?ml|toml|csv|tsv|html?|xml|ini|cfg|log)(?=$|[\s)"',;:])/i;

/** Whether an entity names a local document (`notes.md`, `docs/plan.yaml`) rather than a subject. */
export function isLocalDocumentEntity(entity) {
	return LOCAL_DOCUMENT.test(stringOf(entity) ?? "");
}

/**
 * Whether `text` names `entity` as a whole name (normalized; not "http 3" in "http 30"). Names shorter
 * than `minLength` never match (free prose uses 3; a resolver bound to a known entity may use 1 so "Go"
 * can match — re-review 2026-11-09).
 */
export function textNamesEntity(text, entity, minLength = 3) {
	return namesEntity(normalizeEntity(text), normalizeEntity(entity), minLength);
}

/** Whether a normalized name occurs in normalized text as a whole name (not "http 3" in "http 30"). */
function namesEntity(text, name, minLength = 3) {
	if (!name || name.length < minLength) return false;
	let from = 0;
	for (;;) {
		const at = text.indexOf(name, from);
		if (at < 0) return false;
		const before = at === 0 ? " " : text[at - 1];
		const after = text[at + name.length] ?? " ";
		if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
		from = at + 1;
	}
}

/**
 * Whether an entity label is just these names written as one subject ("RFC 9114 / HTTP/3",
 * "HTTP/3 (RFC 9114)"): nothing but the names, slashes, parentheses and punctuation that is part of a
 * name. A comparison or a list ("RFC 9000 vs RFC 9114", "QUIC, HTTP/3", "RFC 9000·RFC 9114",
 * "RFC 9000–RFC 9114") only says they occur together (round-3 and round-4 reviews, gpt-6-astra).
 */
function isAliasLabel(label, targets) {
	const punctuation = (text) => new Set(text.match(/[\p{P}\p{S}]/gu) ?? []);
	const allowed = new Set(["/", "(", ")"]);
	for (const target of targets) for (const mark of punctuation(target.entity)) allowed.add(mark);
	if ([...punctuation(label)].some((mark) => !allowed.has(mark))) return false;
	let rest = ` ${normalizeEntity(label)} `;
	for (const name of targets.map((target) => target.name).sort((a, b) => b.length - a.length)) {
		if (!rest.includes(` ${name} `)) return false;
		rest = rest.split(` ${name} `).join(" ");
	}
	return rest.trim() === "";
}

/**
 * A local-document fact restated under the entity its text names: one year-month in its value
 * text, and named entities that have dated observations — on the fact's own slot first,
 * else on exactly one other slot. Anything ambiguous stays unmapped.
 */
function mappedLocalDocumentFacts(facts) {
	// Several named entities are one target only when the data says they are one subject: an external
	// observation on that slot whose entity is an alias label of them all ("RFC 9114 / HTTP/3"). Review
	// 2026-11-09: a sentence naming RFC 9114 and RFC 9000 gave its date to both; re-review: plan slot
	// entities are comparison entities, not aliases; round 3: so is "RFC 9000 vs RFC 9114".
	const entityLabelsBySlot = new Map();
	for (const fact of facts) {
		const slotId = stringOf(fact.slotId);
		const label = stringOf(fact.entity);
		if (!slotId || !label || isLocalDocumentEntity(fact.entity)) continue;
		entityLabelsBySlot.set(slotId, [...(entityLabelsBySlot.get(slotId) ?? []), label]);
	}
	const datedGroups = new Map();
	for (const fact of facts) {
		const slotId = stringOf(fact.slotId);
		if (!slotId || slotId === "unslotted" || isLocalDocumentEntity(fact.entity)) continue;
		if (!observe(fact).date) continue;
		const name = normalizeEntity(fact.entity);
		if (name) datedGroups.set(`${slotId}\u0000${name}`, { slotId, entity: stringOf(fact.entity), name });
	}
	const mapped = [];
	let localFacts = 0;
	for (const fact of facts) {
		if (!isLocalDocumentEntity(fact.entity)) continue;
		localFacts += 1;
		// Only a date the document's statement itself carries: a local fact's dateOrYear is often the day
		// the file was read (a recorded run: "2026-11-08" beside a note about RFC 9369).
		const text = stringOf(fact.value) ?? "";
		const dates = new Map(
			structuredDatesIn(text)
				.filter((date) => date.month !== undefined)
				.map((date) => [formatDate(date), date]),
		);
		if (dates.size !== 1) continue;
		const normalized = normalizeEntity(text);
		const named = [...datedGroups.values()].filter((group) => namesEntity(normalized, group.name));
		const ownSlot = stringOf(fact.slotId);
		const sameSlot = named.filter((group) => group.slotId === ownSlot);
		const targets = sameSlot.length > 0 ? sameSlot : named;
		if (targets.length === 0 || new Set(targets.map((group) => group.slotId)).size !== 1) continue;
		if (
			targets.length > 1 &&
			!(entityLabelsBySlot.get(targets[0].slotId) ?? []).some((label) =>
				isAliasLabel(label, targets),
			)
		)
			continue;
		const [date] = dates.values();
		for (const target of targets)
			mapped.push({
				...fact,
				slotId: target.slotId,
				entity: target.entity,
				factType: "date",
				dateOrYear: formatDate(date),
				localDocument: stringOf(fact.entity),
			});
	}
	return { mapped, localFacts };
}

/**
 * Contested (slot, entity) groups among compacted extracted facts. Facts without a slot, with an
 * unparseable date or a non-scalar numeric value, or whose entity text differs, are not compared.
 */
export function detectSlotConflicts({ planSlots = [], extractedFacts = [] } = {}) {
	const labelBySlot = new Map(
		asArray(planSlots).map((slot) => [stringOf(slot.id) ?? stringOf(slot.slotId), stringOf(slot.label)]),
	);
	const groups = new Map();
	const local = mappedLocalDocumentFacts(asArray(extractedFacts));
	for (const fact of [...asArray(extractedFacts), ...local.mapped]) {
		const slotId = stringOf(fact.slotId);
		if (!slotId || slotId === "unslotted") continue;
		const key = `${slotId}\u0000${normalizeEntity(fact.entity)}`;
		const group = groups.get(key) ?? { slotId, entity: stringOf(fact.entity) ?? "", facts: [] };
		group.facts.push({ ...fact, observation: observe(fact) });
		groups.set(key, group);
	}
	const conflicts = [];
	let comparedGroups = 0;
	for (const group of groups.values()) {
		const dated = group.facts.filter((fact) => fact.observation.date);
		if (dated.length >= 2) {
			comparedGroups += 1;
			const values = groupValues(
				dated,
				(fact) => formatDate(fact.observation.date),
				(fact) => formatDate(fact.observation.date),
			);
			const dates = [...values.values()].map((entry) => parseStructuredDate(entry.normalized));
			if (dates.some((left, i) => dates.some((right, j) => j > i && datesConflict(left, right)))) {
				conflicts.push({ slotId: group.slotId, entity: group.entity, aspect: "date", values: [...values.values()] });
			}
		}
		// Numbers are compared only between values written with the same unit words: "1 MB" and
		// "1024 KB", or "2 weeks" and "14 days", are one value in different units (review 2026-11-09).
		const byUnit = new Map();
		for (const fact of group.facts.filter((fact) => fact.observation.numbers)) {
			const unit = unitOfScalar(fact.value);
			byUnit.set(unit, [...(byUnit.get(unit) ?? []), fact]);
		}
		for (const numbered of byUnit.values()) {
			if (numbered.length < 2) continue;
			comparedGroups += 1;
			const values = groupValues(
				numbered,
				(fact) => fact.observation.numbers.join(","),
				(fact) => fact.observation.numbers.join(","),
			);
			const sets = [...values.values()].map((entry) => new Set(entry.normalized.split(",")));
			const disjoint = (a, b) => [...a].every((token) => !b.has(token));
			if (sets.some((left, i) => sets.some((right, j) => j > i && disjoint(left, right)))) {
				conflicts.push({ slotId: group.slotId, entity: group.entity, aspect: "number", values: [...values.values()] });
			}
		}
	}
	conflicts.sort((a, b) => a.slotId.localeCompare(b.slotId) || a.entity.localeCompare(b.entity) || a.aspect.localeCompare(b.aspect));
	return {
		schema: SLOT_CONFLICTS_SCHEMA,
		summary: {
			comparedGroups,
			localDocumentFacts: local.localFacts,
			mappedLocalDocumentFacts: local.mapped.length,
			conflictCount: conflicts.length,
			contestedSlotIds: [...new Set(conflicts.map((conflict) => conflict.slotId))],
		},
		conflicts: conflicts.map((conflict, index) => ({
			id: `conflict-${String(index + 1).padStart(3, "0")}`,
			slotId: conflict.slotId,
			label: labelBySlot.get(conflict.slotId),
			entity: conflict.entity,
			aspect: conflict.aspect,
			values: conflict.values,
			action: "route_to_verifier",
		})),
	};
}

/**
 * Collapses values that do not contradict each other: a year and a year-month of that year are one
 * date (the year-month is kept), so a claim "May 2021" matching both "2021" and "2021-05" states one
 * value (re-review 2026-11-09). Numbers are compared as given.
 */
export function collapseCompatibleValues(aspect, values) {
	const unique = [...new Set(asArray(values))];
	if (aspect !== "date") return unique;
	const parsed = unique.map((value) => ({ value, date: parseStructuredDate(value) }));
	return parsed
		.filter(
			({ value, date }) =>
				!date ||
				date.month !== undefined ||
				!parsed.some(
					(other) => other.value !== value && other.date?.year === date.year && other.date?.month !== undefined,
				),
		)
		.map(({ value }) => value);
}

/**
 * Whether a claim's text states one of a conflict's values: for dates, a date in the text matches a
 * value (year, and month when both have one); for numbers, a numeric token of a value appears.
 * Returns the matching normalized values.
 */
export function valuesStatedBy(conflict, claimText) {
	const stated = [];
	for (const entry of asArray(conflict.values)) {
		if (conflict.aspect === "date") {
			const target = parseStructuredDate(entry.normalized);
			if (
				target &&
				structuredDatesIn(claimText).some(
					(date) =>
						date.year === target.year &&
						(target.month === undefined || date.month === target.month),
				)
			)
				stated.push(entry.normalized);
		} else {
			const tokens = new Set(numericTokensIn(claimText));
			if (entry.normalized.split(",").some((token) => tokens.has(token))) stated.push(entry.normalized);
		}
	}
	return stated;
}
