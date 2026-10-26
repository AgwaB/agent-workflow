<control>
{
  "schema": "stage-control-v1",
  "digest": "dedup: raw=7, unique=7, duplicates=0, partialFailures=0",
  "findings": [
    {
      "id": "finding-001",
      "findingId": "finding-001",
      "originalFindingId": "finding-001",
      "rootCauseId": "root-001",
      "generatedRootCauseId": true,
      "severity": "high",
      "originalSeverity": "high",
      "title": "Stop polling starts unbounded concurrent persistence reads",
      "file": "src/workflow-stop.ts",
      "locations": [
        {
          "file": "src/workflow-stop.ts",
          "line": 68,
          "lineEnd": 81,
          "symbol": "createWorkflowStopSignal"
        }
      ],
      "evidence": "Every interval invokes check without waiting for an earlier check. While an intent read remains unresolved, each subsequent tick starts another read for the same run; no in-flight guard or concurrency bound exists.",
      "evidenceQuotes": [
        "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);",
        "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);"
      ],
      "reviewerEvidenceQuotes": [
        "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);",
        "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);"
      ],
      "rationale": "Slow or stalled persistence causes pending reads and retained promises to accumulate for as long as the watcher remains active. This amplifies storage pressure precisely when cancellation depends on that storage and can exhaust resources or further delay stop propagation.",
      "recommendedAction": "Allow at most one durable intent read per watcher at a time. Continue checking foreground launch cancellation independently, including while that read is pending, so serialization does not make local cancellation wait for storage.",
      "confidence": "high",
      "source": "reviewers",
      "sourceLineage": [
        "reviewers"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers",
        "specId": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-002",
      "findingId": "finding-002",
      "originalFindingId": "finding-002",
      "rootCauseId": "root-002",
      "generatedRootCauseId": true,
      "severity": "medium",
      "originalSeverity": "medium",
      "title": "Disposing one binding can remove another owner's launch fence",
      "file": "src/workflow-stop.ts",
      "locations": [
        {
          "file": "src/workflow-stop.ts",
          "line": 14,
          "lineEnd": 20,
          "symbol": "bindWorkflowLaunchSignal"
        },
        {
          "file": "src/workflow-stop.ts",
          "line": 24,
          "lineEnd": 27,
          "symbol": "launchStopRequested"
        }
      ],
      "evidence": "Binding the same AbortSignal twice for one run creates only one Set entry but returns two cleanup functions. Calling either cleanup deletes the signal, even though the other binding is still active. An ensuing abort is invisible to launchStopRequested until a durable intent becomes readable.",
      "evidenceQuotes": [
        "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);",
        "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};",
        "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);"
      ],
      "reviewerEvidenceQuotes": [
        "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);",
        "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};",
        "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);"
      ],
      "rationale": "Registration lifetime is tracked by signal identity rather than binding ownership. Overlapping owners sharing a signal can therefore lose the synchronous fence that is meant to cover the durable-write window. Callers are absent, so the frequency of shared-signal registrations cannot be established.",
      "recommendedAction": "Give each binding a unique registration token, or reference-count registrations per signal. Make each returned cleanup function idempotent and remove only that binding's ownership.",
      "confidence": "high",
      "source": "reviewers",
      "sourceLineage": [
        "reviewers"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers",
        "specId": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-003",
      "findingId": "finding-003",
      "originalFindingId": "finding-003",
      "rootCauseId": "root-003",
      "generatedRootCauseId": true,
      "severity": "medium",
      "originalSeverity": "medium",
      "title": "An in-flight check can abort the signal after disposal",
      "file": "src/workflow-stop.ts",
      "locations": [
        {
          "file": "src/workflow-stop.ts",
          "line": 74,
          "lineEnd": 85,
          "symbol": "createWorkflowStopSignal"
        }
      ],
      "evidence": "The initial check can be awaiting readWorkflowStopIntent when dispose clears the interval. If that read subsequently returns an intent, execution resumes and aborts the returned signal; there is no disposed-state check after the await.",
      "evidenceQuotes": [
        "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
        "\t\tdispose: () => clearInterval(timer),"
      ],
      "reviewerEvidenceQuotes": [
        "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
        "\t\tdispose: () => clearInterval(timer),"
      ],
      "rationale": "Disposal stops future timer ticks but does not end cancellation notifications from work already launched. A retained abort listener can consequently run after the consumer has torn down this watcher or released its lifecycle ownership. Downstream listener effects are not available in this excerpt.",
      "recommendedAction": "Set a disposed flag synchronously in dispose and check it before polling and immediately after awaited reads, before aborting. Cancel or drain outstanding reads where supported.",
      "confidence": "medium",
      "source": "reviewers",
      "sourceLineage": [
        "reviewers"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers",
        "specId": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-004",
      "findingId": "finding-004",
      "originalFindingId": "finding-004",
      "rootCauseId": "root-004",
      "generatedRootCauseId": true,
      "severity": "medium",
      "originalSeverity": "medium",
      "title": "A rejected persistence read bypasses the post-read launch fence",
      "file": "src/workflow-stop.ts",
      "locations": [
        {
          "file": "src/workflow-stop.ts",
          "line": 93,
          "lineEnd": 98,
          "symbol": "throwIfWorkflowStopRequested"
        },
        {
          "file": "src/workflow-stop.ts",
          "line": 53,
          "lineEnd": 58,
          "symbol": "isWorkflowStopRequestedError"
        }
      ],
      "evidence": "If the launch signal aborts after the initial check and the pending intent read rejects, the await exits the function before the second launchStopRequested check. The caller receives the persistence error instead of WorkflowStopRequested despite an active local stop request.",
      "evidenceQuotes": [
        "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
        "\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))"
      ],
      "reviewerEvidenceQuotes": [
        "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
        "\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))"
      ],
      "rationale": "The race protection covers fulfilled reads only. An unrelated persistence error generally fails the stop-error classifier, so callers cannot reliably distinguish cancellation from operational failure during this race. Actual caller recovery behavior is unavailable.",
      "recommendedAction": "On read rejection, recheck the launch fence and throw WorkflowStopRequested if cancellation arrived; otherwise preserve the original persistence error. Do not indiscriminately swallow storage errors.",
      "confidence": "high",
      "source": "reviewers",
      "sourceLineage": [
        "reviewers"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers",
        "specId": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-005",
      "findingId": "finding-005",
      "originalFindingId": "finding-005",
      "rootCauseId": "root-005",
      "generatedRootCauseId": true,
      "severity": "medium",
      "originalSeverity": "medium",
      "title": "Ordinary provider content can be mistaken for workflow cancellation",
      "file": "src/workflow-cancellation.ts",
      "locations": [
        {
          "file": "src/workflow-cancellation.ts",
          "line": 23,
          "lineEnd": 29,
          "symbol": "isWorkflowReturnedCancellation"
        },
        {
          "file": "src/workflow-cancellation.ts",
          "line": 16,
          "lineEnd": 21,
          "symbol": "isWorkflowReturnedCancellation"
        }
      ],
      "evidence": "Every content entry with a string text field is JSON-decoded and recursively classified, without checking whether the enclosing response represents an error or a cancellation envelope. Consequently, normal provider output containing domain JSON such as {\"cancelled\":true,\"orderId\":\"123\"} is classified as workflow cancellation.",
      "evidenceQuotes": [
        "if (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
        "const parsed: unknown = JSON.parse(entry.text);",
        "if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;",
        "if (value.cancelled === true) return true;"
      ],
      "reviewerEvidenceQuotes": [
        "if (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
        "const parsed: unknown = JSON.parse(entry.text);",
        "if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;",
        "if (value.cancelled === true) return true;"
      ],
      "rationale": "Application data and provider cancellation metadata share the same interpretation here. A cancellation field describing an application entity can therefore become a workflow cancellation signal. Callers relying on this predicate could discard valid output or suppress diagnostics. The false-positive return is established by the implementation; downstream handling is not included in this excerpt.",
      "recommendedAction": "Make text-based cancellation recognition context-aware at the provider boundary. Decode cancellation text only in an identified cancellation/error envelope, preserving historical cancellation wrappers through explicit adapter mappings rather than treating arbitrary response content as authoritative metadata.",
      "confidence": "medium",
      "source": "reviewers.cancellation-classification",
      "sourceLineage": [
        "reviewers.cancellation-classification"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers.cancellation-classification",
        "specId": "reviewers.cancellation-classification",
        "taskId": "task-10",
        "itemIdentity": "cancellation-classification",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-006",
      "findingId": "finding-006",
      "originalFindingId": "finding-006",
      "rootCauseId": "root-006",
      "generatedRootCauseId": true,
      "severity": "medium",
      "originalSeverity": "medium",
      "title": "Stop-error matching accepts unrelated failures with a similar message prefix",
      "file": "src/workflow-stop.ts",
      "locations": [
        {
          "file": "src/workflow-stop.ts",
          "line": 53,
          "lineEnd": 58,
          "symbol": "isWorkflowStopRequestedError"
        },
        {
          "file": "src/workflow-stop.ts",
          "line": 43,
          "lineEnd": 50,
          "symbol": "createWorkflowStopRequestedError"
        }
      ],
      "evidence": "The message fallback accepts any Error whose message starts with \"workflow stop requested\", even when its name is not WorkflowStopRequested and its message does not match the generated \"workflow stop requested for <runId>\" format. For example, an ordinary Error with message \"workflow stop requested but persistence failed: EACCES\" returns true.",
      "evidenceQuotes": [
        "error instanceof Error &&",
        "(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||",
        "error.message.startsWith(\"workflow stop requested\"))",
        "return `workflow stop requested for ${runId}`;"
      ],
      "reviewerEvidenceQuotes": [
        "error instanceof Error &&",
        "(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||",
        "error.message.startsWith(\"workflow stop requested\"))",
        "return `workflow stop requested for ${runId}`;"
      ],
      "rationale": "A failure while requesting or processing a stop can be indistinguishable from the intentional stop sentinel. Consumers that use this classifier to suppress expected cancellation errors can consequently hide an operational failure. No consumer is supplied, so the downstream consequence remains unverified.",
      "recommendedAction": "Prefer the dedicated error name or another explicit sentinel. If legacy message-only errors must remain supported, constrain that fallback to their actual message format, preferably using the expected run ID, and avoid overriding conflicting typed errors. Preserve legitimate historical stop errors while rejecting similarly prefixed failure diagnostics.",
      "confidence": "high",
      "source": "reviewers.cancellation-classification",
      "sourceLineage": [
        "reviewers.cancellation-classification"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers.cancellation-classification",
        "specId": "reviewers.cancellation-classification",
        "taskId": "task-10",
        "itemIdentity": "cancellation-classification",
        "placeholderSpecId": "reviewers.item"
      }
    },
    {
      "id": "finding-007",
      "findingId": "finding-007",
      "originalFindingId": "finding-007",
      "rootCauseId": "root-007",
      "generatedRootCauseId": true,
      "severity": "high",
      "originalSeverity": "high",
      "title": "Preserve failed and interrupted outcomes before applying dynamic status overrides",
      "file": "src/workflow-terminal.ts",
      "locations": [
        {
          "file": "src/workflow-terminal.ts",
          "line": 80,
          "lineEnd": 95,
          "symbol": "summarizeWorkflowTerminal"
        },
        {
          "file": "src/workflow-terminal.ts",
          "line": 48,
          "lineEnd": 61,
          "symbol": "readDynamicControllerControl"
        },
        {
          "file": "src/workflow-terminal.ts",
          "line": 64,
          "lineEnd": 69,
          "symbol": "nonDynamicSemanticStatus"
        },
        {
          "file": "src/workflow-terminal.ts",
          "line": 98,
          "lineEnd": 102,
          "symbol": "summarizeWorkflowTerminal"
        }
      ],
      "evidence": "The dynamic override checks terminal status but never requires successful completion. Every branch replaces the semanticStatus initialized from run.status. Without a dynamic_incomplete marker, a failed or interrupted terminal run with missing controller output becomes completed_without_semantic_result; a synthesized controller artifact instead makes it synthesized. Missing controllers and control-file read failures explicitly return undefined, making the fallback reachable without any successful controller result.",
      "evidenceQuotes": [
        "\treturn run.status;",
        "\tif (!controller) return undefined;",
        "\t).catch(() => undefined);",
        "\tif (terminal && run.provenance?.mode === \"direct-dynamic\") {",
        "\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
        "\t\telse semanticStatus = \"completed_without_semantic_result\";",
        "\t\tengineStatus: run.status,"
      ],
      "reviewerEvidenceQuotes": [
        "\treturn run.status;",
        "\tif (!controller) return undefined;",
        "\t).catch(() => undefined);",
        "\tif (terminal && run.provenance?.mode === \"direct-dynamic\") {",
        "\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
        "\t\telse semanticStatus = \"completed_without_semantic_result\";",
        "\t\tengineStatus: run.status,"
      ],
      "rationale": "Cancellation before controller output exists and failures with unavailable controller artifacts lose their failed/interrupted semantic outcome. An existing synthesized artifact can also override those outcomes because controller success and artifact currency are not checked here. Although engineStatus remains accurate, consumers relying on semanticStatus receive a contradictory completion-labelled or successful-looking result and can misreport termination or omit recovery.",
      "recommendedAction": "Give failed and interrupted engine outcomes precedence over dynamic refinements. Restrict completion-derived semantic overrides to successfully completed runs, or explicitly define equivalent precedence rules. If controller details are useful for unsuccessful runs, expose them separately. Verify failed/interrupted summaries with absent, unreadable, and synthesized controller artifacts.",
      "confidence": "high",
      "source": "reviewers.terminal-semantics",
      "sourceLineage": [
        "reviewers.terminal-semantics"
      ],
      "sourceCoverageComplete": true,
      "sourceCoverageIssuePaths": [],
      "reviewerIdentity": {
        "source": "reviewers.terminal-semantics",
        "specId": "reviewers.terminal-semantics",
        "taskId": "task-11",
        "itemIdentity": "terminal-semantics",
        "placeholderSpecId": "reviewers.item"
      }
    }
  ],
  "coverageIssues": [],
  "reviewerLedger": {
    "plannedLensIds": [
      "stop-lifecycle",
      "cancellation-classification",
      "terminal-semantics"
    ],
    "materializedReviewerIds": [
      "stop-lifecycle",
      "cancellation-classification",
      "terminal-semantics"
    ],
    "attestedLensIds": [
      "stop-lifecycle",
      "cancellation-classification",
      "terminal-semantics"
    ],
    "materializedReviewerSourceIds": [
      "reviewers",
      "reviewers.cancellation-classification",
      "reviewers.terminal-semantics"
    ],
    "validAttestationSourceIds": [
      "reviewers",
      "reviewers.cancellation-classification",
      "reviewers.terminal-semantics"
    ],
    "ownerMap": [
      {
        "source": "reviewers",
        "specId": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item"
      },
      {
        "source": "reviewers.cancellation-classification",
        "specId": "reviewers.cancellation-classification",
        "taskId": "task-10",
        "itemIdentity": "cancellation-classification",
        "placeholderSpecId": "reviewers.item"
      },
      {
        "source": "reviewers.terminal-semantics",
        "specId": "reviewers.terminal-semantics",
        "taskId": "task-11",
        "itemIdentity": "terminal-semantics",
        "placeholderSpecId": "reviewers.item"
      }
    ],
    "invalidAttestations": [],
    "missingPlannedLensIds": [],
    "missingAttestedLensIds": [],
    "unexpectedMaterializedReviewerIds": [],
    "unexpectedAttestedLensIds": [],
    "duplicateMaterializedReviewerIds": [],
    "setEquality": true,
    "sourceStatuses": [
      {
        "source": "triage",
        "displayName": "triage.main",
        "taskId": "task-1",
        "specId": "triage.main",
        "stageId": "triage",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "reviewers",
        "displayName": "reviewers.stop-lifecycle",
        "taskId": "task-9",
        "specId": "reviewers.stop-lifecycle",
        "stageId": "reviewers",
        "itemIdentity": "stop-lifecycle",
        "placeholderSpecId": "reviewers.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "reviewers.cancellation-classification",
        "displayName": "reviewers.cancellation-classification",
        "taskId": "task-10",
        "specId": "reviewers.cancellation-classification",
        "stageId": "reviewers",
        "itemIdentity": "cancellation-classification",
        "placeholderSpecId": "reviewers.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "reviewers.terminal-semantics",
        "displayName": "reviewers.terminal-semantics",
        "taskId": "task-11",
        "specId": "reviewers.terminal-semantics",
        "stageId": "reviewers",
        "itemIdentity": "terminal-semantics",
        "placeholderSpecId": "reviewers.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      }
    ],
    "sourceCoverageFailures": [],
    "complete": true,
    "rawFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "dedupFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "validFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "invalidFindingIds": []
  },
  "rawFindingIds": [
    "finding-001",
    "finding-002",
    "finding-003",
    "finding-004",
    "finding-005",
    "finding-006",
    "finding-007"
  ],
  "dedupFindingIds": [
    "finding-001",
    "finding-002",
    "finding-003",
    "finding-004",
    "finding-005",
    "finding-006",
    "finding-007"
  ],
  "sourceStatusSummary": {
    "total": 4,
    "completed": 4,
    "nonCompleted": 0,
    "partialFailures": []
  },
  "dedupSummary": {
    "complete": true,
    "rawCount": 7,
    "uniqueCount": 7,
    "duplicateCount": 0,
    "rawFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "dedupFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "dispositionFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "supportFindingIds": [],
    "lineageFindingIds": [],
    "duplicates": []
  }
}
</control>
<analysis>
Support helper completed deterministically.
</analysis>
<refs>
[]
</refs>