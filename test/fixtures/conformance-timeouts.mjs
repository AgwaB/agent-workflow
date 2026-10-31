// Conformance bounds for this repository's own adapter suites (stub CLIs, offline).
//
// The kit's defaults (callMs 5 s, streamMs 15 s, checkMs 60 s) are hang detectors for adapter
// authors. Here every contract call spawns a stub CLI process (Node start-up), and the unit suite
// runs many files in parallel: under that load a correct probe or submit measured 3.8–5.5 s, so the
// 5 s default failed checks for slowness, not for a hang. These bounds still fail a call that
// never settles; checks that use deliberately hanging adapters (conformance-negative) keep the
// defaults.
export const UNIT_CONFORMANCE_TIMEOUTS = Object.freeze({
	callMs: 30_000,
	streamMs: 60_000,
	checkMs: 240_000,
});
