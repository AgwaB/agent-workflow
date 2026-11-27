// Reader-only localization of partition diagnostics. Leave the canonical ledger,
// quoted evidence, and unknown/model-authored text unchanged.
const messages = new Map([
	["No final verifier claim was supplied; the item remains unresolved.", "최종 검증 주장이 없어 이 항목이 미해결 상태입니다."],
	["Reconcile the unresolved evidence and rerun the review.", "미해결 근거를 대조한 뒤 검토를 다시 실행하세요."],
	["The review could not establish a complete, source-backed disposition.", "출처에 근거한 최종 판정을 내리지 못했습니다."],
	["The origin, evidence, or verifier result is incomplete; no conformance claim is made.", "출처, 근거 또는 검증 결과가 불완전해 요구사항 충족 여부를 판단하지 않습니다."],
	["verifier result did not match any candidate finding id", "검증 결과가 어느 검토 후보 ID와도 일치하지 않습니다."],
	["The persisted candidate ledger is not proven to represent the runtime candidate control.", "저장된 후보 원장이 실제 실행의 후보 자료와 일치하는지 확인하지 못했습니다."],
	["Reconcile the candidate control and partition ledger, then rerun the review.", "후보 자료와 판정 원장을 대조한 뒤 검토를 다시 실행하세요."],
	["Reconcile the verifier row with a planned candidate identity.", "검증 항목을 계획된 후보 ID와 대조하세요."],
	["Reconcile the verifier batch before relying on the review.", "검토 결과를 사용하기 전에 일괄 검증 결과를 대조하세요."],
	["verifier result cannot be joined without an id", "ID가 없는 검증 결과는 후보와 연결할 수 없습니다."],
	["Provide the exact candidate id and rerun verification.", "정확한 후보 ID를 제공하고 검증을 다시 실행하세요."],
	["candidate finding did not receive a verifier result", "이 검토 후보에 대한 검증 결과가 없습니다."],
	["Obtain a verifier result for this candidate and rerun the review.", "이 후보의 검증 결과를 확보한 뒤 검토를 다시 실행하세요."],
	["verifier requested human review", "검증자가 사람의 검토를 요청했습니다."],
	["verifier dropped the finding", "검증자가 이 발견 사항을 제외했습니다."],
]);

const templates = [
	[/^Runtime candidate universe reconciliation failed: (.*)$/su, (detail) => `실행 후보 목록 대조에 실패했습니다: ${detail}`],
	[/^verifier batch integrity issue: (.*)$/su, (detail) => `일괄 검증 무결성 문제: ${detail}`],
	[/^verifier batch row did not match any candidate finding id \((.*)\)$/su, (detail) => `일괄 검증 항목과 일치하는 검토 후보 ID가 없습니다(${detail}).`],
	[/^invalid verifier verdict: (.*)$/su, (verdict) => `유효하지 않은 검증 판정: ${verdict}`],
	[/^Unverified (KEEP|WEAKEN): exact local byte evidence required$/u, (verdict) => `${verdict} 미검증: 저장소 원문과 정확히 일치하는 근거가 필요합니다.`],
	[/^Unverified (DROP): exact local byte evidence required in counterEvidence before removal$/u, (verdict) => `${verdict} 미검증: 제외하려면 저장소 원문과 정확히 일치하는 반증이 필요합니다.`],
];

export function readerDiagnostic(text, t) {
	if (typeof text !== "string" || !t(false, true)) return text;
	if (messages.has(text)) return messages.get(text);
	for (const [pattern, render] of templates) {
		const match = pattern.exec(text);
		if (match) return render(...match.slice(1));
	}
	return text;
}
