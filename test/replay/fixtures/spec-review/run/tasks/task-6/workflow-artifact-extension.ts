import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<PKG>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "workflow_mvoufde9_8566f1",
		"taskId": "task-6",
		"manifestPath": "<ROOT>/.pi/workflows/workflow_mvoufde9_8566f1/tasks/task-6/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/workflow_mvoufde9_8566f1/tasks/task-6/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/workflow_mvoufde9_8566f1"
	});
}
