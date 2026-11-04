# 워크플로 중지·취소 처리 명세

이 저장소의 `src/`는 워크플로 실행의 중지(stop)·취소(cancel) 처리와 종료 요약을 담당한다.
`store.js`, `types.js`는 이 발췌에 포함되지 않는다.

## 중지 감지 (`src/workflow-stop.ts`)

- **S1.** 실행 중지는 두 경로 중 하나라도 있으면 감지되어야 한다: (a) 디스크에 기록된 중지 의도
  (`readWorkflowStopIntent`), (b) 같은 실행(`workflowRunPath(cwd, runId)`)에 등록된 foreground
  `AbortSignal` 중 abort된 것.
- **S2.** 중지가 감지되면 신호는 이름이 `WorkflowStopRequested`인 오류로 abort되어야 하며, 메시지는
  `workflow stop requested for <runId>` 형식이다.
- **S3.** 중지 감시 주기(`pollMs`)의 기본값은 50ms이고, 호출자가 더 작은 값을 주어도 10ms보다
  짧아지면 안 된다.
- **S4.** 감시 경로(`createWorkflowStopSignal`)에서 디스크 읽기 실패는 중지로 간주하지 않는다.
  반면 `throwIfWorkflowStopRequested`에서는 읽기 오류가 호출자에게 그대로 전달되어야 한다.
- **S5.** `dispose()`를 호출한 뒤에는 새로운 디스크 읽기가 시작되지 않아야 한다.
- **S6.** `isWorkflowStopRequestedError`는 이름이 `WorkflowStopRequested`인 오류만 중지 오류로
  인정한다. 메시지 내용으로 판별해서는 안 된다.
- **S7.** foreground signal 등록은 해제 함수로 되돌릴 수 있어야 하며, 마지막 signal이 해제되면 그
  실행의 등록 항목이 남지 않아야 한다.

## 취소 판별 (`src/workflow-cancellation.ts`)

- **C1.** provider가 돌려준 값이 취소인지 판별할 때, 오류·사유 문자열은 정확히 `aborted`,
  `AbortError`, `ABORT_ERR` 세 가지만 취소로 인정한다. 다른 provider 오류를 취소로 승격해서는 안 된다.
- **C2.** `content` 배열 안의 텍스트가 JSON이면 그 내용도 같은 규칙으로 판별하되, 같은 값을 다시
  검사하는 무한 재귀가 없어야 한다.

## 종료 요약 (`src/workflow-terminal.ts`)

- **T1.** `completed` 실행에 degradation 기록이 있으면 의미 상태는 `completed_degraded`이다.
- **T2.** direct-dynamic 실행에서 controller의 `control.json`을 읽을 수 없으면 의미 상태는
  `completed_without_semantic_result`이다.
- **T3.** 요약의 `outputRetryAttempts`와 `launchRetryAttempts`는 모든 작업의 재시도 횟수 합이며,
  이 두 필드 이름은 공개 계약이다(외부 도구가 읽는다).

## 테스트

- **Q1.** 위 S·C·T 항목마다 그 동작을 확인하는 단위 테스트가 있어야 한다.
