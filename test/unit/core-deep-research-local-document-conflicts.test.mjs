// agent-workflow 2026-11-08 (K1 local documents): a worker records a local file's statement as a fact
// whose entity is the file and whose value is prose; it is compared under the entity its text names when
// the text states exactly one year-month. Recorded case: workflow_mw85l0zf_d796fd (notes.md misdates
// RFC 9000 and HTTP/3); 26 other recorded packets gain nothing.
import assert from "node:assert/strict";
import test from "node:test";

import {
	detectSlotConflicts,
	isLocalDocumentEntity,
} from "../../workflows/deep-research/helpers/slot-conflicts.mjs";

const external = [
	{
		id: "f-ext-1",
		slotId: "slot-001",
		entity: "RFC 9000",
		factType: "version",
		value: "RFC 9000, 2021년 5월 발행",
		dateOrYear: "2021-05",
		sourceUrls: ["https://www.rfc-editor.org/info/rfc9000/"],
	},
	{
		id: "f-ext-2",
		slotId: "slot-004",
		entity: "RFC 9114",
		factType: "version",
		value: "RFC 9114, 2022년 6월 발행",
		dateOrYear: "2022-06",
	},
];
const note = (value, extra = {}) => ({
	id: "f-note",
	slotId: "slot-001",
	entity: "notes.md",
	factType: "claim",
	value,
	dateOrYear: null,
	sourceRefs: ["local-notes-001"],
	...extra,
});
const detect = (facts) =>
	detectSlotConflicts({
		planSlots: [],
		extractedFacts: [...external, ...facts],
	});

test("a local document's misdated fact meets the external value of the entity it names", () => {
	const result = detect([
		note(
			"메모는 QUIC 버전 1 전송 RFC를 RFC 9000으로 지목하고 2022년 5월 발행이라고 주장한다.",
		),
	]);
	assert.equal(result.summary.localDocumentFacts, 1);
	assert.equal(result.summary.mappedLocalDocumentFacts, 1);
	assert.equal(result.conflicts.length, 1);
	const [conflict] = result.conflicts;
	assert.deepEqual(
		[conflict.slotId, conflict.entity, conflict.aspect],
		["slot-001", "RFC 9000", "date"],
	);
	assert.deepEqual(
		conflict.values.map((v) => [v.normalized, v.documents]),
		[
			["2021-05", []],
			["2022-05", ["notes.md"]],
		],
	);
});

test("a local document that agrees, or names the entity on another single slot, is compared there", () => {
	assert.equal(
		detect([note("메모는 RFC 9000이 2021년 5월에 발행되었다고 적었다.")])
			.conflicts.length,
		0,
	);
	const other = detect([
		note("메모는 HTTP/3 문서 RFC 9114의 발행을 2021년 6월로 적었다.", {
			slotId: "slot-099",
		}),
	]);
	assert.deepEqual(
		other.conflicts.map((c) => [c.slotId, c.entity]),
		[["slot-004", "RFC 9114"]],
	);
});

test("ambiguous or undated local statements are not compared", () => {
	const cases = {
		// the day the file was read, not a date it states (recorded: "2026-11-08" beside a note on RFC 9369)
		observationDateOnly: note(
			"로컬 메모는 RFC 9000을 QUIC 전송 문서로 기록한다.",
			{ dateOrYear: "2026-11-08" },
		),
		twoDates: note(
			"메모는 RFC 9000을 2022년 5월, RFC 9114를 2021년 6월로 적었다.",
		),
		noNamedEntity: note("메모는 2022년 5월에 작성되었다."),
		yearOnly: note("메모는 RFC 9000을 2022년 문서로 적었다."),
		namesTwoSlots: note(
			"메모는 RFC 9000과 RFC 9114를 2022년 5월 문서로 묶었다.",
			{ slotId: "slot-099" },
		),
		partialName: note("메모는 RFC 90001을 2022년 5월로 적었다."),
	};
	for (const [name, fact] of Object.entries(cases))
		assert.equal(detect([fact]).conflicts.length, 0, name);
});

test("a sentence naming two entities of one slot maps only when an observation names them as one subject", () => {
	// Review 2026-11-09: the date belongs to RFC 9114; giving it to RFC 9000 too invented a conflict.
	// Re-review: plan slot entities are comparison entities, not aliases — only the data can say two names
	// are one subject (an external observation whose entity names both, e.g. "RFC 9114 / HTTP/3").
	const facts = [
		{
			id: "e1",
			slotId: "slot-001",
			entity: "RFC 9000",
			factType: "version",
			value: "v",
			dateOrYear: "2021-05",
		},
		{
			id: "e2",
			slotId: "slot-001",
			entity: "RFC 9114",
			factType: "version",
			value: "v",
			dateOrYear: "2022-06",
		},
		note(
			"HTTP/3 (RFC 9114), which runs over QUIC (RFC 9000), was published in June 2022.",
		),
	];
	assert.equal(
		detectSlotConflicts({ extractedFacts: facts }).conflicts.length,
		0,
	);
	assert.equal(
		detectSlotConflicts({
			planSlots: [{ id: "slot-001", entities: ["RFC 9000", "RFC 9114"] }],
			extractedFacts: facts,
		}).conflicts.length,
		0,
		"plan entities do not make RFC 9000 and RFC 9114 one subject",
	);
	// recorded months run: an observation "RFC 9114 / HTTP/3" names both, so the note maps to both
	const aliases = detectSlotConflicts({
		extractedFacts: [
			{
				id: "e3",
				slotId: "slot-004",
				entity: "RFC 9114 / HTTP/3",
				factType: "version",
				value: "v",
				dateOrYear: "June 2022",
			},
			{
				id: "e4",
				slotId: "slot-004",
				entity: "RFC 9114",
				factType: "version",
				value: "v",
				dateOrYear: "2022-06",
			},
			{
				id: "e5",
				slotId: "slot-004",
				entity: "HTTP/3",
				factType: "scope",
				value: "v",
				dateOrYear: "2022",
			},
			note(
				"메모는 HTTP/3를 RFC 9114로 지목하고 2021년 6월 발행이라고 주장한다.",
				{ slotId: "slot-004" },
			),
		],
	});
	assert.deepEqual(aliases.conflicts.map((c) => c.entity).sort(), [
		"HTTP/3",
		"RFC 9114",
	]);
});

test("isLocalDocumentEntity: document file names, not dotted product names", () => {
	for (const entity of [
		"notes.md",
		"local notes.md",
		"docs/plan.yaml",
		"README.md",
	])
		assert.equal(isLocalDocumentEntity(entity), true, entity);
	for (const entity of ["Node.js", "RFC 9000", "HTTP/3", "v1.2", "example.com"])
		assert.equal(isLocalDocumentEntity(entity), false, entity);
});
