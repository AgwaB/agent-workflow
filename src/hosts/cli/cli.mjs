#!/usr/bin/env node
// Stub CLI for @agwab/agent-workflow. Real commands arrive in WP11a.

const usage = `Usage: agent-workflow <command> [options]

agent-workflow is a pre-alpha skeleton (WP0). No commands are implemented yet.

Planned commands (WP11a):
  run, dynamic, status, wait, stop, resume, list, show,
  validate, inspect, prune, notices, supervise

Options:
  -h, --help     Show this help and exit
`;

process.stdout.write(usage);
process.exitCode = 0;
