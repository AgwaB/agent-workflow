// Translate only known engine messages at the reader boundary. Machine diagnostics
// retain their original strings; interpolated paths, titles, and tokens are data.
const messages = new Map([
	["Untitled finding", "제목 없는 발견"],
	["Malformed devil-advocate verdict", "형식이 잘못된 검증 판정"],
	["Reviewer coverage", "검토 범위"],
	["explicit support classification", "명시적으로 보조 사항으로 분류됨"],
	["support-only repository path", "보조 자료 경로"],
	["required source content was not read", "필수 출처에 있는 내용을 읽지 못했습니다"],
	["planned coverage path is blank or whitespace-padded", "계획된 경로가 비어 있거나 앞뒤에 공백이 있습니다"],
	["planned coverage path is duplicated", "계획된 경로가 중복되었습니다"],
	["coverage row missing", "범위 확인 항목이 없습니다"],
	["coverage row duplicated", "범위 확인 항목이 중복되었습니다"],
	["unexpected coverage row", "계획에 없는 범위 확인 항목입니다"],
	["content quote missing", "인용문이 없습니다"],
	["multiple source ranges are unsupported; plan each range as a separate pointer", "여러 범위는 지원하지 않습니다. 각 범위를 별도로 계획하세요"],
	["required source pointer is invalid", "필수 출처의 위치가 유효하지 않습니다"],
	["required source path must be repository-relative within the runtime cwd; review other repositories separately", "필수 출처는 실행 디렉터리 안의 저장소 상대 경로여야 합니다. 다른 저장소는 따로 검토하세요"],
	["required source file is unavailable", "필수 출처 파일을 읽을 수 없습니다"],
	["required OCR source range is not valid UTF-8", "필수 OCR 출처 범위가 유효한 UTF-8이 아닙니다"],
	["required OCR source is too large to bind", "필수 OCR 출처가 너무 커 연결할 수 없습니다"],
	["OCR artifact missing", "OCR 자료가 없습니다"],
	["OCR artifact path is invalid", "OCR 자료 경로가 유효하지 않습니다"],
	["OCR artifact is unavailable", "OCR 자료를 읽을 수 없습니다"],
	["OCR source range is outside the artifact bounds", "OCR 출처 범위가 자료의 범위를 벗어납니다"],
	["OCR artifact is outside the trusted control-plane root", "OCR 자료가 신뢰할 수 있는 제어 디렉터리 밖에 있습니다"],
	["trusted OCR root contains a symlink or non-directory component", "신뢰할 수 있는 OCR 경로에 심볼릭 링크 또는 디렉터리가 아닌 항목이 있습니다"],
	["OCR artifact resolves outside the trusted control-plane root", "OCR 자료의 실제 경로가 신뢰할 수 있는 제어 디렉터리 밖에 있습니다"],
	["OCR artifact path contains a symlinked directory", "OCR 자료 경로에 심볼릭 링크 디렉터리가 있습니다"],
	["trusted OCR artifact path is unavailable", "신뢰할 수 있는 OCR 자료 경로를 확인할 수 없습니다"],
	["trusted OCR file must have exactly one link", "신뢰할 수 있는 OCR 파일에는 정확히 하나의 링크가 있어야 합니다"],
	["trusted OCR file must not be group- or world-writable", "신뢰할 수 있는 OCR 파일에 그룹 또는 다른 사용자의 쓰기 권한이 없어야 합니다"],
	["trusted OCR file must be owned by the current user", "신뢰할 수 있는 OCR 파일의 소유자는 현재 사용자여야 합니다"],
	["OCR source binding is unavailable", "OCR 출처 연결 기록이 없습니다"],
	["OCR source binding is not valid JSON", "OCR 출처 연결 기록이 유효한 JSON이 아닙니다"],
	["OCR source binding has invalid shape", "OCR 출처 연결 기록의 구조가 유효하지 않습니다"],
	["OCR source binding has invalid fields", "OCR 출처 연결 기록에 유효하지 않은 필드가 있습니다"],
	["required source is too large to verify", "필수 출처가 너무 커 검증할 수 없습니다"],
	["required source is not valid UTF-8", "필수 출처가 유효한 UTF-8이 아닙니다"],
	["required source range is outside the file", "필수 출처 범위가 파일을 벗어납니다"],
	["content quote was not found in required source range", "필수 출처의 해당 범위에서 인용문을 찾지 못했습니다"],
	["reviewer coverage was not attestable", "검토 범위를 확인할 수 없었습니다"],
	["no devil-advocate verdict received for this finding", "이 발견 사항에 대한 검증 판정이 없습니다"],
	["verdict lacked code-preserved locations or evidenceQuotes required for a reportable disposition", "판정에 필요한 위치 또는 근거 인용이 보존되지 않았습니다"],
	["verdict lacked independent verifier evidence required for a reportable disposition", "판정에 필요한 독립 검증 근거가 없습니다"],
	["verifier supplied no structured evidence rows", "검증자가 구조화된 근거를 제공하지 않았습니다"],
	["verifier evidence was not an array", "검증 근거가 배열이 아닙니다"],
]);
const templates = [
	[/^Support-only finding could not be conservatively associated with a material behavioral root \((.*)\); review it as a first-class item\.$/su, (reason) => `보조 발견 사항을 주요 동작 원인과 연결하지 못했습니다(${ko(reason)}). 독립 항목으로 검토하세요.`],
	[/^devil-advocate (batch )?integrity issue: (.*)$/su, (batch, detail) => `${batch ? "일괄 " : ""}검증 무결성 문제: ${detail}`],
	[/^verifier evidence was not grounded: (.*)$/su, (reason) => `검증 근거가 원문에서 확인되지 않았습니다: ${ko(reason)}`],
	[/^originating reviewer did not complete required source coverage(?:: (.*))?$/su, (paths) => `검토자가 필수 출처 검토를 마치지 못했습니다${paths ? `: ${paths}` : "."}`],
	[/^(.*:\d+) could not be read safely$/su, (location) => `${location}을 안전하게 읽을 수 없었습니다`],
	[/^(.*:\d+-\d+) did not contain the exact verifier quote$/su, (location) => `${location}에 검증자의 정확한 인용이 없습니다`],
	[/^(.*:\d+-\d+) is outside the file$/su, (location) => `${location}이 파일 범위를 벗어납니다`],
	[/^OCR source binding mismatched (\w+)$/u, (key) => `OCR 출처 연결 기록의 ${key} 값이 일치하지 않습니다`],
	[/^verifier evidence row (\d+) (was not an object|had unexpected fields|had invalid primitive types|had invalid file, line, or quote|had an invalid lineEnd)$/u,
		(index, issue) => `검증 근거 항목 ${index}: ${{"was not an object": "객체가 아님", "had unexpected fields": "예상하지 않은 필드", "had invalid primitive types": "유효하지 않은 원시 타입", "had invalid file, line, or quote": "유효하지 않은 파일, 줄 또는 인용", "had an invalid lineEnd": "유효하지 않은 lineEnd"}[issue]}`],
	[/^batch (KEEP|WEAKEN|DROP) (.*)$/su, (verdict, reason) => `일괄 ${verdict}: ${batchReasons.get(reason) ?? reason.replace(/^used non-concrete evidenceSourceType=/u, "구체적인 근거 유형이 아님: evidenceSourceType=")}`],
	[/^support finding "(.*)" moved out of findings \((.*)\) under "(.*)"$/su, (title, reason, root) => `보조 발견 사항 “${title}”을 “${root}” 아래로 옮겼습니다(${ko(reason)}).`],
	[/^support finding "(.*)" routed to NEEDS_HUMAN \((.*)\); no proven root association$/su, (title, reason) => `보조 발견 사항 “${title}”을 NEEDS_HUMAN으로 보냈습니다(${ko(reason)}). 연결된 원인이 확인되지 않았습니다.`],
	[/^compound root finding "(.*)" covered by narrower (keep|weaken) roots and merged as provenance$/su, (title, bucket) => `복합 원인 “${title}”을 더 구체적인 ${bucket} 항목의 출처 이력에 병합했습니다.`],
	[/^equivalent root finding "(.*)" merged into "(.*)" in (keep|weaken)$/su, (title, root, bucket) => `동일 원인 “${title}”을 ${bucket}의 “${root}”에 병합했습니다.`],
	[/^equivalent weakened root finding "(.*)" merged into keep finding "(.*)"$/su, (title, root) => `동일 원인의 완화 항목 “${title}”을 유지 항목 “${root}”에 병합했습니다.`],
	[/^devil-advocate integrity issue (\S+) for "(.*)" routed to NEEDS_HUMAN$/su, (code, title) => `검증 무결성 문제(${code})로 “${title}”을 NEEDS_HUMAN으로 보냈습니다.`],
	[/^unrecognized verdict (.*) for "(.*)" routed to NEEDS_HUMAN$/su, (verdict, title) => `인식할 수 없는 판정 ${verdict} 때문에 “${title}”을 NEEDS_HUMAN으로 보냈습니다.`],
	[/^verdict "(.*)" normalized to (\w+) for "(.*)"$/su, (verdict, normalized, title) => `“${title}”의 판정 ${verdict}을 ${normalized}(으)로 정규화했습니다.`],
	[/^legacy recommendedAction for (.*) normalized from (\w+) to canonical JSON text$/su, (title, type) => `${title}의 이전 recommendedAction을 ${type}에서 정규 JSON 텍스트로 바꿨습니다.`],
	[/^verdict for "(.*)" (came from incomplete source coverage|had ungrounded verifier evidence|lacked grounding evidence); routed to NEEDS_HUMAN instead of (\w+)$/su,
		(title, reason, verdict) => `“${title}”: ${{"came from incomplete source coverage": "출처 검토가 불완전함", "had ungrounded verifier evidence": "검증 근거가 원문에서 확인되지 않음", "lacked grounding evidence": "원문 근거가 부족함"}[reason]}. ${verdict} 대신 NEEDS_HUMAN으로 보냈습니다.`],
	[/^verifier evidence for "(.*)" matched (.*) except whitespace or quote\/dash characters; the file text was stored$/su, (title, location) => `“${title}”의 근거가 공백 또는 인용 부호·대시를 제외하고 ${location}과 일치해 파일 원문을 저장했습니다.`],
	[/^verifier evidence for "(.*)" cited (.*); the exact quote occurs once, at (.*); line corrected$/su, (title, cited, actual) => `“${title}”의 근거 위치 ${cited}을 ${actual}(으)로 보정했습니다. 정확한 인용이 그곳에만 있습니다.`],
	[/^batched (\w+) for "(.*)" routed to NEEDS_HUMAN: (.*)$/su, (verdict, title, reason) => `일괄 판정 ${verdict}의 “${title}”을 NEEDS_HUMAN으로 보냈습니다: ${ko(reason)}`],
	[/^reviewer coverage issue for "(.*)" routed to NEEDS_HUMAN$/su, (source) => `“${source}”의 검토 범위 문제를 NEEDS_HUMAN으로 보냈습니다.`],
	[/^reviewer finding "(.*)" had no verdict; routed to NEEDS_HUMAN$/su, (title) => `“${title}”에 검증 판정이 없어 NEEDS_HUMAN으로 보냈습니다.`],
];
const batchReasons = new Map([
	["lacked exact row-local contextPacket refs or supplied unverified counterEvidence", "해당 항목의 정확한 contextPacket 참조가 없거나 반증을 검증할 수 없습니다"],
	["lacked concrete context to rule out finding", "발견 사항을 제외할 구체적인 맥락이 없습니다"],
	["did not cite row-local contextPacket evidence", "해당 항목의 contextPacket 근거를 인용하지 않았습니다"],
	["lacked evidence or counterEvidence", "evidence 또는 counterEvidence가 없습니다"],
	["had missing-context counterEvidence without concrete_artifact evidence", "맥락 누락을 나타내는 counterEvidence만 있고 concrete_artifact 근거가 없습니다"],
	["lacked planned concrete contextPacket evidence", "계획된 구체적인 contextPacket 근거가 없습니다"],
	["lacked non-empty evidence", "비어 있지 않은 근거가 필요합니다"],
]);

function ko(text) {
	if (messages.has(text)) return messages.get(text);
	for (const [pattern, render] of templates) {
		const match = pattern.exec(text);
		if (match) return render(...match.slice(1));
	}
	return text;
}

export function readerDiagnostic(text, t) {
	return typeof text === "string" && t(false, true) ? ko(text) : text;
}

export function readerCoverageDetail(gap, t) {
	if (!t(false, true) || !Array.isArray(gap.coverageIssues)) return gap.statusDetail;
	const issues = gap.coverageIssues.filter((row) =>
		typeof row?.path === "string" && typeof row.status === "string" && typeof row.reason === "string");
	if (!issues.length) return gap.statusDetail;
	const details = issues.map(({ path, status, reason }) =>
		`${path}: ${status} (${messages.get(reason) ?? reason})`).join("; ");
	return `${gap.coverageReviewer || gap.displayName || gap.specId || gap.source || "unknown"}: ${details}`;
}
