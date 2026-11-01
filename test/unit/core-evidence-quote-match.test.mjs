// agent-workflow 2026-11-01: engine-side quote matching for web evidence. A quote must occur in
// the fetched page; only formatting may differ (Unicode/quote/dash forms, Markdown marks, spaces,
// math typesetting). Changed words, numbers, negation, order or merged words must never pass.
// Fixture: 103 quotes from recorded deep-research runs (Pi + Codex) that the re-fetch found on the
// cited page, each with a short window of that page's text.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	foldForMatch,
	hasMathNotation,
	matchQuote,
} from "../../dist/core/evidence-quote-match.js";
import { htmlToTextViews } from "../../dist/core/evidence-text-views.js";

const fixture = JSON.parse(
	await readFile(
		new URL("../fixtures/evidence/recorded-quote-pages.json", import.meta.url),
		"utf8",
	),
);

test("every recorded quote is found at its recorded level", () => {
	assert.ok(fixture.cases.length >= 100);
	for (const item of fixture.cases) {
		const match = matchQuote(item.quote, [item.page]);
		assert.equal(match.matched, true, item.quote);
		assert.equal(match.level, item.level, item.quote);
	}
});

// The same edits a careless or fabricating verifier would make.
function mutants(quote) {
	const out = [];
	const words = quote.split(/\s+/);
	const visible = [...quote.matchAll(/\d+(?:\.\d+)?/g)].find(
		(m) => !/\]\([^)]*$/.test(quote.slice(0, m.index)),
	);
	if (visible)
		out.push([
			"number",
			quote.slice(0, visible.index) +
				visible[0].replace(/\d(?=\D*$)/, (d) => String((Number(d) + 1) % 10)) +
				quote.slice(visible.index + visible[0].length),
		]);
	if (/\b(not|no|never)\b/i.test(quote))
		out.push(["negation removed", quote.replace(/\b(not|no|never)\s+/i, "")]);
	else if (/\b(is|are|was|were|can|does|do|will)\b/.test(quote))
		out.push([
			"negation added",
			quote.replace(/\b(is|are|was|were|can|does|do|will)\b/, "$1 not"),
		]);
	const content = words
		.map((word, index) => [word, index])
		.filter(([word]) => /^[A-Za-z]{4,}$/.test(word));
	if (content.length >= 2) {
		const [word, i] = content[Math.floor(content.length / 2)];
		const replaced = [...words];
		replaced[i] = word.slice(0, -1) + (word.endsWith("s") ? "d" : "s");
		out.push(["word replaced", replaced.join(" ")]);
		if (i > 0) {
			const swapped = [...words];
			[swapped[i - 1], swapped[i]] = [swapped[i], swapped[i - 1]];
			out.push(["words swapped", swapped.join(" ")]);
		}
		const deleted = [...words];
		deleted.splice(i, 1);
		out.push(["word deleted", deleted.join(" ")]);
		if (i + 1 < words.length) {
			const merged = [...words];
			merged.splice(i, 2, `${words[i]}${words[i + 1]}`);
			out.push(["words merged", merged.join(" ")]);
		}
	}
	return out.filter(([, text]) => text !== quote);
}

test("no mutated recorded quote passes (numbers, negation, words, order, merges)", () => {
	let tried = 0;
	const passed = [];
	for (const item of fixture.cases)
		for (const [kind, text] of mutants(item.quote)) {
			tried += 1;
			if (matchQuote(text, [item.page]).matched) passed.push({ kind, text });
		}
	assert.ok(tried >= 400, `only ${tried} mutants`);
	assert.deepEqual(passed, []);
});

test("formatting-only differences pass at the normalized level", () => {
	const page =
		"The **effective length** is the longest context where a model keeps at least 85% of its base score — see [the table](#t1).";
	for (const quote of [
		"The effective length is the longest context",
		"keeps at least 85% of its base score - see the table",
		"keeps  at least\n85% of its base score",
	])
		assert.equal(matchQuote(quote, [page]).level, "normalized", quote);
	assert.equal(
		matchQuote("it\u2019s a \u201cquote\u201d", ['it\'s a "quote"']).level,
		"normalized",
	);
	assert.equal(
		matchQuote("persists across sessions, subtly", [
			"persists across **sessions**, subtly",
		]).level,
		"normalized",
	);
});

test("math typesetting passes only for quotes with math notation", () => {
	// Browser/reader text of MathML puts every token in its own box.
	const spaced =
		"Consequently, 𝐿 𝑡 = { 𝑡 } ∪ top- ( 𝑛 − 1 ) 𝑡 . Overall, we remove the tool 𝑡 of query 𝑞 and 𝑡 ′ s most similar 𝑘 tools.";
	assert.equal(
		matchQuote("Consequently, Lₜ={t}∪top-(n-1)ₜ.", [spaced]).level,
		"math",
	);
	assert.equal(
		matchQuote(
			"we remove the tool $t$ of query $q$ and $t$’s most similar $k$ tools",
			[spaced],
		).level,
		"math",
	);
	assert.equal(
		matchQuote("Consequently, Lₜ={t}∪top-(n-2)ₜ.", [spaced]).matched,
		false,
	);
	assert.equal(
		matchQuote(
			"we remove the tool $t$ of query $q$ and $t$’s mostsimilar $k$ tools",
			[spaced],
		).matched,
		false,
	);
	// The same page as HTML: our extraction (no boxes) and the TeX view both work.
	const html =
		'<p>Consequently, <math alttext="L_{t}=\\{t\\}\\cup\\text{top-}(n-1)_{t}"><mi>𝐿</mi><mi>𝑡</mi><mo>=</mo><mo>{</mo><mi>𝑡</mi><mo>}</mo><mo>∪</mo><mtext>top-</mtext><mo>(</mo><mi>𝑛</mi><mo>−</mo><mn>1</mn><mo>)</mo><mi>𝑡</mi><annotation encoding="application/x-tex">L_{t}</annotation></math>.</p><p>excludes tool <math alttext="t"><mi>𝑡</mi></math> and its <math alttext="\\varnothing"><mi>∅</mi></math> set</p>';
	const { rendered, tex } = htmlToTextViews(html);
	assert.doesNotMatch(
		rendered,
		/L_\{t\}/,
		"TeX annotations are not reader text",
	);
	assert.equal(
		matchQuote("Consequently, Lₜ={t}∪top-(n-1)ₜ.", [rendered, tex]).matched,
		true,
	);
	assert.equal(
		matchQuote("excludes tool $t$ and its $\\varnothing$ set", [rendered, tex])
			.matched,
		true,
	);
	// Plain prose never gets the math level: words cannot merge or split.
	assert.equal(hasMathNotation("this is not able to run"), false);
	assert.equal(
		matchQuote("this is notable", ["this is not able to run"]).matched,
		false,
	);
	assert.equal(hasMathNotation("costs $5 and $3 per run"), false);
	assert.equal(hasMathNotation("the value $x$ grows"), true);
});

test("no edit-distance allowance: one changed character fails", () => {
	assert.equal(matchQuote("0123456ZZZ", ["0123456789"]).matched, false);
	assert.equal(
		matchQuote("accuracy fell to 73.6%", ["accuracy fell to 73.5%"]).matched,
		false,
	);
	assert.equal(matchQuote("", ["anything"]).matched, false);
	assert.equal(matchQuote("   ", ["anything"]).matched, false);
});

test("folding is idempotent", () => {
	for (const item of fixture.cases.slice(0, 40)) {
		const once = foldForMatch(item.page);
		assert.equal(foldForMatch(once), once);
	}
});
