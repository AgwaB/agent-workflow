import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowArtifactTool } from "file://<ROOT>/dist/workflow-artifact-extension.js";

export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowArtifactTool(pi, {
		"runId": "workflow_mvotu0ko_b9761d",
		"taskId": "task-9",
		"manifestPath": "<ROOT>/.pi/workflows/workflow_mvotu0ko_b9761d/tasks/task-9/source-manifest.json",
		"ledgerPath": "<ROOT>/.pi/workflows/workflow_mvotu0ko_b9761d/tasks/task-9/read-ledger.jsonl",
		"accessMode": "workflow-task",
		"runDir": "<ROOT>/.pi/workflows/workflow_mvotu0ko_b9761d"
	});
}
