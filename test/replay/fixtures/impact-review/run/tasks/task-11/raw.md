<control>{
  "schema": "stage-control-v1",
  "digest": "Needs work: default-off behavior is preserved, but activated-loader coverage, recording-failure policy, safe-use documentation, and fresh validation evidence are required.",
  "status": "needs-work",
  "requiredBeforeShip": [
    {
      "id": "loader-coverage",
      "owner": "Backend/test maintainer",
      "action": "Add isolated tests exercising the real, non-injected backend loader.",
      "acceptance": [
        "Unset and blank configuration do not create recording files.",
        "Enabled configuration creates surface metadata and records a forwarded call.",
        "Configuration caching, test cache reset, and injected-API bypass are verified."
      ],
      "evidenceRefs": ["loader", "tests"]
    },
    {
      "id": "recording-failure-contract",
      "owner": "Backend maintainer",
      "action": "Choose and document strict recording failure propagation or best-effort recording; test the selected policy.",
      "acceptance": [
        "Initialization, argument projection, and append failures have explicit expected behavior.",
        "Tests establish whether recording failures may prevent invocation, replace successful results, or mask original errors.",
        "Cached loader rejection behavior is covered."
      ],
      "evidenceRefs": ["recorder", "loader"]
    },
    {
      "id": "safe-use-documentation",
      "owner": "Documentation/security owner",
      "action": "Document PI_WORKFLOW_RECORD_DIR as an internal, default-off diagnostic control in docs/usage.md.",
      "acceptance": [
        "Explain first-load configuration caching and calls.jsonl/api-surface.json outputs.",
        "Warn that arguments, results, and errors are stored without redaction or automatic retention limits.",
        "Require a fresh private directory outside publish roots and one recording writer, including consideration of inherited child-process configuration.",
        "Describe manual cleanup, review before sharing, synchronous overhead, and the selected failure policy."
      ],
      "evidenceRefs": ["recorder", "loader", "usage"]
    },
    {
      "id": "fresh-validation",
      "owner": "CI/test owner",
      "commands": [
        "npm run build && node --test test/unit/replay-self-consistency.test.mjs",
        "npm run validate",
        "npm run e2e"
      ],
      "acceptance": "Record passing results against the candidate revision, including the added boundary and failure-policy tests.",
      "evidenceRefs": ["validation", "package"]
    },
    {
      "id": "publish-verification",
      "owner": "Release owner",
      "condition": "Before npm publication",
      "commands": [
        "npm run pack:dry",
        "npm run release:check"
      ],
      "acceptance": [
        "After a fresh build, verify src/subagent-api-recorder.ts, dist/subagent-api-recorder.js, and dist/subagent-api-recorder.d.ts are packaged.",
        "Confirm generated recordings and sensitive local artifacts are absent from the package.",
        "Run release checks in the established release environment; registry/authentication checks were not assessed here."
      ],
      "evidenceRefs": ["package", "release"]
    }
  ],
  "niceToHave": [
    {
      "id": "broader-unit-coverage",
      "action": "Expand serializer and forwarding tests for constructors/values, receiver and identity preservation, unusual values, cycles, and out-of-order asynchronous completion."
    },
    {
      "id": "artifact-hardening",
      "action": "Consider explicit restrictive permissions, redaction controls, and size/retention limits before broader operational use."
    },
    {
      "id": "session-isolation",
      "action": "Add session identifiers or reject reused/shared recording directories.",
      "promotionCondition": "Required if shared-directory or multi-process recording is intended to be supported."
    },
    {
      "id": "enabled-mode-performance",
      "action": "Measure large-payload and polling workloads before considering buffered/asynchronous writes or making performance claims."
    },
    {
      "id": "packed-activation-automation",
      "action": "Automate recorder-enabled backend activation in the packed-consumer smoke suite."
    }
  ],
  "assumptions": [
    {
      "id": "scope",
      "statement": "The supplied b83cc4f..7e813aa diff defines the two-file change; adjacent files were inspected only for readiness evidence."
    },
    {
      "id": "operating-model",
      "statement": "Recording remains opt-in, operator-controlled, and intended for bounded single-writer diagnostics rather than production audit logging."
    },
    {
      "id": "upstream-completeness",
      "statement": "All three required upstream control artifacts were read using complete, non-truncated root JSON projections."
    },
    {
      "id": "execution",
      "statement": "No files were modified and no tests, builds, benchmarks, package operations, or registry checks were executed."
    },
    {
      "id": "schema-validation",
      "statement": "The requested ./schemas/ship-readiness-control.schema.json was absent. This control object was manually checked against workflows/impact-review/schemas/ship-readiness-control.schema.json; no executable schema validator was run."
    },
    {
      "id": "confidence",
      "statement": "High confidence in inspected activation and recording behavior; readiness remains conditional on test execution and owner decisions."
    }
  ]
}</control>

<analysis>
Ship recommendation: needs-work, not an unconditional block on the design. With the variable unset or blank, the loader retains the real API object and avoids recording writes. No workflow migration, new dependency, or package export is indicated.

The release-critical issue is the enabled-mode contract. Argument serialization happens before API invocation; filesystem initialization can reject the cached loader promise; outcome recording can turn success into failure or replace an original exception. Therefore, enabled recording is not behavior-transparent. A deliberate, tested strict diagnostic policy is acceptable; best-effort recording is not automatically required.

Existing tests cover direct-wrapper happy paths and replay compatibility, but replay explicitly clears the recording variable and injects an API. They do not establish that the changed production loader activates correctly. No upstream lens supplied execution results, so green validation remains an outstanding release gate rather than an observed failure.

Documentation is also required for safe diagnostic use: records contain unredacted plaintext, permissions depend on the surrounding filesystem/umask, and retention is unbounded. Reusing a directory appends calls while sequence numbers restart and surface metadata is overwritten. Fresh private, single-writer directories are a proportionate initial restriction; shared-session support, redaction, rotation, and performance redesign remain optional unless broader use is promised.

Packaging configuration already includes src and dist, but inclusion and exclusion of sensitive recordings still require verification from a fresh build. The control object satisfies the inspected schema’s required fields, status enum, and object-array types by manual inspection; automated validation was unavailable.
</analysis>

<refs>[
  {
    "id": "validation",
    "source": "impact-analysis.validation-impact",
    "artifact": "control",
    "path": "$",
    "originalChars": 5207,
    "charsTruncated": false
  },
  {
    "id": "docs-release",
    "source": "impact-analysis.docs-release-impact",
    "artifact": "control",
    "path": "$",
    "originalChars": 2895,
    "charsTruncated": false
  },
  {
    "id": "security-performance",
    "source": "impact-analysis.security-performance-impact",
    "artifact": "control",
    "path": "$",
    "originalChars": 3224,
    "charsTruncated": false
  },
  {
    "id": "loader",
    "path": "src/subagent-backend.ts",
    "lines": "484-506"
  },
  {
    "id": "recorder",
    "path": "src/subagent-api-recorder.ts",
    "lines": "24-197"
  },
  {
    "id": "tests",
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": "49-62,174-215,254-295"
  },
  {
    "id": "usage",
    "path": "docs/usage.md",
    "lines": "391-402"
  },
  {
    "id": "package",
    "path": "package.json",
    "lines": "8-64"
  },
  {
    "id": "release",
    "path": "tools/release/release-check.mjs",
    "lines": "182-328"
  },
  {
    "id": "schema-contract",
    "path": "workflows/impact-review/schemas/ship-readiness-control.schema.json"
  }
]</refs>