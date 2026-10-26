<control>{
  "schema": "stage-control-v1",
  "digest": "Mapped recorder unit coverage, three replay fixtures, backend/package smoke checks, documentation, release artifacts, and unexecuted validation commands.",
  "tests": [
    {
      "id": "recorder-unit",
      "path": "test/unit/replay-self-consistency.test.mjs",
      "lines": [217, 257],
      "coverage": [
        "Unset environment returns the original API object",
        "Sync success, async success, and async rejection",
        "Call sequence, method names, and sync flags",
        "AbortSignal and callback placeholders",
        "Error name, message, and code",
        "Sorted method surface file"
      ],
      "status": "inspected-not-run"
    },
    {
      "id": "engine-self-replay",
      "path": "test/unit/replay-self-consistency.test.mjs",
      "lines": [137, 215],
      "coverage": [
        "Fixture-driven engine replay",
        "Expected terminal status",
        "All recorded effectful calls consumed",
        "Normalized recorded/replayed artifact-tree equality",
        "Committed normalized snapshots remain current",
        "Manifest digest binding",
        "Changed worker launch is rejected"
      ],
      "dependencies": [
        "dist/engine.js",
        "dist/subagent-backend.js",
        "test/replay/replay-subagent-api.mjs",
        "test/replay/normalize.mjs",
        "test/replay/allowed-differences.json"
      ],
      "limitation": "Replay injects an API through setSubagentApiForTests and clears PI_WORKFLOW_RECORD_DIR; it does not exercise the new dynamic-import wrapping path.",
      "status": "inspected-not-run"
    },
    {
      "id": "replay-fixtures",
      "root": "test/replay/fixtures",
      "fixtures": [
        {
          "name": "minimal",
          "expectedStatus": "completed",
          "example": "project/workflow.json"
        },
        {
          "name": "deep-review",
          "expectedStatus": "completed",
          "workflow": "workflows/deep-review/spec.json"
        },
        {
          "name": "spec-review",
          "expectedStatus": "failed",
          "workflow": "workflows/spec-review/spec.json"
        }
      ],
      "layout": [
        "fixture.json",
        "project/",
        "record/calls.jsonl",
        "record/api-surface.json",
        "record/run/",
        "record/subagent-runs/",
        "normalized/"
      ],
      "provenance": "Fixture metadata names base b83cc4f and the recording-seam branch; launch concurrency is pinned to 6.",
      "status": "inspected-not-replayed"
    },
    {
      "id": "backend-regression",
      "path": "test/unit/subagent-extension-preflight.test.mjs",
      "coverage": [
        "runOneShotSubagentCall forwarding",
        "Optional explicit-extension-isolation capability",
        "Unsupported capability rejection",
        "Extension preflight behavior"
      ],
      "limitation": "API-call assertions use injected fakes, bypassing recorder activation.",
      "status": "inspected-not-run"
    },
    {
      "id": "installed-api-boundary",
      "path": "test/unit/runtime-bundled-api-boundary.test.mjs",
      "coverage": [
        "Installed pi-subagent function surface",
        "Real local durable-barrier release/revoke arbitration",
        "Authority validation"
      ],
      "limitation": "Imports pi-subagent directly rather than through the recorder.",
      "status": "inspected-not-run"
    },
    {
      "id": "packed-consumer",
      "paths": [
        "test/e2e/run.mjs",
        "test/e2e/cases/packed-web-loader.mjs"
      ],
      "coverage": [
        "Packed public API import",
        "Bundled pi-subagent version and optional API surface",
        "CLI loading",
        "Offline/no-external-actions smoke checks"
      ],
      "limitation": "No recorder-enabled packed-consumer assertion was located.",
      "status": "inspected-not-run"
    }
  ],
  "docs": [
    {
      "paths": [
        "src/subagent-api-recorder.ts",
        "src/subagent-backend.ts"
      ],
      "kind": "inline-contract",
      "topics": [
        "PI_WORKFLOW_RECORD_DIR activation",
        "JSONL call shape",
        "Serialization placeholders",
        "Constructor passthrough",
        "Default inert behavior"
      ]
    },
    {
      "paths": [
        "test/unit/replay-self-consistency.test.mjs",
        "test/replay/replay-subagent-api.mjs",
        "test/replay/normalize.mjs",
        "test/replay/allowed-differences.json"
      ],
      "kind": "validation-contract",
      "topics": [
        "Replay matching and consumption",
        "Observation polling tolerance",
        "Restored filesystem effects",
        "Normalization and documented allowed differences"
      ]
    },
    {
      "paths": [
        "test/replay/fixtures/minimal/project/workflow.json",
        "test/replay/fixtures/minimal/project/NOTES.md",
        "test/replay/fixtures/minimal/project/agents/wp1a-reader.md"
      ],
      "kind": "fixture-example",
      "topics": ["Minimal read-only recording/replay workflow"]
    },
    {
      "paths": [
        "CONTRIBUTING.md",
        "docs/usage.md"
      ],
      "kind": "public-validation-guidance",
      "topics": [
        "Locked dependency installation",
        "Runtime changes require validate and E2E",
        "Package changes additionally require package dry run",
        "Supported Node and OS matrix"
      ]
    },
    {
      "paths": [
        "internal/record/run-minimal.mjs",
        "internal/record/run-bundled.mjs",
        "internal/record/capture-run.mjs",
        "internal/record/make-portable.mjs",
        "internal/record/compact-calls.mjs",
        "internal/record/build-fixture.mjs"
      ],
      "kind": "local-only-recording-tooling",
      "topics": [
        "Real and fake recording drivers",
        "Capture, portability, call compaction, and fixture generation"
      ],
      "distribution": "Ignored internal directory; not a shipped recording toolchain."
    }
  ],
  "releaseArtifacts": [
    {
      "paths": ["package.json", "tsconfig.json", ".gitignore"],
      "relationship": "Package files include src and dist; TypeScript compiles src/**/*.ts with declarations. Generated dist is ignored by Git.",
      "expectedOutputs": [
        "dist/subagent-api-recorder.js",
        "dist/subagent-api-recorder.d.ts",
        "dist/subagent-backend.js",
        "dist/subagent-backend.d.ts"
      ],
      "observed": "All four output paths exist; no build was performed."
    },
    {
      "paths": ["package.json", "src/index.ts"],
      "relationship": "Root API remains dist/index.js and extension entry remains src/extension.ts; no recorder re-export or dedicated package export was located.",
      "packageVersionObserved": "0.16.4"
    },
    {
      "paths": [
        "tools/release/check-public-surface.mjs",
        "tools/release/release-check.mjs"
      ],
      "relationship": "Public-surface checks reject tracked internal tooling/local paths; release checks inspect packed contents and exclude test/ and internal/.",
      "limitation": "The release required-file list does not explicitly name the recorder."
    },
    {
      "paths": [".github/workflows/ci.yml", ".github/workflows/publish.yml"],
      "relationship": "CI runs validate, E2E, and pack dry run on Ubuntu/macOS with Node 22.19.0 and 24; publish validation invokes release:check."
    }
  ],
  "validationCommandsMentioned": [
    {
      "command": "npm ci --legacy-peer-deps",
      "sources": ["CONTRIBUTING.md", "docs/usage.md", ".github/workflows/ci.yml"],
      "purpose": "Checkout setup",
      "status": "not-run"
    },
    {
      "command": "npm run validate",
      "sources": ["package.json", "CONTRIBUTING.md", ".github/workflows/ci.yml"],
      "includes": [
        "check:scripts",
        "check:release-workflow",
        "check:public-surface",
        "typecheck",
        "test:unit"
      ],
      "status": "not-run"
    },
    {
      "command": "npm run build",
      "sources": ["package.json", "test/unit/replay-self-consistency.test.mjs"],
      "purpose": "Generate dist, required by recorder/replay tests",
      "status": "not-run"
    },
    {
      "command": "npm run test:unit",
      "sources": ["package.json"],
      "includes": [
        "npm run build",
        "npm run test:build",
        "node --test test/unit/*.test.mjs"
      ],
      "purpose": "Includes replay-self-consistency and backend regression tests",
      "status": "not-run"
    },
    {
      "command": "npm run e2e",
      "sources": ["package.json", "CONTRIBUTING.md", ".github/workflows/ci.yml"],
      "purpose": "Runtime and packed-consumer smoke validation",
      "status": "not-run"
    },
    {
      "command": "npm run pack:dry",
      "sources": ["package.json", "CONTRIBUTING.md", ".github/workflows/ci.yml"],
      "expandsTo": "npm pack --dry-run --json --ignore-scripts",
      "purpose": "Inspect package contents; does not build automatically",
      "status": "not-run"
    },
    {
      "command": "npm run release:check",
      "sources": ["package.json", ".github/workflows/publish.yml"],
      "purpose": "Release checks, tests, build, package inspection, and conditional registry/publish dry-run checks",
      "status": "not-run"
    },
    {
      "command": "normalize.mjs <recordOrRunDir> <outDir> [--root P] [--pkg P] [--home P] [--tmp P] [--allowed FILE | --no-allowed]",
      "sources": ["test/replay/normalize.mjs"],
      "purpose": "Generate normalized comparison artifacts",
      "status": "not-run"
    },
    {
      "command": "normalize.mjs --compare <dirA> <dirB>",
      "sources": ["test/replay/normalize.mjs"],
      "purpose": "Compare normalized artifact trees",
      "status": "not-run"
    },
    {
      "command": "run-minimal.mjs <projectDir> <recordDir> [--fake]",
      "sources": ["internal/record/run-minimal.mjs"],
      "purpose": "Local recording-driver exercise; real execution unless --fake",
      "status": "not-run"
    },
    {
      "command": "run-bundled.mjs <workflow> <projectDir> <recordDir> --task <text> [--profile <name>] [--input key=value ...] [--fake] [--timeout-min N]",
      "sources": ["internal/record/run-bundled.mjs"],
      "purpose": "Local bundled-workflow recording exercise",
      "status": "not-run"
    }
  ],
  "knownGaps": [
    {
      "id": "execution-evidence",
      "gap": "No commands were run. Test definitions, snapshots, and existing dist files are not fresh passing results."
    },
    {
      "id": "activation-integration",
      "gap": "No dedicated test located for real loadSubagentApi import wrapping, environment changes across cached loads, or injected-API bypass with recording enabled."
    },
    {
      "id": "serializer-and-forwarding",
      "gap": "Direct recorder coverage does not assert sync throws, constructor/value identity, receiver binding, undefined results, concurrent completion ordering, or most toRecordable branches and exceptional inputs."
    },
    {
      "id": "recording-filesystem",
      "gap": "No dedicated coverage located for directory/append failures, reused recording directories, or multiple wrappers/processes writing one directory."
    },
    {
      "id": "public-recording-guidance",
      "gap": "No recording-seam instructions located in README.md or searched public docs; operational drivers are ignored internal files."
    },
    {
      "id": "fixture-inventory",
      "gap": "Replay test comments describe minimal plus four bundled workflows, but the inspected fixture directory contains only minimal, deep-review, and spec-review."
    },
    {
      "id": "control-schema-location",
      "gap": "Requested ./schemas/validation-map-control.schema.json is absent at checkout root. The workflow-local contract was found at workflows/impact-review/schemas/validation-map-control.schema.json and checked structurally without executing a validator."
    }
  ]
}</control>

<analysis>
The closest direct validation is the recorder test at `test/unit/replay-self-consistency.test.mjs:217`. It checks three representative call outcomes and selected serialized fields, rather than the recorder’s entire serialization and forwarding contract.

The same file supplies broader engine compatibility evidence through three fixture-driven replays and one intentionally mismatched launch. Importantly, those replay tests clear the recording environment variable and inject their replay API. They validate consumption of recorded data and normalized engine output, not activation of the new wrapper inside `loadSubagentApi()`.

The fixtures contain recorded API calls, complete method-surface inventories, workflow artifacts, worker artifacts, and normalized snapshots. Their comparison is policy-qualified: observation polling can repeat, host-specific fields are normalized, and documented digest differences are allowed. Manifest digest assertions independently retain binding checks. The spec-review fixture intentionally expects a failed workflow; that is its baseline, not evidence of a failing test.

Package validation matters because the backend now imports another runtime module. Both source and generated JavaScript/declarations fall within package inclusion rules. Existing packed-consumer checks exercise module loading and the bundled dependency surface, but no recorder-enabled packed test was located. The local recording drivers demonstrate intended usage, although they are ignored maintenance files rather than distributable tooling.

No files were modified and no commands were executed. Confidence is high in the identified direct tests, fixture inventory, and package wiring; coverage-absence statements are limited to inspected files and targeted searches. The control object was manually checked against the located workflow schema: required strings are nonempty and all five evidence collections contain objects. No final risk verdict is made.
</analysis>

<refs>[
  {
    "id": "control-contract",
    "path": "workflows/impact-review/schemas/validation-map-control.schema.json"
  },
  {
    "id": "recorder",
    "path": "src/subagent-api-recorder.ts",
    "lines": [1, 197]
  },
  {
    "id": "loader",
    "path": "src/subagent-backend.ts",
    "lines": [484, 506]
  },
  {
    "id": "direct-recorder-test",
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": [217, 257]
  },
  {
    "id": "engine-replay-tests",
    "path": "test/unit/replay-self-consistency.test.mjs",
    "lines": [34, 215]
  },
  {
    "id": "replay-adapter",
    "path": "test/replay/replay-subagent-api.mjs"
  },
  {
    "id": "normalization-policy",
    "paths": [
      "test/replay/normalize.mjs",
      "test/replay/allowed-differences.json"
    ]
  },
  {
    "id": "fixture-metadata",
    "paths": [
      "test/replay/fixtures/minimal/fixture.json",
      "test/replay/fixtures/deep-review/fixture.json",
      "test/replay/fixtures/spec-review/fixture.json"
    ]
  },
  {
    "id": "fixture-surface-example",
    "path": "test/replay/fixtures/minimal/record/api-surface.json"
  },
  {
    "id": "backend-regressions",
    "paths": [
      "test/unit/subagent-extension-preflight.test.mjs",
      "test/unit/runtime-bundled-api-boundary.test.mjs"
    ]
  },
  {
    "id": "packed-smoke",
    "paths": [
      "test/e2e/run.mjs",
      "test/e2e/cases/packed-web-loader.mjs"
    ]
  },
  {
    "id": "package-build",
    "paths": ["package.json", "tsconfig.json", ".gitignore", "src/index.ts"]
  },
  {
    "id": "release-gates",
    "paths": [
      "tools/release/check-public-surface.mjs",
      "tools/release/release-check.mjs",
      ".github/workflows/ci.yml",
      ".github/workflows/publish.yml"
    ]
  },
  {
    "id": "validation-guidance",
    "paths": ["CONTRIBUTING.md", "docs/usage.md"]
  },
  {
    "id": "local-recording-toolchain",
    "paths": [
      "internal/record/run-minimal.mjs",
      "internal/record/run-bundled.mjs",
      "internal/record/build-fixture.mjs",
      "internal/record/compact-calls.mjs"
    ]
  },
  {
    "id": "generated-recorder-declaration",
    "path": "dist/subagent-api-recorder.d.ts"
  }
]</refs>