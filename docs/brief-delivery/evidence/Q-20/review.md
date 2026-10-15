# Q-20 implementation review

Review method: direct, read-only, defect-first review using the local Review Agent
instructions. This is the implementer's review, not an independent human approval.
Comparison: main 5024ea7455a5613be0514475be32c0dee6de0edd and all Q-20 additions.

No remaining actionable findings after corrections and reinspection.

Checked provider entry points (tiered/legacy, chat/stream), transaction boundaries,
restart accounting, unknown/cancelled transport reservations, foreground admission,
queue idempotency/caps, paging qualification, hidden-page cleanup, existing consumers,
API compatibility and the synthetic measurement harness. Review corrections reserve
oversized remaining-budget refusals durably, reject concurrency before payload
serialization, defer new background work during foreground calls, and avoid treating
chat admission refusals as provider usage/log failures. Regression tests cover these.

Evidence: 802 tests passed across 53 files; five independently removed guards were
detected by their named tests, then restored. Type checking and the UI build pass.

Limits: real provider behavior/costs, a fully assembled F/D/Q stack, sustained
production load and physical desktop/channel effects are not certified. Memory
pagination is a live read; client graph storage is still proportional to vault size.
Foreground priority prevents new background starts, without preempting the two
already-running transports or promising upstream reserved capacity.
