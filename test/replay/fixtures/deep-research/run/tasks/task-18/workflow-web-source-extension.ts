import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import providerExtension0 from "file://<PKG>/node_modules/pi-web-access/index.ts";
const providerExtension = providerExtension0;
import { registerWorkflowWebSourceExtension } from "file://<PKG>/dist/workflow-web-source-extension.js";

export default function workflowWebSourceGeneratedExtension(pi: ExtensionAPI): void {
	registerWorkflowWebSourceExtension(pi as any, {
		"schema": "workflow-web-source-launch-config-v1",
		"runId": "workflow_mvouzm7h_b19c26",
		"taskId": "task-18",
		"cwd": "<ROOT>",
		"cacheDir": "<ROOT>/.pi/workflows/workflow_mvouzm7h_b19c26/web-source-cache",
		"provider": {
			"kind": "pi-web-access",
			"extensionPath": "<PKG>/node_modules/pi-web-access/index.ts",
			"extensionPaths": [
				"<PKG>/node_modules/pi-web-access/index.ts"
			],
			"usesPiWebAccess": true
		},
		"providerToolOwnerPaths": {
			"web_search": [
				"<PKG>/node_modules/pi-web-access/index.ts"
			],
			"fetch_content": [
				"<PKG>/node_modules/pi-web-access/index.ts"
			],
			"get_search_content": [
				"<PKG>/node_modules/pi-web-access/index.ts"
			]
		},
		"securityPolicy": {
			"allowPrivateHosts": false,
			"cacheRawProviderPayloads": false
		},
		"directFetchOnly": true,
		"exposedWorkflowTools": [
			"workflow_web_search",
			"workflow_web_fetch_source",
			"workflow_web_source_read"
		],
		"passthroughProviderTools": [],
		"requiredProviderTools": [
			"web_search"
		]
	}, providerExtension as any);
}
