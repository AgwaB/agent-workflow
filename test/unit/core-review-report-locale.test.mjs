import assert from "node:assert/strict";
import test from "node:test";

for (const workflow of ["deep-review", "impact-review", "spec-review"]) {
	const { reviewReportLocale } = await import(
		`../../workflows/${workflow}/helpers/report-markdown.mjs`
	);
	test(`${workflow} ignores negated language directives and honors affirmative requests`, () => {
		for (const [task, prose, expected] of [
			[
				"Do not write the report in English; write the report in Korean.",
				"검토를 마쳤습니다.",
				"ko",
			],
			[
				"Do not write the report in Korean; write the report in English.",
				"검토를 마쳤습니다.",
				"en",
			],
			[
				"Don't write the report in English, write the report in Korean.",
				"Review completed.",
				"ko",
			],
			[
				"Never render the review in Korean; provide the summary in English.",
				"검토를 마쳤습니다.",
				"en",
			],
			[
				"Do not write the report in English; report language: Korean.",
				"Review completed.",
				"ko",
			],
			["Do not write the report in English.", "검토를 마쳤습니다.", "ko"],
			["Do not write the report in Korean.", "Review completed.", "en"],
			[
				"Do not modify files; write the report in Korean.",
				"Review completed.",
				"ko",
			],
		]) {
			assert.equal(reviewReportLocale(task, prose)("en", "ko"), expected, task);
		}
	});
}
