<control>
{
  "schema": "spec-review-partition-v1",
  "digest": "sha256:acf75c059c93b7c057b49aa724cc80d8cc4ed3809180b2cbae1a47896bbae45e",
  "evidenceGate": {
    "protocol": "spec-local-evidence-v1",
    "complete": false,
    "findings": [
      {
        "id": "finding-001",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "SPEC.md",
              "lineStart": 49,
              "lineEnd": 51,
              "quote": "13. Terminal direct-dynamic runs derive their semantic status from the dynamic\n    controller's `control.json`; an unreadable control yields\n    `completed_without_semantic_result`.",
              "relevance": "Requires controller-derived semantics and explicitly specifies the unreadable-control result."
            },
            "status": "verified",
            "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 59,
              "lineEnd": 61,
              "quote": "return await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
              "relevance": "A rejected controller read produces undefined."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 2,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 80,
              "lineEnd": 87,
              "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
              "relevance": "Any incomplete task wins regardless of controller readability or status."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 3,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 93,
              "lineEnd": 95,
              "quote": "else if (control?.status === \"blocked\") semanticStatus = \"dynamic_blocked\";\n\t\telse if (control?.status === \"stopped\") semanticStatus = \"dynamic_stopped\";\n\t\telse semanticStatus = \"completed_without_semantic_result\";",
              "relevance": "The required fallback is subordinate to the task-marker branch."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "counterEvidence",
            "index": 0,
            "citation": {
              "file": "SPEC.md",
              "lineStart": 3,
              "lineEnd": 4,
              "quote": "This spec covers `src/workflow-stop.ts`, `src/workflow-cancellation.ts` and\n`src/workflow-terminal.ts`. `store.js` and `types.js` are outside this sample.",
              "relevance": "Limits verification of production run invariants and concrete persisted fixtures."
            },
            "status": "verified",
            "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
          },
          {
            "field": "counterEvidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 23,
              "lineEnd": 23,
              "quote": "| \"dynamic_incomplete\"",
              "relevance": "The implementation deliberately supports this semantic status, but its existence does not establish a specification exception."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          }
        ]
      }
    ],
    "coverage": [
      {
        "index": 0,
        "id": "REQ-001",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 12,
              "lineEnd": 16,
              "quote": "if (!signal) return () => {};\n\tconst key = workflowRunPath(cwd, runId);\n\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);\n\tlaunchSignals.set(key, signals);"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 1,
        "id": "REQ-002",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 17,
              "lineEnd": 21,
              "quote": "return () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 2,
        "id": "REQ-003",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 24,
              "lineEnd": 28,
              "quote": "function launchStopRequested(cwd: string, runId: string): boolean {\n\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);\n}"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 3,
        "id": "REQ-004",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 30,
              "lineEnd": 30,
              "quote": "export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = \"WorkflowStopRequested\";"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 43,
              "lineEnd": 51,
              "quote": "export function workflowStopRequestedMessage(runId: string): string {\n\treturn `workflow stop requested for ${runId}`;\n}\n\nexport function createWorkflowStopRequestedError(runId: string): Error {\n\tconst error = new Error(workflowStopRequestedMessage(runId));\n\terror.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;\n\treturn error;\n}"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 4,
        "id": "REQ-005",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 30,
              "lineEnd": 30,
              "quote": "export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = \"WorkflowStopRequested\";"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 53,
              "lineEnd": 59,
              "quote": "export function isWorkflowStopRequestedError(error: unknown): boolean {\n\treturn (\n\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))\n\t);\n}"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 5,
        "id": "REQ-006",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 31,
              "lineEnd": 41,
              "quote": "const WORKFLOW_STOP_PENDING_ERROR_NAME = \"WorkflowStopPending\";\n\nexport function createWorkflowStopPendingError(message: string): Error {\n\tconst error = new Error(message);\n\terror.name = WORKFLOW_STOP_PENDING_ERROR_NAME;\n\treturn error;\n}\n\nexport function isWorkflowStopPendingError(error: unknown): error is Error {\n\treturn error instanceof Error && error.name === WORKFLOW_STOP_PENDING_ERROR_NAME;\n}"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 6,
        "id": "REQ-007",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 93,
              "lineEnd": 98,
              "quote": "if (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
              "relevance": "Both launch abort and durable intent lead to the specified error."
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 7,
        "id": "REQ-008",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 95,
              "lineEnd": 98,
              "quote": "const intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
              "relevance": "After the awaited read, launch state is checked when intent has not already established a stop."
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 8,
        "id": "REQ-009",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 64,
              "lineEnd": 67,
              "quote": "options: { pollMs?: number } = {},\n): { signal: AbortSignal; dispose: () => void } {\n\tconst controller = new AbortController();\n\tconst pollMs = Math.max(10, options.pollMs ?? 50);"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 80,
              "lineEnd": 86,
              "quote": "void check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),\n\t};"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 9,
        "id": "REQ-010",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 70,
              "lineEnd": 78,
              "quote": "if (launchStopRequested(cwd, runId)) {\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));\n\t\t\treturn;\n\t\t}\n\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 84,
              "lineEnd": 84,
              "quote": "signal: controller.signal,"
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 10,
        "id": "REQ-011",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 74,
              "lineEnd": 78,
              "quote": "const intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
              "relevance": "Read rejection becomes undefined rather than durable stop intent."
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 11,
        "id": "REQ-012",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-stop.ts",
              "lineStart": 81,
              "lineEnd": 85,
              "quote": "const timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),",
              "relevance": "The interval is unreferenced and disposal clears it."
            },
            "status": "verified",
            "sha256": "a8a49ff7dd741a0bc36bd592211515646e2faa4bd6083aba3ea8d91f218b8420"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 12,
        "id": "REQ-013",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 2,
              "lineEnd": 6,
              "quote": "export function isWorkflowAbortError(value: unknown): boolean {\n\tif (typeof DOMException !== \"undefined\" && value instanceof DOMException)\n\t\treturn value.name === \"AbortError\";\n\treturn isRecord(value) && value.name === \"AbortError\";\n}"
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 35,
              "lineEnd": 37,
              "quote": "function isRecord(value: unknown): value is Record<string, unknown> {\n\treturn typeof value === \"object\" && value !== null && !Array.isArray(value);\n}"
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 13,
        "id": "REQ-014",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 16,
              "lineEnd": 18,
              "quote": "if (value.cancelled === true) return true;\n\tconst details = isRecord(value.details) ? value.details : undefined;\n\tif (details?.cancelled === true) return true;"
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 14,
        "id": "REQ-015",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 19,
              "lineEnd": 22,
              "quote": "for (const candidate of [value.error, details?.error, value.reason, details?.reason]) {\n\t\tif (candidate === \"aborted\" || candidate === \"AbortError\" || candidate === \"ABORT_ERR\") return true;\n\t\tif (isWorkflowAbortError(candidate)) return true;\n\t}"
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 15,
        "id": "REQ-016",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 23,
              "lineEnd": 31,
              "quote": "if (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;\n\t\t\ttry {\n\t\t\t\tconst parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;\n\t\t\t} catch { /* ordinary provider text */ }\n\t\t}\n\t}",
              "relevance": "Decoded text content is passed recursively through the same cancellation recognizer."
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 16,
        "id": "REQ-017",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-cancellation.ts",
              "lineStart": 13,
              "lineEnd": 33,
              "quote": "export function isWorkflowReturnedCancellation(value: unknown): boolean {\n\tif (isWorkflowAbortError(value)) return true;\n\tif (!isRecord(value)) return false;\n\tif (value.cancelled === true) return true;\n\tconst details = isRecord(value.details) ? value.details : undefined;\n\tif (details?.cancelled === true) return true;\n\tfor (const candidate of [value.error, details?.error, value.reason, details?.reason]) {\n\t\tif (candidate === \"aborted\" || candidate === \"AbortError\" || candidate === \"ABORT_ERR\") return true;\n\t\tif (isWorkflowAbortError(candidate)) return true;\n\t}\n\tif (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;\n\t\t\ttry {\n\t\t\t\tconst parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;\n\t\t\t} catch { /* ordinary provider text */ }\n\t\t}\n\t}\n\treturn false;\n}",
              "relevance": "Unrelated errors have no acceptance path; parsed content must also satisfy the explicit recognizer."
            },
            "status": "verified",
            "sha256": "f0f1921aec405c136b2009b801cc472e34a1311605b2d82fd65b94097cab45fa"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 17,
        "id": "REQ-018",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 76,
              "lineEnd": 78,
              "quote": "const terminal = isTerminalWorkflowStatus(run.status);\n\tlet semanticStatus: WorkflowSemanticStatus = nonDynamicSemanticStatus(run);\n\tlet outputTaskIds = finalStageTasks(run.tasks).map((task) => task.specId);"
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 98,
              "lineEnd": 112,
              "quote": "return {\n\t\tterminal,\n\t\tengineStatus: run.status,\n\t\tsemanticStatus,\n\t\toutputTaskIds,\n\t\toutputRetryAttempts: run.tasks.reduce(\n\t\t\t(total, task) => total + (task.outputRetry?.attempts ?? 0),\n\t\t\t0,\n\t\t),\n\t\tlaunchRetryAttempts: run.tasks.reduce(\n\t\t\t(total, task) => total + (task.launchRetry?.attempts ?? 0),\n\t\t\t0,\n\t\t),\n\t\tartifactRoot: workflowRunDir(cwd, run.runId),\n\t};"
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          }
        ],
        "status": "covered",
        "positive": true,
        "accountedBy": []
      },
      {
        "index": 18,
        "id": "REQ-019",
        "verdict": "KEEP",
        "complete": false,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 67,
              "lineEnd": 69,
              "quote": "if (run.status === \"completed\")\n\t\treturn run.degradation ? \"completed_degraded\" : \"completed\";\n\treturn run.status;",
              "relevance": "The baseline implements degradation reporting."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 80,
              "lineEnd": 87,
              "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
              "relevance": "Direct-dynamic routing overrides the degradation baseline; SPEC items 12 and 13 do not explicitly state their precedence."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          }
        ],
        "status": "unclear",
        "positive": false,
        "accountedBy": []
      },
      {
        "index": 19,
        "id": "REQ-020",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 52,
              "lineEnd": 61,
              "quote": "const controller = run.tasks.find(\n\t\t(task) =>\n\t\t\ttask.specId === \"dynamic.controller\" ||\n\t\t\ttask.statusDetail === \"dynamic_completed\",\n\t);\n\tif (!controller) return undefined;\n\tconst taskOutput = fromProjectPath(cwd, controller.files.output);\n\treturn await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);"
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 80,
              "lineEnd": 95,
              "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";\n\t\telse if (control?.status === \"exhausted\")\n\t\t\tsemanticStatus =\n\t\t\t\toutputTaskIds.length > 0\n\t\t\t\t\t? \"exhausted_with_output\"\n\t\t\t\t\t: \"exhausted_without_output\";\n\t\telse if (control?.status === \"blocked\") semanticStatus = \"dynamic_blocked\";\n\t\telse if (control?.status === \"stopped\") semanticStatus = \"dynamic_stopped\";\n\t\telse semanticStatus = \"completed_without_semantic_result\";",
              "relevance": "Control-derived statuses exist, but the task-level incomplete marker takes precedence; linked to finding-001."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          }
        ],
        "status": "partial",
        "positive": false,
        "accountedBy": [
          "finding-001"
        ]
      },
      {
        "index": 20,
        "id": "REQ-021",
        "verdict": "KEEP",
        "complete": true,
        "rows": [
          {
            "field": "evidence",
            "index": 0,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 59,
              "lineEnd": 61,
              "quote": "return await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
              "relevance": "A rejected control read becomes undefined."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 1,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 83,
              "lineEnd": 86,
              "quote": "const incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";",
              "relevance": "This branch bypasses the unreadable-control fallback; linked to finding-001."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          },
          {
            "field": "evidence",
            "index": 2,
            "citation": {
              "file": "src/workflow-terminal.ts",
              "lineStart": 95,
              "lineEnd": 95,
              "quote": "else semanticStatus = \"completed_without_semantic_result\";",
              "relevance": "The specified fallback is present only after higher-priority branches."
            },
            "status": "verified",
            "sha256": "96b3a29f7a5083043b439bdd04420289c0872033267fdb4117b8f07e46ca71b9"
          }
        ],
        "status": "partial",
        "positive": false,
        "accountedBy": [
          "finding-001"
        ]
      }
    ],
    "requirementReconciliation": {
      "protocol": "spec-requirement-reconciliation-v1",
      "proof": {
        "runId": "workflow_mvoufde9_8566f1",
        "candidateTaskId": "task-4",
        "candidateControlSha256": "17b128a6ae7fa79e03046d6d08cae40c4bcd295ae9c7e840a1802aabbe4f4a68",
        "candidateManifestSha256": "c6928c7fe350ccb2447669f1a224de19f40b070f5446d6cc7db139a822385195",
        "extractTaskId": "task-1",
        "extractControlSha256": "d4d0afbcea42f0d1a695ba7cfa06e677decf013ed453f62f43b941300bc3aa82",
        "mapTaskId": "task-2",
        "mapControlSha256": "0d37344a1b78a06b910e9bb10bf0253c58aefddb92d431010172368925462e46",
        "inspectTestsTaskId": "task-3",
        "inspectTestsControlSha256": "e400f2fa7691c164183234653b4c0f8ed00814080fbabb8db32e8326a05238c0"
      },
      "sourceEvidence": [
        {
          "id": "REQ-001",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 8,
                "lineEnd": 10,
                "quote": "1. `bindWorkflowLaunchSignal(cwd, runId, signal)` registers an abort signal for\n   the run keyed by `workflowRunPath(cwd, runId)`. With no signal it returns a\n   no-op unbind function."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-002",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 11,
                "lineEnd": 12,
                "quote": "2. The returned unbind function removes only that signal. When the last signal\n   for a run is removed, the run's registration is deleted."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-003",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 13,
                "lineEnd": 14,
                "quote": "3. A run counts as \"launch stop requested\" when any registered signal for it is\n   aborted."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-004",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 18,
                "lineEnd": 19,
                "quote": "4. `createWorkflowStopRequestedError(runId)` returns an `Error` named\n   `WorkflowStopRequested` with message `workflow stop requested for <runId>`."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-005",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 20,
                "lineEnd": 21,
                "quote": "5. `isWorkflowStopRequestedError(error)` is true for an `Error` with that name or\n   whose message starts with `workflow stop requested`; false for non-errors."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-006",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 22,
                "lineEnd": 23,
                "quote": "6. `createWorkflowStopPendingError(message)` returns an `Error` named\n   `WorkflowStopPending`; `isWorkflowStopPendingError` recognizes exactly that name."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-007",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 27,
                "lineEnd": 28,
                "quote": "7. `throwIfWorkflowStopRequested(cwd, runId)` throws the stop-requested error if a\n   launch stop is requested, or if a durable stop intent exists for the run."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-008",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 28,
                "lineEnd": 29,
                "quote": "It\n   re-checks launch signals after the durable read completes."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-009",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 30,
                "lineEnd": 32,
                "quote": "8. `createWorkflowStopSignal(cwd, runId, {pollMs})` returns `{signal, dispose}`.\n   It checks immediately and then every `pollMs` milliseconds (minimum 10,\n   default 50)."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-010",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 32,
                "lineEnd": 33,
                "quote": "When a stop is requested its signal aborts with the\n   stop-requested error."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-011",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 33,
                "lineEnd": 33,
                "quote": "A failed durable read is treated as \"no intent\"."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-012",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 34,
                "lineEnd": 34,
                "quote": "`dispose()` stops polling. The poll timer must not keep the process alive."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-013",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 38,
                "lineEnd": 38,
                "quote": "9. `isWorkflowAbortError(value)` is true only for values named `AbortError`."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-014",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 39,
                "lineEnd": 40,
                "quote": "10. `isWorkflowReturnedCancellation(value)` recognizes `cancelled: true` (top\n    level or in `details`),"
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-015",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 39,
                "lineEnd": 41,
                "quote": "10. `isWorkflowReturnedCancellation(value)` recognizes `cancelled: true` (top\n    level or in `details`), `aborted`/`AbortError`/`ABORT_ERR` reasons and\n    errors"
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-016",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 41,
                "lineEnd": 41,
                "quote": "and JSON text content entries that encode one of these."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-017",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 41,
                "lineEnd": 42,
                "quote": "Arbitrary\n    provider errors must not be treated as cancellation."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-018",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 46,
                "lineEnd": 47,
                "quote": "11. `summarizeWorkflowTerminal(cwd, run)` reports `terminal`, `engineStatus`,\n    `semanticStatus`, `outputTaskIds`, retry totals, and `artifactRoot`."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-019",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 48,
                "lineEnd": 48,
                "quote": "12. A completed run with degradation reports `completed_degraded`."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-020",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 49,
                "lineEnd": 50,
                "quote": "13. Terminal direct-dynamic runs derive their semantic status from the dynamic\n    controller's `control.json`;"
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        },
        {
          "id": "REQ-021",
          "complete": true,
          "checked": [
            {
              "citation": {
                "file": "<ROOT>/SPEC.md",
                "lineStart": 50,
                "lineEnd": 51,
                "quote": "an unreadable control yields\n    `completed_without_semantic_result`."
              },
              "status": "verified",
              "sha256": "c7d40041d9a764aca28c240aca0a65cbcb83c36cadcd9c696e24a7a9c859be19"
            }
          ]
        }
      ],
      "requirementIds": [
        "REQ-001",
        "REQ-002",
        "REQ-003",
        "REQ-004",
        "REQ-005",
        "REQ-006",
        "REQ-007",
        "REQ-008",
        "REQ-009",
        "REQ-010",
        "REQ-011",
        "REQ-012",
        "REQ-013",
        "REQ-014",
        "REQ-015",
        "REQ-016",
        "REQ-017",
        "REQ-018",
        "REQ-019",
        "REQ-020",
        "REQ-021"
      ],
      "coverageIds": [
        "REQ-001",
        "REQ-002",
        "REQ-003",
        "REQ-004",
        "REQ-005",
        "REQ-006",
        "REQ-007",
        "REQ-008",
        "REQ-009",
        "REQ-010",
        "REQ-011",
        "REQ-012",
        "REQ-013",
        "REQ-014",
        "REQ-015",
        "REQ-016",
        "REQ-017",
        "REQ-018",
        "REQ-019",
        "REQ-020",
        "REQ-021"
      ],
      "missingIds": [],
      "unresolvedIds": [
        "REQ-019"
      ],
      "issues": [],
      "complete": false,
      "allCovered": false
    }
  },
  "sourceStatusSummary": {
    "metadataAvailable": true,
    "total": 2,
    "completed": 2,
    "nonCompleted": 0,
    "partialFailures": []
  },
  "verifierCoverage": {
    "candidateUniverse": {
      "schema": "spec-review-runtime-candidate-universe-v1",
      "count": 1,
      "uniqueCount": 1,
      "ids": [
        "finding-001"
      ],
      "duplicateIds": [],
      "invalidRowCount": 0,
      "proof": {
        "runId": "workflow_mvoufde9_8566f1",
        "candidateTaskId": "task-4",
        "candidateControlSha256": "17b128a6ae7fa79e03046d6d08cae40c4bcd295ae9c7e840a1802aabbe4f4a68",
        "candidateManifestSha256": "c6928c7fe350ccb2447669f1a224de19f40b070f5446d6cc7db139a822385195",
        "extractTaskId": "task-1",
        "extractControlSha256": "d4d0afbcea42f0d1a695ba7cfa06e677decf013ed453f62f43b941300bc3aa82",
        "mapTaskId": "task-2",
        "mapControlSha256": "0d37344a1b78a06b910e9bb10bf0253c58aefddb92d431010172368925462e46",
        "inspectTestsTaskId": "task-3",
        "inspectTestsControlSha256": "e400f2fa7691c164183234653b4c0f8ed00814080fbabb8db32e8326a05238c0"
      }
    },
    "complete": true,
    "candidateCount": 1,
    "uniqueCandidateCount": 1,
    "verifierCount": 1,
    "uniqueVerifierCount": 1,
    "verifiedCandidateCount": 1,
    "missingIds": [],
    "duplicateCandidateIds": [],
    "duplicateVerifierIds": [],
    "orphanVerifierIds": [],
    "ownerLedger": [
      {
        "source": "verify-findings",
        "stageId": "verify-findings",
        "specId": "verify-findings.finding-001",
        "taskId": "task-9",
        "itemIdentity": "finding-001",
        "placeholderSpecId": "verify-findings.item",
        "status": "completed"
      }
    ],
    "batchOwnerLedger": [
      {
        "source": "verify-findings",
        "stageId": "verify-findings",
        "specId": "verify-findings.finding-001",
        "taskId": "task-9",
        "itemIdentity": "finding-001",
        "placeholderSpecId": "verify-findings.item",
        "status": "completed"
      }
    ],
    "verifierRows": [
      {
        "id": "finding-001",
        "verdict": "KEEP",
        "severity": "medium",
        "owner": {
          "source": "verify-findings",
          "stageId": "verify-findings",
          "specId": "verify-findings.finding-001",
          "taskId": "task-9",
          "itemIdentity": "finding-001",
          "placeholderSpecId": "verify-findings.item",
          "status": "completed"
        }
      }
    ],
    "ownerLedgerReconciliation": {
      "ownerRowCount": 1,
      "verifierRowCount": 1,
      "ownerIds": [
        "finding-001"
      ],
      "verifierIds": [
        "finding-001"
      ],
      "duplicateOwnerIds": [],
      "duplicateVerifierIds": [],
      "missingOwnerRows": [],
      "orphanOwnerRows": [],
      "statusMismatches": [],
      "cardinalityPassed": true,
      "passed": true
    },
    "candidateUniverseReconciliation": {
      "issues": [],
      "passed": true,
      "runtimeIds": [
        "finding-001"
      ],
      "sourceIds": [
        "finding-001"
      ]
    }
  },
  "verdictCounts": {
    "keep": 1,
    "weaken": 0,
    "drop": 0,
    "needsHuman": 1,
    "missingVerification": 0,
    "invalidVerifier": 0,
    "orphanVerifier": 0
  },
  "requirementCoverage": [
    {
      "requirementId": "REQ-001",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 12,
          "lineEnd": 16,
          "quote": "if (!signal) return () => {};\n\tconst key = workflowRunPath(cwd, runId);\n\tconst signals = launchSignals.get(key) ?? new Set<AbortSignal>();\n\tsignals.add(signal);\n\tlaunchSignals.set(key, signals);"
        }
      ]
    },
    {
      "requirementId": "REQ-002",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 17,
          "lineEnd": 21,
          "quote": "return () => {\n\t\tsignals.delete(signal);\n\t\tif (signals.size === 0 && launchSignals.get(key) === signals)\n\t\t\tlaunchSignals.delete(key);\n\t};"
        }
      ]
    },
    {
      "requirementId": "REQ-003",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 24,
          "lineEnd": 28,
          "quote": "function launchStopRequested(cwd: string, runId: string): boolean {\n\treturn [...(launchSignals.get(workflowRunPath(cwd, runId)) ?? [])].some(\n\t\t(signal) => signal.aborted,\n\t);\n}"
        }
      ]
    },
    {
      "requirementId": "REQ-004",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 30,
          "lineEnd": 30,
          "quote": "export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = \"WorkflowStopRequested\";"
        },
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 43,
          "lineEnd": 51,
          "quote": "export function workflowStopRequestedMessage(runId: string): string {\n\treturn `workflow stop requested for ${runId}`;\n}\n\nexport function createWorkflowStopRequestedError(runId: string): Error {\n\tconst error = new Error(workflowStopRequestedMessage(runId));\n\terror.name = WORKFLOW_STOP_REQUESTED_ERROR_NAME;\n\treturn error;\n}"
        }
      ]
    },
    {
      "requirementId": "REQ-005",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 30,
          "lineEnd": 30,
          "quote": "export const WORKFLOW_STOP_REQUESTED_ERROR_NAME = \"WorkflowStopRequested\";"
        },
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 53,
          "lineEnd": 59,
          "quote": "export function isWorkflowStopRequestedError(error: unknown): boolean {\n\treturn (\n\t\terror instanceof Error &&\n\t\t(error.name === WORKFLOW_STOP_REQUESTED_ERROR_NAME ||\n\t\t\terror.message.startsWith(\"workflow stop requested\"))\n\t);\n}"
        }
      ]
    },
    {
      "requirementId": "REQ-006",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 31,
          "lineEnd": 41,
          "quote": "const WORKFLOW_STOP_PENDING_ERROR_NAME = \"WorkflowStopPending\";\n\nexport function createWorkflowStopPendingError(message: string): Error {\n\tconst error = new Error(message);\n\terror.name = WORKFLOW_STOP_PENDING_ERROR_NAME;\n\treturn error;\n}\n\nexport function isWorkflowStopPendingError(error: unknown): error is Error {\n\treturn error instanceof Error && error.name === WORKFLOW_STOP_PENDING_ERROR_NAME;\n}"
        }
      ]
    },
    {
      "requirementId": "REQ-007",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 93,
          "lineEnd": 98,
          "quote": "if (launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);\n\tconst intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
          "relevance": "Both launch abort and durable intent lead to the specified error."
        }
      ]
    },
    {
      "requirementId": "REQ-008",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 95,
          "lineEnd": 98,
          "quote": "const intent = await readWorkflowStopIntent(cwd, runId);\n\t// Cancellation may have arrived while the disk read was in flight.\n\tif (intent || launchStopRequested(cwd, runId))\n\t\tthrow createWorkflowStopRequestedError(runId);",
          "relevance": "After the awaited read, launch state is checked when intent has not already established a stop."
        }
      ]
    },
    {
      "requirementId": "REQ-009",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 64,
          "lineEnd": 67,
          "quote": "options: { pollMs?: number } = {},\n): { signal: AbortSignal; dispose: () => void } {\n\tconst controller = new AbortController();\n\tconst pollMs = Math.max(10, options.pollMs ?? 50);"
        },
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 80,
          "lineEnd": 86,
          "quote": "void check();\n\tconst timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),\n\t};"
        }
      ]
    },
    {
      "requirementId": "REQ-010",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 70,
          "lineEnd": 78,
          "quote": "if (launchStopRequested(cwd, runId)) {\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));\n\t\t\treturn;\n\t\t}\n\t\tconst intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));"
        },
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 84,
          "lineEnd": 84,
          "quote": "signal: controller.signal,"
        }
      ]
    },
    {
      "requirementId": "REQ-011",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 74,
          "lineEnd": 78,
          "quote": "const intent = await readWorkflowStopIntent(cwd, runId).catch(\n\t\t\t() => undefined,\n\t\t);\n\t\tif (intent || launchStopRequested(cwd, runId))\n\t\t\tcontroller.abort(createWorkflowStopRequestedError(runId));",
          "relevance": "Read rejection becomes undefined rather than durable stop intent."
        }
      ]
    },
    {
      "requirementId": "REQ-012",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-stop.ts",
          "lineStart": 81,
          "lineEnd": 85,
          "quote": "const timer = setInterval(() => void check(), pollMs);\n\ttimer.unref?.();\n\treturn {\n\t\tsignal: controller.signal,\n\t\tdispose: () => clearInterval(timer),",
          "relevance": "The interval is unreferenced and disposal clears it."
        }
      ]
    },
    {
      "requirementId": "REQ-013",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 2,
          "lineEnd": 6,
          "quote": "export function isWorkflowAbortError(value: unknown): boolean {\n\tif (typeof DOMException !== \"undefined\" && value instanceof DOMException)\n\t\treturn value.name === \"AbortError\";\n\treturn isRecord(value) && value.name === \"AbortError\";\n}"
        },
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 35,
          "lineEnd": 37,
          "quote": "function isRecord(value: unknown): value is Record<string, unknown> {\n\treturn typeof value === \"object\" && value !== null && !Array.isArray(value);\n}"
        }
      ]
    },
    {
      "requirementId": "REQ-014",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 16,
          "lineEnd": 18,
          "quote": "if (value.cancelled === true) return true;\n\tconst details = isRecord(value.details) ? value.details : undefined;\n\tif (details?.cancelled === true) return true;"
        }
      ]
    },
    {
      "requirementId": "REQ-015",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 19,
          "lineEnd": 22,
          "quote": "for (const candidate of [value.error, details?.error, value.reason, details?.reason]) {\n\t\tif (candidate === \"aborted\" || candidate === \"AbortError\" || candidate === \"ABORT_ERR\") return true;\n\t\tif (isWorkflowAbortError(candidate)) return true;\n\t}"
        }
      ]
    },
    {
      "requirementId": "REQ-016",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 23,
          "lineEnd": 31,
          "quote": "if (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;\n\t\t\ttry {\n\t\t\t\tconst parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;\n\t\t\t} catch { /* ordinary provider text */ }\n\t\t}\n\t}",
          "relevance": "Decoded text content is passed recursively through the same cancellation recognizer."
        }
      ]
    },
    {
      "requirementId": "REQ-017",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-cancellation.ts",
          "lineStart": 13,
          "lineEnd": 33,
          "quote": "export function isWorkflowReturnedCancellation(value: unknown): boolean {\n\tif (isWorkflowAbortError(value)) return true;\n\tif (!isRecord(value)) return false;\n\tif (value.cancelled === true) return true;\n\tconst details = isRecord(value.details) ? value.details : undefined;\n\tif (details?.cancelled === true) return true;\n\tfor (const candidate of [value.error, details?.error, value.reason, details?.reason]) {\n\t\tif (candidate === \"aborted\" || candidate === \"AbortError\" || candidate === \"ABORT_ERR\") return true;\n\t\tif (isWorkflowAbortError(candidate)) return true;\n\t}\n\tif (Array.isArray(value.content)) {\n\t\tfor (const entry of value.content) {\n\t\t\tif (!isRecord(entry) || typeof entry.text !== \"string\") continue;\n\t\t\ttry {\n\t\t\t\tconst parsed: unknown = JSON.parse(entry.text);\n\t\t\t\tif (parsed !== value && isWorkflowReturnedCancellation(parsed)) return true;\n\t\t\t} catch { /* ordinary provider text */ }\n\t\t}\n\t}\n\treturn false;\n}",
          "relevance": "Unrelated errors have no acceptance path; parsed content must also satisfy the explicit recognizer."
        }
      ]
    },
    {
      "requirementId": "REQ-018",
      "status": "covered",
      "evidence": [
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 76,
          "lineEnd": 78,
          "quote": "const terminal = isTerminalWorkflowStatus(run.status);\n\tlet semanticStatus: WorkflowSemanticStatus = nonDynamicSemanticStatus(run);\n\tlet outputTaskIds = finalStageTasks(run.tasks).map((task) => task.specId);"
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 98,
          "lineEnd": 112,
          "quote": "return {\n\t\tterminal,\n\t\tengineStatus: run.status,\n\t\tsemanticStatus,\n\t\toutputTaskIds,\n\t\toutputRetryAttempts: run.tasks.reduce(\n\t\t\t(total, task) => total + (task.outputRetry?.attempts ?? 0),\n\t\t\t0,\n\t\t),\n\t\tlaunchRetryAttempts: run.tasks.reduce(\n\t\t\t(total, task) => total + (task.launchRetry?.attempts ?? 0),\n\t\t\t0,\n\t\t),\n\t\tartifactRoot: workflowRunDir(cwd, run.runId),\n\t};"
        }
      ]
    },
    {
      "requirementId": "REQ-019",
      "status": "unclear",
      "evidence": [
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 67,
          "lineEnd": 69,
          "quote": "if (run.status === \"completed\")\n\t\treturn run.degradation ? \"completed_degraded\" : \"completed\";\n\treturn run.status;",
          "relevance": "The baseline implements degradation reporting."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 80,
          "lineEnd": 87,
          "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "relevance": "Direct-dynamic routing overrides the degradation baseline; SPEC items 12 and 13 do not explicitly state their precedence."
        }
      ]
    },
    {
      "requirementId": "REQ-020",
      "status": "partial",
      "evidence": [
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 52,
          "lineEnd": 61,
          "quote": "const controller = run.tasks.find(\n\t\t(task) =>\n\t\t\ttask.specId === \"dynamic.controller\" ||\n\t\t\ttask.statusDetail === \"dynamic_completed\",\n\t);\n\tif (!controller) return undefined;\n\tconst taskOutput = fromProjectPath(cwd, controller.files.output);\n\treturn await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);"
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 80,
          "lineEnd": 95,
          "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";\n\t\telse if (control?.status === \"exhausted\")\n\t\t\tsemanticStatus =\n\t\t\t\toutputTaskIds.length > 0\n\t\t\t\t\t? \"exhausted_with_output\"\n\t\t\t\t\t: \"exhausted_without_output\";\n\t\telse if (control?.status === \"blocked\") semanticStatus = \"dynamic_blocked\";\n\t\telse if (control?.status === \"stopped\") semanticStatus = \"dynamic_stopped\";\n\t\telse semanticStatus = \"completed_without_semantic_result\";",
          "relevance": "Control-derived statuses exist, but the task-level incomplete marker takes precedence; linked to finding-001."
        }
      ]
    },
    {
      "requirementId": "REQ-021",
      "status": "partial",
      "evidence": [
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 59,
          "lineEnd": 61,
          "quote": "return await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
          "relevance": "A rejected control read becomes undefined."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 83,
          "lineEnd": 86,
          "quote": "const incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";",
          "relevance": "This branch bypasses the unreadable-control fallback; linked to finding-001."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 95,
          "lineEnd": 95,
          "quote": "else semanticStatus = \"completed_without_semantic_result\";",
          "relevance": "The specified fallback is present only after higher-priority branches."
        }
      ]
    }
  ],
  "finalFindings": [
    {
      "id": "finding-001",
      "verdict": "KEEP",
      "severity": "medium",
      "title": "Task incomplete marker overrides controller status and unreadable-control fallback",
      "requirementIds": [
        "REQ-020",
        "REQ-021"
      ],
      "claim": "For a terminal direct-dynamic run containing any task marked dynamic_incomplete, summarizeWorkflowTerminal returns dynamic_incomplete even when the controller control.json read rejects, contrary to SPEC 13's completed_without_semantic_result requirement. The same task-marker precedence overrides readable controller statuses.",
      "evidence": [
        {
          "file": "SPEC.md",
          "lineStart": 49,
          "lineEnd": 51,
          "quote": "13. Terminal direct-dynamic runs derive their semantic status from the dynamic\n    controller's `control.json`; an unreadable control yields\n    `completed_without_semantic_result`.",
          "relevance": "Requires controller-derived semantics and explicitly specifies the unreadable-control result."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 59,
          "lineEnd": 61,
          "quote": "return await readJson<DynamicControllerControl>(\n\t\tjoin(dirname(taskOutput), \"control.json\"),\n\t).catch(() => undefined);",
          "relevance": "A rejected controller read produces undefined."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 80,
          "lineEnd": 87,
          "quote": "if (terminal && run.provenance?.mode === \"direct-dynamic\") {\n\t\tconst control = await readDynamicControllerControl(cwd, run);\n\t\toutputTaskIds = stringArray(control?.outputTasks);\n\t\tconst incomplete = run.tasks.some(\n\t\t\t(task) => task.statusDetail === \"dynamic_incomplete\",\n\t\t);\n\t\tif (incomplete) semanticStatus = \"dynamic_incomplete\";\n\t\telse if (control?.status === \"synthesized\") semanticStatus = \"synthesized\";",
          "relevance": "Any incomplete task wins regardless of controller readability or status."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 93,
          "lineEnd": 95,
          "quote": "else if (control?.status === \"blocked\") semanticStatus = \"dynamic_blocked\";\n\t\telse if (control?.status === \"stopped\") semanticStatus = \"dynamic_stopped\";\n\t\telse semanticStatus = \"completed_without_semantic_result\";",
          "relevance": "The required fallback is subordinate to the task-marker branch."
        }
      ],
      "counterEvidence": [
        {
          "file": "SPEC.md",
          "lineStart": 3,
          "lineEnd": 4,
          "quote": "This spec covers `src/workflow-stop.ts`, `src/workflow-cancellation.ts` and\n`src/workflow-terminal.ts`. `store.js` and `types.js` are outside this sample.",
          "relevance": "Limits verification of production run invariants and concrete persisted fixtures."
        },
        {
          "file": "src/workflow-terminal.ts",
          "lineStart": 23,
          "lineEnd": 23,
          "quote": "| \"dynamic_incomplete\"",
          "relevance": "The implementation deliberately supports this semantic status, but its existence does not establish a specification exception."
        }
      ],
      "recommendedAction": "Make terminal direct-dynamic semantic status follow controller control.json, including unconditional unreadable-control fallback. Add regression cases combining an incomplete task with a rejected control read and with a readable synthesized controller status.",
      "originalCandidate": {
        "id": "finding-001",
        "requirementIds": [
          "REQ-020",
          "REQ-021"
        ],
        "severity": "medium",
        "title": "Task incomplete marker overrides controller status and unreadable-control fallback",
        "claim": "For a terminal direct-dynamic run containing a task marked dynamic_incomplete, summarizeWorkflowTerminal selects dynamic_incomplete even when reading control.json rejects. This bypasses the explicitly required completed_without_semantic_result fallback. The same branch also overrides readable controller status.",
        "specEvidence": [
          "SPEC.md:49-51 requires terminal direct-dynamic semantic status to derive from controller control.json and says an unreadable control yields completed_without_semantic_result."
        ],
        "implementationEvidence": [
          "src/workflow-terminal.ts:59-61 converts a rejected control.json read into undefined.",
          "src/workflow-terminal.ts:80-86 selects dynamic_incomplete from run.tasks before examining control.status.",
          "src/workflow-terminal.ts:87-95 reaches controller-derived statuses and completed_without_semantic_result only when no incomplete task was found."
        ],
        "testEvidence": [],
        "uncertainty": "This is an unexecuted static counterexample; the sample excludes run types and store helpers. An independent verifier should seek repository evidence that excludes terminal direct-dynamic runs with an incomplete task and unreadable control, or establishes an allowed precedence exception, rather than merely confirming the branch wording."
      }
    }
  ],
  "droppedFindings": [],
  "needsHuman": [
    {
      "source": "candidate-source",
      "id": "degradation-precedence",
      "requirementIds": [
        "REQ-019"
      ],
      "origin": {
        "kind": "candidate-source"
      },
      "reason": "SPEC item 12 requires completed_degraded for completed runs with degradation, while item 13 assigns controller-derived semantics to terminal direct-dynamic runs. Source implements the degradation baseline but overrides it for direct-dynamic runs; precedence between these requirements is not explicit.",
      "uncertainty": "Item 13 may be an intended specialization of item 12. No separate violation is asserted for this overlap.",
      "finalClaim": "No final verifier claim was supplied; the item remains unresolved.",
      "recommendedAction": "Clarify whether terminal direct-dynamic semantics override completed_degraded, or establish that degraded completed runs cannot enter that branch.",
      "evidenceStatus": "unavailable"
    }
  ],
  "missingVerifications": [],
  "invalidVerifierResults": [],
  "orphanVerifierResults": [],
  "noIssueNotes": [
    "No additional stop or cancellation gap candidates were identified within the explicitly specified input shapes.",
    "No tests were found, but SPEC.md does not require tests; test absence is not treated as an implementation violation.",
    "No additional contracts were inferred for invalid poll intervals, duplicate signal bindings, pending reads after disposal, or unspecified cancellation payload shapes."
  ],
  "scopeLimitations": [
    {
      "kind": "NONBLOCKING",
      "text": "Read-only inspection only; commands and test execution are prohibited by this stage.",
      "blocking": false
    },
    {
      "kind": "NONBLOCKING",
      "text": "store.js and types.js are intentionally excluded from this sample; their implementations and any external tests were unavailable.",
      "blocking": false
    },
    {
      "kind": "NONBLOCKING",
      "text": "The requested ./schemas schema file was absent; the matching workflow-bundled schema was read for manual validation.",
      "blocking": false
    },
    {
      "kind": "NONBLOCKING",
      "text": "No tests or fixtures were found; coverage assessments use static implementation evidence, not runtime execution.",
      "blocking": false
    }
  ],
  "testExecutionAttested": false,
  "readProjection": {
    "candidateIds": [
      "finding-001"
    ],
    "requirementIds": [
      "REQ-001",
      "REQ-002",
      "REQ-003",
      "REQ-004",
      "REQ-005",
      "REQ-006",
      "REQ-007",
      "REQ-008",
      "REQ-009",
      "REQ-010",
      "REQ-011",
      "REQ-012",
      "REQ-013",
      "REQ-014",
      "REQ-015",
      "REQ-016",
      "REQ-017",
      "REQ-018",
      "REQ-019",
      "REQ-020",
      "REQ-021"
    ],
    "finalIds": [
      "finding-001"
    ],
    "droppedIds": [],
    "needsHumanIds": [
      "degradation-precedence"
    ]
  }
}
</control>
<analysis>
Support helper completed deterministically.
</analysis>
<refs>
[]
</refs>