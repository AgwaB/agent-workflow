The findings follow directly from the exported helpers; no caller behavior is assumed.

1. **Overlapping polling:** Leave the first intent read pending across several timer ticks. Each tick passes the non-aborted guard and starts another read. The implementation supplies no bound on outstanding operations. A fix must preserve local-abort observation while persistence is stalled.

2. **Registration ownership:** Bind one signal twice, dispose the first binding, then abort the signal before persistence records the stop. The second binding remains logically active, but its shared Set entry has already been removed. Unique registration tokens also avoid stale cleanup functions deleting later registrations.

3. **Disposal race:** Start a check, dispose while its read is pending, then resolve that read with a stop intent. The returned signal still aborts. This behavior is certain; its practical severity depends on listener lifetimes, which are not supplied.

4. **Read-rejection race:** Begin the guard with an un-aborted launch signal, abort during the read, then reject the read. The persistence error escapes before the cancellation recheck. This is distinct from successful-read races, which the code handles.

Polling also silently treats intent-read rejection as absence of an intent. Without the store implementation or an error-recovery contract, I have not asserted a separate fail-open-policy defect.

**Verification limits:** Review was static and read-only; no tests were executed. The requested `./schemas/deep-review-reviewers-control.schema.json` was absent. I read the available bundled reviewer schema at `.pi/workflows/<WF_RUN_1>/bundle/schemas/deep-review-reviewers-control.schema.json` and manually checked the output against its required fields, enums, and limits; executable schema validation was unavailable.
