import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<ROOT>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "<WF_RUN_1>",
		"taskId": "task-13",
		"manifestPath": "<ROOT>/.pi/workflows/<WF_RUN_1>/tasks/task-13/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/<WF_RUN_1>/tasks/task-13/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/<WF_RUN_1>"
	});
}
