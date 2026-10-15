# Q-20 implementation review

Review method: direct, read-only, defect-first review using the local Review Agent
instructions. This is the implementer's review, not an independent human approval.
Comparison: main 5024ea7455a5613be0514475be32c0dee6de0edd and all Q-20 additions;
correction re-review against the delivered head 90efb462dd59905ce7aac52757666bd5f452f8a2.

No remaining actionable findings after correction and reinspection of all three
post-delivery findings:

- Hosted internal thinking retries now reserve a fresh attempt and payload/output
  allowance before transport. Both chat and stream obey the admitted output cap;
  foreground retries retain their behavior. Only the settled transport's slot is
  released, and the previous reservation remains spent.
- Preparation lease recovery runs before resource admission, including leases that
  expire after restarting during a model-budget pause. Explicit retry keeps work
  queued without spending another attempt while paused.
- The attempt-limit test uses the actual claimed job and deliberately selects the
  second enqueue, removing its assumption about millisecond timestamps/UUID order.

Validation: 811 affected tests passed across 54 files; TypeScript passed. Each
removed correction was detected by its named regression test, then restored.
The claimed-job test passed 20 isolated runs. See review-fixes.json for evidence;
correction hooks and final-head CI are recorded in the PR description.

Limits: real provider behavior/costs, a fully assembled F/D/Q stack, sustained
production load and physical desktop/channel effects are not certified. Memory
pagination is a live read; client graph storage is still proportional to vault size.
Foreground priority prevents new background starts without preempting existing
transports or promising reserved upstream capacity.
