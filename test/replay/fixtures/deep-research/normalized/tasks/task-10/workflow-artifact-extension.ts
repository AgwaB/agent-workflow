import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<PKG>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "<WF_RUN_1>",
		"taskId": "task-10",
		"manifestPath": "<ROOT>/.pi/workflows/<WF_RUN_1>/tasks/task-10/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/<WF_RUN_1>/tasks/task-10/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/<WF_RUN_1>"
	});
}
