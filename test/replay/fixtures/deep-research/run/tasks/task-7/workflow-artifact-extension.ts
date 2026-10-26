import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<PKG>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "workflow_mvouzm7h_b19c26",
		"taskId": "task-7",
		"manifestPath": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26/tasks/task-7/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26/tasks/task-7/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26"
	});
}
