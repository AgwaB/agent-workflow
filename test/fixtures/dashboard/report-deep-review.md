# Deep review report

## Executive summary

### Core conclusion

Verdict: **NEEDS_WORK**. The deterministic ledger contains 4 kept or weakened findings and 0 needs-human items.

### Key findings

- **high / KEEP:** graceMs makes expired entries live ttlMs\+graceMs; the existing TTL test fails and nothing refreshes stale entries
- **high / KEEP:** Missing id returns 200 instead of 400
- **high / WEAKEN:** Unknown user never yields 404
- **high / KEEP:** Grace period lets responses be served up to 35s old, exceeding the 30s limit

### Evidence level

- Canonical rows: 4 kept or weakened findings, 0 needs-human items, and 0 supporting observations.
- Coverage: complete according to source-status accounting.

### Important limitations

- Evidence and quotes are bound to the reviewed snapshot available to the partition stage; final rendering does not re-read repository files and therefore does not attest current-tree bytes.

## Finding summary

| Severity | Count |
|---|---:|
| high | 4 |

## Synthesis narrative

Summary: The working-tree changes in src/cache.js and src/server.js should not go into a PR yet. The review kept three high-severity findings. First, the new graceMs logic lets expired entries live for ttlMs\+graceMs. This fails the existing TTL test, and nothing refreshes stale entries. Second, GET /users with a missing id returns 200 instead of 400. Third, the grace period lets responses be up to 35s old, which exceeds the 30s limit. A fourth finding, that an unknown user never yields 404, was downgraded to a medium contract gap. It only blocks the PR if this diff introduced it. All review sources completed, and there were no integrity or coverage issues.

## Risks and partial-review limitations

- The 404 finding was weakened, not confirmed as a blocker. Whether this diff introduced it, as opposed to it being a gap in the original loader, is unresolved and affects its severity.
- The packet's narrative sample strings were truncated in a few places (about 300 characters in total). Some recommended-action detail is abbreviated here, although the final ledger has the full findings.

Recommended synthesis action: Fix the three kept findings before opening the PR. Make graceMs opt-in with a default of 0, or remove it, so the existing TTL test passes and staleness stays within 30s. If stale-while-revalidate is wanted, have get() report staleness and refresh in the background. Make the /users handler in src/server.js return 400 when id is missing or empty, and add regression tests for both cases. Then check whether the unknown-user 404 gap came from this diff. If it did, return 404 without caching, or with a short negative TTL. Otherwise, track it as a follow-up.

## High findings

### finding-001 — graceMs makes expired entries live ttlMs\+graceMs; the existing TTL test fails and nothing refreshes stale entries

Severity: **high**
Root cause: `root-001`

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/cache.js` | 14 | `Cache.get` |
| `src/cache.js` | 3 | `Cache constructor graceMs default` |
| `src/server.js` | 10-13 | `/users handler` |
| `test/cache.test.js` | 10-11 | `entries expire after their TTL` |

Reviewer/source evidence:

```ts
if (entry.expiresAt + this.graceMs < this.now()) {
```

```text
constructor({ ttlMs = 60_000, graceMs = 5_000, now = Date.now } = {}) {
```

```ts
if (!user) {
```

```text
t = 10;
```

```text
assert.equal(cache.get("a"), undefined);
```

Verifier evidence:

```text
constructor({ ttlMs = 60_000, graceMs = 5_000, now = Date.now } = {}) {
```

```ts
if (entry.expiresAt + this.graceMs < this.now()) {
```

```ts
return entry.value;
```

```ts
if (!user) {
```

```ts
const cache = new Cache({ ttlMs: 30_000 });
```

```text
assert.equal(cache.get("a"), undefined);
```

Rationale:

This is a behavior regression in the TTL contract, and the test failure is a symptom of it. Stale serving is only valid if the caller can tell an entry is stale and refresh it. get() returns only the value, so the handler can't tell, and the grace window is just a TTL extension. It also turns the previous default behavior of expiry at ttlMs into opt-out behavior.

Recommended action:

Make graceMs opt-in with a default of 0, or remove it. If stale-while-revalidate is wanted, have get() report staleness (e.g. \{value, stale\}) and have the /users handler refresh in the background via cache.set. Also fix the expiry boundary so an entry at exactly ttlMs counts as expired (\`&lt;=\`), then rerun test/cache.test.js.

Caveat / counter-evidence:

- The Cache constructor in the test passes no graceMs, so the 5000 default applies. This confirms the test failure comes from the default, not from test setup.
- The comparison is strict (\`&lt;\`). With graceMs=0 and t==ttlMs, \`10 &lt; 10\` is false, so the test would still fail. The boundary (\`&lt;\` vs \`&lt;=\`) is a second, independent cause. The finding already says to decide this, but removing graceMs alone would not make the test pass.
- I could not read the HEAD version of src/cache.js, since git is unavailable to read-only tools. The claim that HEAD expired entries at exactly ttlMs is unverified. The test and the working-tree code are enough to confirm the current failure.
- The comment on line 13 states the stale-serving intent. That makes the behavior deliberate in design but unimplemented, so it is not a refutation.

### finding-002 — Missing id returns 200 instead of 400

Severity: **high**
Root cause: `root-002`

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/server.js` | 9 | `createServer handler` |
| `docs/API\_SPEC.md` | 6 | — |

Reviewer/source evidence:

```ts
const id = url.searchParams.get("id") ?? "";
```

```text
- Returns `400` when `id` is missing.
```

Verifier evidence:

```ts
const id = url.searchParams.get("id") ?? "";
```

```text
cache.set(id, user);
```

```text
res.writeHead(200, { "content-type": "application/json" });
```

```text
Returns `400` when `id` is missing.
```

Rationale:

This breaks the documented contract. It also caches a bogus user under the empty-string key.

Recommended action:

In src/server.js, return 400 when \`id\` is null or empty before calling cache.get. Add regression tests for GET /users with no id and with \`id=\`.

Caveat / counter-evidence:

- I found no validation or early return in the handler that would give a 400, so nothing refutes the finding.
- I could not run git diff, so I cannot tell whether the \`?? ""\` default was introduced in the working tree or was already in HEAD ff1c109. The behavior contradicts the docs either way. It is a regression only if the working tree introduced it.

### finding-003 — Unknown user never yields 404

Severity: **high**
Root cause: `root-003`
Verifier verdict: **WEAKEN**

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/server.js` | 11-16 | `createServer handler` |
| `src/server.js` | 22-24 | `loadUser` |
| `docs/API\_SPEC.md` | 7 | — |

Reviewer/source evidence:

```ts
return { id, name: `user-${id}` };
```

```text
res.writeHead(200, { "content-type": "application/json" });
```

```text
- Returns `404` when no user has that id.
```

Verifier evidence:

```ts
return { id, name: `user-${id}` };
```

```text
res.writeHead(200, { "content-type": "application/json" });
```

```text
- Returns `404` when no user has that id.
```

Rationale:

Clients cannot distinguish a real user from a nonexistent one. Note that loadUser is a stub, so this may be intentional placeholder behavior. The handler still has no not-found branch, so a real loader would not produce 404 either.

Recommended action:

Treat this as a medium-severity contract gap, not a PR blocker, unless the diff introduced it. Before shipping a real loader, make loadUser return null for unknown ids and respond 404 without caching, or with a short negative TTL. Also handle the documented 400 for a missing id, since the handler defaults id to an empty string.

Caveat / counter-evidence:

- loadUser is an async stub that fabricates a user for every id. The missing 404 is plausibly deliberate placeholder behavior, not a regression in the TTL cache work.
- docs/API\_SPEC.md is not among the modified files (git status shows only src/cache.js and src/server.js). The 404 gap may predate the working-tree diff, so it may not be a regression introduced by these changes.
- There is no real data source yet, so 'no user has that id' has no definition in the current code.

### finding-004 — Grace period lets responses be served up to 35s old, exceeding the 30s limit

Severity: **high**
Root cause: `root-004`

Locations:

| File | Line | Symbol |
|---|---:|---|
| `src/cache.js` | 14 | `Cache.get` |
| `src/cache.js` | 3 | `graceMs` |
| `src/server.js` | 4 | — |
| `src/server.js` | 10 | `createServer handler` |

Reviewer/source evidence:

```ts
if (entry.expiresAt + this.graceMs < this.now()) {
```

```ts
const cache = new Cache({ ttlMs: 30_000 });
```

```text
- Responses may be cached for at most 30 seconds.
```

Verifier evidence:

```text
graceMs = 5_000
```

```ts
if (entry.expiresAt + this.graceMs < this.now()) {
```

```text
new Cache({ ttlMs: 30_000 })
```

```ts
if (!user) {
```

```text
Responses may be cached for at most 30 seconds.
```

Rationale:

This violates the documented maximum cache age by up to 5 seconds. The comment says the caller refreshes stale entries, but the handler does not do so.

Recommended action:

Pass graceMs: 0 when constructing the Cache in src/server.js, or remove the grace logic from Cache.get. Alternatively, implement real stale-while-revalidate that refreshes entries and keeps total staleness within 30s. Add a regression test with an injected now() that checks an entry is not served after 30s.

Caveat / counter-evidence:

- Whether the grace logic was already in HEAD ff1c109 or added in the working tree was not checked, because git is unavailable here. This affects whether it is a regression but not whether the behavior is wrong.
- The spec says responses "may be cached" for at most 30s. This could be read as a limit on the server's own caching, which the grace window still breaks, so the counter-reading does not hold up.
- Severity high may be generous for a 5s overshoot. The impact is limited to stale user data for up to 5s past the documented limit.

## Recommended next action

Address kept or weakened findings and resolve needs-human items before release.

## Evidence and review coverage

- Canonical ledger rows rendered: 4 kept or weakened findings, 0 needs-human items, and 0 supporting observations.
- Source coverage: complete according to deterministic source-status accounting.
- Finding cards preserve ledger locations, evidence quotes, verifier dispositions, counter-evidence, and recommended actions where present.
- Counts, dispositions, and the effective verdict come from deterministic partition state; narrative synthesis cannot override them.

## Limitations

- Evidence and quotes are bound to the reviewed snapshot available to the partition stage; final rendering does not re-read repository files and therefore does not attest current-tree bytes.

## Related artifacts

- [Machine-readable report](control.json) — structured renderer output and completion-summary contract.
- [Structured source references](refs.json) — source pointers retained by the final workflow task.
- [Legacy compatibility report](review.md) — byte-identical copy of this report.
