import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<PKG>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "workflow_mvouzm7h_b19c26",
		"taskId": "task-5",
		"manifestPath": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26/tasks/task-5/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26/tasks/task-5/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26"
	});
}
