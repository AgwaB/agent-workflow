<control>
{
  "schema": "stage-control-v1",
  "digest": "partition: keep=7, weaken=0, drop=0, needsHuman=0, missingVerdicts=0, partialFailures=0, supportNotes=0, ledgerDigest=5004011687047a8df835b801591b44d8fdcf44534536d90194bf483c00f086b4",
  "partitions": {
    "keep": [
      {
        "findingId": "finding-001",
        "originalFindingId": "finding-001",
        "rootCauseId": "root-001",
        "title": "Stop polling starts unbounded concurrent persistence reads",
        "originalSeverity": "high",
        "source": "reviewers",
        "reviewerIdentity": {
          "source": "reviewers",
          "specId": "reviewers.stop-lifecycle",
          "taskId": "task-9",
          "itemIdentity": "stop-lifecycle",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "high",
        "file": "src/workflow-stop.ts",
        "locations": [
          {
            "file": "src/workflow-stop.ts",
            "line": 68,
            "lineEnd": 81,
            "symbol": "createWorkflowStopSignal"
          }
        ],
        "reviewerEvidenceQuotes": [
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);"
        ],
        "evidenceQuotes": [
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);",
          "\tconst pollMs = Math.max(10, options.pollMs ?? 50);",
          "\tconst check = async (): Promise<void> => {\n\t\tif (controller.signal.aborted) return;\n\t\tif (launchStopRequested(cwd, runId)) {\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));\n\t\t\treturn;\n\t\t}\n\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();",
          "\t\tdispose: () => clearInterval(timer),"
        ],
        "evidence": [
          {
            "file": "src/workflow-stop.ts",
            "line": 67,
            "symbol": "createWorkflowStopSignal",
            "quote": "\tconst pollMs = Math.max(10, options.pollMs ?? 50);"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 68,
            "lineEnd": 78,
            "symbol": "createWorkflowStopSignal",
            "quote": "\tconst check = async (): Promise<void> => {\n\t\tif (controller.signal.aborted) return;\n\t\tif (launchStopRequested(cwd, runId)) {\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));\n\t\t\treturn;\n\t\t}\n\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 80,
            "lineEnd": 82,
            "symbol": "createWorkflowStopSignal",
            "quote": "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 85,
            "symbol": "createWorkflowStopSignal",
            "quote": "\t\tdispose: () => clearInterval(timer),"
          }
        ],
        "rationale": "Slow or stalled persistence causes pending reads and retained promises to accumulate for as long as the watcher remains active. This amplifies storage pressure precisely when cancellation depends on that storage and can exhaust resources or further delay stop propagation.",
        "verifierEvidence": [
          "\tconst pollMs = Math.max(10, options.pollMs ?? 50);",
          "\tconst check = async (): Promise<void> => {\n\t\tif (controller.signal.aborted) return;\n\t\tif (launchStopRequested(cwd, runId)) {\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));\n\t\t\treturn;\n\t\t}\n\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();",
          "\t\tdispose: () => clearInterval(timer),"
        ],
        "counterEvidence": [
          "The aborted-signal guard and foreground launch check prevent further reads once cancellation is observed. Thus storage stalls do not inherently prevent foreground cancellation detection.",
          "Disposal clears the interval, limiting future starts to the watcher's active lifetime. It does not bound outstanding reads before disposal."
        ],
        "recommendedAction": "Permit only one outstanding intent read per watcher, while checking foreground launch cancellation before the in-flight guard. Add a deferred-read regression test covering repeated ticks and local cancellation before that read settles.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate",
          "specId": "devil-advocate.finding-001",
          "taskId": "task-12",
          "itemIdentity": "finding-001",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-002",
        "originalFindingId": "finding-002",
        "rootCauseId": "root-002",
        "title": "Disposing one binding can remove another owner's launch fence",
        "originalSeverity": "medium",
        "source": "reviewers",
        "reviewerIdentity": {
          "source": "reviewers",
          "specId": "reviewers.stop-lifecycle",
          "taskId": "task-9",
          "itemIdentity": "stop-lifecycle",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "medium",
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
        "reviewerEvidenceQuotes": [
          "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);",
          "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};",
          "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);"
        ],
        "evidenceQuotes": [
          "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);",
          "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};",
          "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);",
          "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);\n\tlaunchSignals.set(key, signals);",
          "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);"
        ],
        "evidence": [
          {
            "file": "src/workflow-stop.ts",
            "line": 14,
            "lineEnd": 16,
            "symbol": "bindWorkflowLaunchSignal",
            "quote": "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);\n\tlaunchSignals.set(key, signals);"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 17,
            "lineEnd": 21,
            "symbol": "bindWorkflowLaunchSignal",
            "quote": "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 25,
            "lineEnd": 27,
            "symbol": "launchStopRequested",
            "quote": "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 93,
            "lineEnd": 98,
            "symbol": "throwIfWorkflowStopRequested",
            "quote": "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);"
          }
        ],
        "rationale": "Registration lifetime is tracked by signal identity rather than binding ownership. Overlapping owners sharing a signal can therefore lose the synchronous fence that is meant to cover the durable-write window. Callers are absent, so the frequency of shared-signal registrations cannot be established.",
        "verifierEvidence": [
          "\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);\n\tlaunchSignals.set(key, signals);",
          "\treturn () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};",
          "\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);",
          "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);"
        ],
        "counterEvidence": [
          "The map-identity guard prevents an old cleanup from deleting a replacement Set, but does not preserve multiple registrations within the same Set.",
          "A readable durable stop intent still triggers cancellation, limiting the lost-fence effect to the interval before that intent becomes readable."
        ],
        "recommendedAction": "Track each binding with a unique registration token or reference count, make cleanup idempotent, and test that disposing one duplicate binding leaves the other effective.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-002",
          "specId": "devil-advocate.finding-002",
          "taskId": "task-13",
          "itemIdentity": "finding-002",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-003",
        "originalFindingId": "finding-003",
        "rootCauseId": "root-003",
        "title": "An in-flight check can abort the signal after disposal",
        "originalSeverity": "medium",
        "source": "reviewers",
        "reviewerIdentity": {
          "source": "reviewers",
          "specId": "reviewers.stop-lifecycle",
          "taskId": "task-9",
          "itemIdentity": "stop-lifecycle",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "medium",
        "file": "src/workflow-stop.ts",
        "locations": [
          {
            "file": "src/workflow-stop.ts",
            "line": 74,
            "lineEnd": 85,
            "symbol": "createWorkflowStopSignal"
          }
        ],
        "reviewerEvidenceQuotes": [
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "\t\tdispose: () => clearInterval(timer),"
        ],
        "evidenceQuotes": [
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "\t\tdispose: () => clearInterval(timer),",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),",
          "\t\tif (controller.signal.aborted) return;"
        ],
        "evidence": [
          {
            "file": "src/workflow-stop.ts",
            "line": 74,
            "lineEnd": 78,
            "symbol": "createWorkflowStopSignal",
            "quote": "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 80,
            "lineEnd": 85,
            "symbol": "createWorkflowStopSignal",
            "quote": "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 69,
            "symbol": "createWorkflowStopSignal",
            "quote": "\t\tif (controller.signal.aborted) return;"
          }
        ],
        "rationale": "Disposal stops future timer ticks but does not end cancellation notifications from work already launched. A retained abort listener can consequently run after the consumer has torn down this watcher or released its lifecycle ownership. Downstream listener effects are not available in this excerpt.",
        "verifierEvidence": [
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "\tvoid check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),",
          "\t\tif (controller.signal.aborted) return;"
        ],
        "counterEvidence": [
          "dispose clears the interval, preventing future scheduled polling; the defect concerns checks already in flight.",
          "The existing aborted guard prevents subsequent checks once cancellation is observed, but neither represents disposal nor guards the post-await continuation."
        ],
        "recommendedAction": "Set a disposed flag synchronously in dispose, check it before polling and immediately after the awaited read, and add a regression test resolving a pending read with a stop intent after disposal.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-003",
          "specId": "devil-advocate.finding-003",
          "taskId": "task-14",
          "itemIdentity": "finding-003",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-004",
        "originalFindingId": "finding-004",
        "rootCauseId": "root-004",
        "title": "A rejected persistence read bypasses the post-read launch fence",
        "originalSeverity": "medium",
        "source": "reviewers",
        "reviewerIdentity": {
          "source": "reviewers",
          "specId": "reviewers.stop-lifecycle",
          "taskId": "task-9",
          "itemIdentity": "stop-lifecycle",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "medium",
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
        "reviewerEvidenceQuotes": [
          "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
          "\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))"
        ],
        "evidenceQuotes": [
          "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
          "\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))",
          "export function isWorkflowStopRequestedError(error: unknown): boolean {\n\treturn (\n\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))\n\t);\n}",
          "function launchStopRequested(cwd: string, runId: string): boolean {\n\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);\n}",
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
        ],
        "evidence": [
          {
            "file": "src/workflow-stop.ts",
            "line": 93,
            "lineEnd": 98,
            "symbol": "throwIfWorkflowStopRequested",
            "quote": "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 53,
            "lineEnd": 59,
            "symbol": "isWorkflowStopRequestedError",
            "quote": "export function isWorkflowStopRequestedError(error: unknown): boolean {\n\treturn (\n\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))\n\t);\n}"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 24,
            "lineEnd": 28,
            "symbol": "launchStopRequested",
            "quote": "function launchStopRequested(cwd: string, runId: string): boolean {\n\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);\n}"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 74,
            "lineEnd": 78,
            "symbol": "createWorkflowStopSignal",
            "quote": "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
          }
        ],
        "rationale": "The race protection covers fulfilled reads only. An unrelated persistence error generally fails the stop-error classifier, so callers cannot reliably distinguish cancellation from operational failure during this race. Actual caller recovery behavior is unavailable.",
        "verifierEvidence": [
          "\tif (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
          "export function isWorkflowStopRequestedError(error: unknown): boolean {\n\treturn (\n\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))\n\t);\n}",
          "function launchStopRequested(cwd: string, runId: string): boolean {\n\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);\n}",
          "\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
        ],
        "counterEvidence": [
          "The rejected await still rejects the guard: this demonstrates incorrect cancellation classification, not successful dispatch past cancellation.",
          "The polling helper catches read rejection before its second launch check, so this specific rejection race does not affect that helper."
        ],
        "recommendedAction": "Catch intent-read rejection, recheck the launch fence, and throw WorkflowStopRequested only when locally stopped; otherwise rethrow the original error. Add regression tests for both outcomes.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-004",
          "specId": "devil-advocate.finding-004",
          "taskId": "task-15",
          "itemIdentity": "finding-004",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-005",
        "originalFindingId": "finding-005",
        "rootCauseId": "root-005",
        "title": "Ordinary provider content can be mistaken for workflow cancellation",
        "originalSeverity": "medium",
        "source": "reviewers.cancellation-classification",
        "reviewerIdentity": {
          "source": "reviewers.cancellation-classification",
          "specId": "reviewers.cancellation-classification",
          "taskId": "task-10",
          "itemIdentity": "cancellation-classification",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers.cancellation-classification"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "medium",
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
        "reviewerEvidenceQuotes": [
          "if (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
          "const parsed: unknown = JSON.parse(entry.text);",
          "if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;",
          "if (value.cancelled === true) return true;"
        ],
        "evidenceQuotes": [
          "if (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
          "const parsed: unknown = JSON.parse(entry.text);",
          "if (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;",
          "if (value.cancelled === true) return true;",
          "if (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
          "const parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;"
        ],
        "evidence": [
          {
            "file": "src/workflow-cancellation.ts",
            "line": 16,
            "quote": "if (value.cancelled === true) return true;"
          },
          {
            "file": "src/workflow-cancellation.ts",
            "line": 23,
            "lineEnd": 25,
            "quote": "if (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;"
          },
          {
            "file": "src/workflow-cancellation.ts",
            "line": 27,
            "lineEnd": 28,
            "quote": "const parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;"
          }
        ],
        "rationale": "Application data and provider cancellation metadata share the same interpretation here. A cancellation field describing an application entity can therefore become a workflow cancellation signal. Callers relying on this predicate could discard valid output or suppress diagnostics. The false-positive return is established by the implementation; downstream handling is not included in this excerpt.",
        "verifierEvidence": [
          "if (value.cancelled === true) return true;",
          "if (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;",
          "const parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;"
        ],
        "counterEvidence": [
          "Recognition uses exact cancellation markers, and JSON parsing failures are caught; arbitrary prose does not automatically become cancellation. These safeguards do not exclude valid domain JSON containing cancelled:true."
        ],
        "recommendedAction": "Restrict text-based recognition to explicitly identified adapter cancellation envelopes, preserve legacy wrappers explicitly, and add a regression test showing successful content containing domain JSON with cancelled:true is not classified as cancellation.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-005",
          "specId": "devil-advocate.finding-005",
          "taskId": "task-16",
          "itemIdentity": "finding-005",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-006",
        "originalFindingId": "finding-006",
        "rootCauseId": "root-006",
        "title": "Stop-error matching accepts unrelated failures with a similar message prefix",
        "originalSeverity": "medium",
        "source": "reviewers.cancellation-classification",
        "reviewerIdentity": {
          "source": "reviewers.cancellation-classification",
          "specId": "reviewers.cancellation-classification",
          "taskId": "task-10",
          "itemIdentity": "cancellation-classification",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers.cancellation-classification"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "medium",
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
        "reviewerEvidenceQuotes": [
          "error instanceof Error &&",
          "(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||",
          "error.message.startsWith(\"workflow stop requested\"))",
          "return `workflow stop requested for ${runId}`;"
        ],
        "evidenceQuotes": [
          "error instanceof Error &&",
          "(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||",
          "error.message.startsWith(\"workflow stop requested\"))",
          "return `workflow stop requested for ${runId}`;",
          "error instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))",
          "error.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;",
          "error.name = WORKFLOW_STOP_PENDING_ERROR_NAME;"
        ],
        "evidence": [
          {
            "file": "src/workflow-stop.ts",
            "line": 55,
            "lineEnd": 57,
            "symbol": "isWorkflowStopRequestedError",
            "quote": "error instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 44,
            "symbol": "workflowStopRequestedMessage",
            "quote": "return `workflow stop requested for ${runId}`;"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 49,
            "symbol": "createWorkflowStopRequestedError",
            "quote": "error.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;"
          },
          {
            "file": "src/workflow-stop.ts",
            "line": 35,
            "symbol": "createWorkflowStopPendingError",
            "quote": "error.name = WORKFLOW_STOP_PENDING_ERROR_NAME;"
          }
        ],
        "rationale": "A failure while requesting or processing a stop can be indistinguishable from the intentional stop sentinel. Consumers that use this classifier to suppress expected cancellation errors can consequently hide an operational failure. No consumer is supplied, so the downstream consequence remains unverified.",
        "verifierEvidence": [
          "error instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))",
          "return `workflow stop requested for ${runId}`;",
          "error.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;",
          "error.name = WORKFLOW_STOP_PENDING_ERROR_NAME;"
        ],
        "counterEvidence": [
          "The instanceof Error guard excludes plain strings and plain records; the false-positive scope is limited to Error instances.",
          "Canonical stop errors already receive the dedicated WorkflowStopRequested name, so their classification is intentional."
        ],
        "recommendedAction": "Prefer the explicit stop sentinel. If legacy message-only errors must remain supported, compare against the exact expected-run message without overriding conflicting error names. Add regression tests for similarly prefixed operational failures and WorkflowStopPending errors.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-006",
          "specId": "devil-advocate.finding-006",
          "taskId": "task-17",
          "itemIdentity": "finding-006",
          "placeholderSpecId": "devil-advocate.item"
        }
      },
      {
        "findingId": "finding-007",
        "originalFindingId": "finding-007",
        "rootCauseId": "root-007",
        "title": "Preserve failed and interrupted outcomes before applying dynamic status overrides",
        "originalSeverity": "high",
        "source": "reviewers.terminal-semantics",
        "reviewerIdentity": {
          "source": "reviewers.terminal-semantics",
          "specId": "reviewers.terminal-semantics",
          "taskId": "task-11",
          "itemIdentity": "terminal-semantics",
          "placeholderSpecId": "reviewers.item"
        },
        "sourceLineage": [
          "reviewers.terminal-semantics"
        ],
        "generatedRootCauseId": true,
        "verdict": "KEEP",
        "originalVerdict": "KEEP",
        "severity": "high",
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
        "reviewerEvidenceQuotes": [
          "\treturn run.status;",
          "\tif (!controller) return undefined;",
          "\t).catch(() => undefined);",
          "\tif (terminal && run.provenance?.mode === \"direct-dynamic\") {",
          "\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "\t\telse semanticStatus = \"completed_without_semantic_result\";",
          "\t\tengineStatus: run.status,"
        ],
        "evidenceQuotes": [
          "\treturn run.status;",
          "\tif (!controller) return undefined;",
          "\t).catch(() => undefined);",
          "\tif (terminal && run.provenance?.mode === \"direct-dynamic\") {",
          "\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "\t\telse semanticStatus = \"completed_without_semantic_result\";",
          "\t\tengineStatus: run.status,",
          "\tif (run.status === \"completed\")\n\t\treturn run.degradation ? \"completed_degraded\" : \"completed\";\n\treturn run.status;",
          "if (terminal && run.provenance?.mode === \"direct-dynamic\") {",
          "\tif (!controller) return undefined;\n\tconst taskOutput = fromProjectPath(cwd, controller.files.output);\n\treturn await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
          "\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "else semanticStatus = \"completed_without_semantic_result\";",
          "\t\tterminal,\n\t\tengineStatus: run.status,\n\t\tsemanticStatus,\n\t\toutputTaskIds,"
        ],
        "evidence": [
          {
            "file": "src/workflow-terminal.ts",
            "line": 67,
            "lineEnd": 69,
            "quote": "\tif (run.status === \"completed\")\n\t\treturn run.degradation ? \"completed_degraded\" : \"completed\";\n\treturn run.status;"
          },
          {
            "file": "src/workflow-terminal.ts",
            "line": 80,
            "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {"
          },
          {
            "file": "src/workflow-terminal.ts",
            "line": 57,
            "lineEnd": 61,
            "quote": "\tif (!controller) return undefined;\n\tconst taskOutput = fromProjectPath(cwd, controller.files.output);\n\treturn await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);"
          },
          {
            "file": "src/workflow-terminal.ts",
            "line": 83,
            "lineEnd": 87,
            "quote": "\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";"
          },
          {
            "file": "src/workflow-terminal.ts",
            "line": 95,
            "quote": "else semanticStatus = \"completed_without_semantic_result\";"
          },
          {
            "file": "src/workflow-terminal.ts",
            "line": 99,
            "lineEnd": 102,
            "quote": "\t\tterminal,\n\t\tengineStatus: run.status,\n\t\tsemanticStatus,\n\t\toutputTaskIds,"
          }
        ],
        "rationale": "Cancellation before controller output exists and failures with unavailable controller artifacts lose their failed/interrupted semantic outcome. An existing synthesized artifact can also override those outcomes because controller success and artifact currency are not checked here. Although engineStatus remains accurate, consumers relying on semanticStatus receive a contradictory completion-labelled or successful-looking result and can misreport termination or omit recovery.",
        "verifierEvidence": [
          "\tif (run.status === \"completed\")\n\t\treturn run.degradation ? \"completed_degraded\" : \"completed\";\n\treturn run.status;",
          "if (terminal && run.provenance?.mode === \"direct-dynamic\") {",
          "\tif (!controller) return undefined;\n\tconst taskOutput = fromProjectPath(cwd, controller.files.output);\n\treturn await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
          "\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "else semanticStatus = \"completed_without_semantic_result\";",
          "\t\tterminal,\n\t\tengineStatus: run.status,\n\t\tsemanticStatus,\n\t\toutputTaskIds,"
        ],
        "counterEvidence": [
          "src/workflow-terminal.ts:99-101 preserves terminal and engineStatus, so the summary does not erase the engine outcome entirely or alter cancellation execution.",
          "src/workflow-terminal.ts:83-86 gives dynamic_incomplete precedence; runs carrying that marker do not receive the completion-labelled fallback."
        ],
        "recommendedAction": "Preserve failed/interrupted semantic outcomes before applying completion-derived dynamic refinements. Keep controller/output metadata extraction separate from status precedence. Add regression cases for absent, unreadable, and synthesized artifacts, including completed-run controls.",
        "sourceCoverageComplete": true,
        "sourceCoverageIssuePaths": [],
        "verifierOwner": {
          "source": "devil-advocate.finding-007",
          "specId": "devil-advocate.finding-007",
          "taskId": "task-18",
          "itemIdentity": "finding-007",
          "placeholderSpecId": "devil-advocate.item"
        }
      }
    ],
    "weaken": [],
    "drop": [],
    "needsHuman": []
  },
  "supportNotes": [],
  "reportContext": {
    "keep": [
      {
        "findingId": "finding-001",
        "rootCauseId": "root-001",
        "title": "Stop polling starts unbounded concurrent persistence reads",
        "severity": "high",
        "recommendedAction": "Permit only one outstanding intent read per watcher, while checking foreground launch cancellation before the in-flight guard. Add a deferred-read regression test covering repeated ticks and local cancellation before that read settles."
      },
      {
        "findingId": "finding-002",
        "rootCauseId": "root-002",
        "title": "Disposing one binding can remove another owner's launch fence",
        "severity": "medium",
        "recommendedAction": "Track each binding with a unique registration token or reference count, make cleanup idempotent, and test that disposing one duplicate binding leaves the other effective."
      },
      {
        "findingId": "finding-003",
        "rootCauseId": "root-003",
        "title": "An in-flight check can abort the signal after disposal",
        "severity": "medium",
        "recommendedAction": "Set a disposed flag synchronously in dispose, check it before polling and immediately after the awaited read, and add a regression test resolving a pending read with a stop intent after disposal."
      },
      {
        "findingId": "finding-004",
        "rootCauseId": "root-004",
        "title": "A rejected persistence read bypasses the post-read launch fence",
        "severity": "medium",
        "recommendedAction": "Catch intent-read rejection, recheck the launch fence, and throw WorkflowStopRequested only when locally stopped; otherwise rethrow the original error. Add regression tests for both outcomes."
      },
      {
        "findingId": "finding-005",
        "rootCauseId": "root-005",
        "title": "Ordinary provider content can be mistaken for workflow cancellation",
        "severity": "medium",
        "recommendedAction": "Restrict text-based recognition to explicitly identified adapter cancellation envelopes, preserve legacy wrappers explicitly, and add a regression test showing successful content containing domain JSON with cancelled:true is not classified as cancellation."
      },
      {
        "findingId": "finding-006",
        "rootCauseId": "root-006",
        "title": "Stop-error matching accepts unrelated failures with a similar message prefix",
        "severity": "medium",
        "recommendedAction": "Prefer the explicit stop sentinel. If legacy message-only errors must remain supported, compare against the exact expected-run message without overriding conflicting error names. Add regression tests for similarly prefixed operational failures and WorkflowStopPending errors."
      },
      {
        "findingId": "finding-007",
        "rootCauseId": "root-007",
        "title": "Preserve failed and interrupted outcomes before applying dynamic status overrides",
        "severity": "high",
        "recommendedAction": "Preserve failed/interrupted semantic outcomes before applying completion-derived dynamic refinements. Keep controller/output metadata extraction separate from status precedence. Add regression cases for absent, unreadable, and synthesized artifacts, including completed-run controls."
      }
    ],
    "weaken": [],
    "drop": [],
    "needsHuman": [],
    "supportNoteSummaries": [],
    "partialFailures": []
  },
  "reportPacket": {
    "schema": "deep-review-report-packet-v1",
    "digest": "5004011687047a8df835b801591b44d8fdcf44534536d90194bf483c00f086b4",
    "maxChars": 15000,
    "actualChars": 2146,
    "partitionSummary": {
      "keep": 7,
      "weaken": 0,
      "drop": 0,
      "needsHuman": 0,
      "supportNotes": 0,
      "mergedFindings": 0,
      "verdictsReceived": 7,
      "batchIntegrityIssues": 0,
      "verdictIntegrityIssues": 0,
      "reviewerCoverageIssues": 0,
      "reviewerFindings": 7,
      "missingVerdicts": 0,
      "partialFailures": 0
    },
    "sourceStatusSummary": {
      "total": 8,
      "completed": 8,
      "nonCompleted": 0,
      "partialFailureCount": 0,
      "partialFailures": []
    },
    "reportContext": {
      "keep": [
        {
          "findingId": "finding-001",
          "title": "Stop polling starts unbounded concurrent persistence reads",
          "severity": "high",
          "recommendedAction": "Permit only one outstanding intent read per watcher, while checking foreground launch cancellation before the in-flight guard. Add a deferred-read regression test covering repeated ticks and local cancellation before tha"
        },
        {
          "findingId": "finding-002",
          "title": "Disposing one binding can remove another owner's launch fence",
          "severity": "medium",
          "recommendedAction": "Track each binding with a unique registration token or reference count, make cleanup idempotent, and test that disposing one duplicate binding leaves the other effective."
        },
        {
          "findingId": "finding-003",
          "title": "An in-flight check can abort the signal after disposal",
          "severity": "medium",
          "recommendedAction": "Set a disposed flag synchronously in dispose, check it before polling and immediately after the awaited read, and add a regression test resolving a pending read with a stop intent after disposal."
        },
        {
          "findingId": "finding-004",
          "title": "A rejected persistence read bypasses the post-read launch fence",
          "severity": "medium",
          "recommendedAction": "Catch intent-read rejection, recheck the launch fence, and throw WorkflowStopRequested only when locally stopped; otherwise rethrow the original error. Add regression tests for both outcomes."
        }
      ],
      "weaken": [],
      "drop": [],
      "needsHuman": [],
      "supportNoteSummaries": []
    },
    "normalizationNotes": [],
    "overflowCounts": {
      "keep": 3,
      "weaken": 0,
      "drop": 0,
      "needsHuman": 0,
      "supportNotes": 0,
      "partialFailures": 0,
      "normalizationNotes": 0,
      "truncatedStrings": 1,
      "omittedStringChars": 15
    }
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
  },
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
    "invalidFindingIds": [],
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
    "provenanceOwnerFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ]
  },
  "verifierCoverage": {
    "verdictsReceived": 7,
    "complete": true,
    "expectedFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "verdictFindingIds": [
      "finding-001",
      "finding-002",
      "finding-003",
      "finding-004",
      "finding-005",
      "finding-006",
      "finding-007"
    ],
    "missingFindingIds": [],
    "orphanFindingIds": [],
    "duplicateFindingIds": [],
    "ownerIssues": [],
    "statusIssues": [],
    "exactSetEquality": true,
    "rows": [
      {
        "sourceId": "devil-advocate",
        "index": 0,
        "findingId": "finding-001",
        "owner": {
          "source": "devil-advocate",
          "specId": "devil-advocate.finding-001",
          "taskId": "task-12",
          "itemIdentity": "finding-001",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate",
        "ownerSpecId": "devil-advocate.finding-001",
        "ownerTaskId": "task-12",
        "ownerItemIdentity": "finding-001",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-002",
        "index": 1,
        "findingId": "finding-002",
        "owner": {
          "source": "devil-advocate.finding-002",
          "specId": "devil-advocate.finding-002",
          "taskId": "task-13",
          "itemIdentity": "finding-002",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-002",
        "ownerSpecId": "devil-advocate.finding-002",
        "ownerTaskId": "task-13",
        "ownerItemIdentity": "finding-002",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-003",
        "index": 2,
        "findingId": "finding-003",
        "owner": {
          "source": "devil-advocate.finding-003",
          "specId": "devil-advocate.finding-003",
          "taskId": "task-14",
          "itemIdentity": "finding-003",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-003",
        "ownerSpecId": "devil-advocate.finding-003",
        "ownerTaskId": "task-14",
        "ownerItemIdentity": "finding-003",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-004",
        "index": 3,
        "findingId": "finding-004",
        "owner": {
          "source": "devil-advocate.finding-004",
          "specId": "devil-advocate.finding-004",
          "taskId": "task-15",
          "itemIdentity": "finding-004",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-004",
        "ownerSpecId": "devil-advocate.finding-004",
        "ownerTaskId": "task-15",
        "ownerItemIdentity": "finding-004",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-005",
        "index": 4,
        "findingId": "finding-005",
        "owner": {
          "source": "devil-advocate.finding-005",
          "specId": "devil-advocate.finding-005",
          "taskId": "task-16",
          "itemIdentity": "finding-005",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-005",
        "ownerSpecId": "devil-advocate.finding-005",
        "ownerTaskId": "task-16",
        "ownerItemIdentity": "finding-005",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-006",
        "index": 5,
        "findingId": "finding-006",
        "owner": {
          "source": "devil-advocate.finding-006",
          "specId": "devil-advocate.finding-006",
          "taskId": "task-17",
          "itemIdentity": "finding-006",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-006",
        "ownerSpecId": "devil-advocate.finding-006",
        "ownerTaskId": "task-17",
        "ownerItemIdentity": "finding-006",
        "valid": true
      },
      {
        "sourceId": "devil-advocate.finding-007",
        "index": 6,
        "findingId": "finding-007",
        "owner": {
          "source": "devil-advocate.finding-007",
          "specId": "devil-advocate.finding-007",
          "taskId": "task-18",
          "itemIdentity": "finding-007",
          "placeholderSpecId": "devil-advocate.item"
        },
        "ownerSource": "devil-advocate.finding-007",
        "ownerSpecId": "devil-advocate.finding-007",
        "ownerTaskId": "task-18",
        "ownerItemIdentity": "finding-007",
        "valid": true
      }
    ],
    "sourceStatuses": [
      {
        "source": "dedup-findings",
        "displayName": "dedup-findings.main",
        "taskId": "task-3",
        "specId": "dedup-findings.main",
        "stageId": "dedup-findings",
        "status": "completed",
        "statusDetail": "support_completed",
        "lastMessage": "support completed"
      },
      {
        "source": "devil-advocate",
        "displayName": "devil-advocate.finding-001",
        "taskId": "task-12",
        "specId": "devil-advocate.finding-001",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-001",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-002",
        "displayName": "devil-advocate.finding-002",
        "taskId": "task-13",
        "specId": "devil-advocate.finding-002",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-002",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-003",
        "displayName": "devil-advocate.finding-003",
        "taskId": "task-14",
        "specId": "devil-advocate.finding-003",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-003",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-004",
        "displayName": "devil-advocate.finding-004",
        "taskId": "task-15",
        "specId": "devil-advocate.finding-004",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-004",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-005",
        "displayName": "devil-advocate.finding-005",
        "taskId": "task-16",
        "specId": "devil-advocate.finding-005",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-005",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-006",
        "displayName": "devil-advocate.finding-006",
        "taskId": "task-17",
        "specId": "devil-advocate.finding-006",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-006",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      },
      {
        "source": "devil-advocate.finding-007",
        "displayName": "devil-advocate.finding-007",
        "taskId": "task-18",
        "specId": "devil-advocate.finding-007",
        "stageId": "devil-advocate",
        "itemIdentity": "finding-007",
        "placeholderSpecId": "devil-advocate.item",
        "status": "completed",
        "statusDetail": "completed",
        "lastMessage": "completed"
      }
    ],
    "digest": "0b6fd1828fb1fbec44f5ea2c133208e390a0510ffdfb89f045a2f5dcc3cd8c8e"
  },
  "sourceStatusSummary": {
    "total": 8,
    "completed": 8,
    "nonCompleted": 0,
    "partialFailures": []
  },
  "partitionSummary": {
    "keep": 7,
    "weaken": 0,
    "drop": 0,
    "needsHuman": 0,
    "supportNotes": 0,
    "mergedFindings": 0,
    "verdictsReceived": 7,
    "batchIntegrityIssues": 0,
    "verdictIntegrityIssues": 0,
    "reviewerCoverageIssues": 0,
    "reviewerFindings": 7,
    "missingVerdicts": 0,
    "partialFailures": 0
  },
  "normalizationNotes": []
}
</control>
<analysis>
Support helper completed deterministically.
</analysis>
<refs>
[]
</refs>