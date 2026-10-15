# Background work bounds (Q-20)

The daemon reserves background model work before each provider invocation, including
manager retries and fallbacks. The reservation is local resource admission, not the
hosted billing meter: prices, plan entitlements and provider tokenization remain
owned by hosting. Foreground user calls do not wait on this governor. While one is
in flight, no new background transport starts; at most two already-started calls
may continue. Approvals and cancellation use their existing paths.

## Limits and recovery

| Resource | Default bound |
| --- | --- |
| Background transports | 2 per daemon process, no in-memory waiting queue |
| Provider attempts | 240 per rolling 24 hours |
| Serialized messages and tool schemas | 16 MiB per rolling 24 hours; 2 MiB per attempt |
| Requested output tokens | 524,288 reserved per rolling 24 hours; at most 8,192 per attempt |
| Saved suggestion jobs | 20 queued/running, deduplicated by canonical opportunity |
| Suggestion composition attempts | 12 per rolling 24 hours; 3 per job |
| Memory response page | 100 records, keyset cursor |
| Memory refresh | One refresh at a time, 10-second deadline, yields between pages |

Reservations are committed before transport. Failed, cancelled and usage-less
responses consume the reservation, so retrying or restarting does not restore
allowance. Expired reservation rows are pruned when another reservation succeeds.
An unavailable budget database refuses background work. A transport that ignores
abort holds its concurrency slot until it actually settles, even if the manager
has stopped waiting. The daemon's existing single-process ownership lock remains
required: concurrency counts are in memory; rolling allowances are transactional
SQLite records shared across restarts.

Provider network/server/rate-limit failures pause background admission for at
least one minute. Authentication, quota and restriction failures pause it for at
least five minutes. Retry-After can extend this, up to 24 hours. Backoff persists.
A request larger than remaining allowance records its next retry time. No provider
request is sent for local `background_throttled` admission failures, and chat
admission refusals are counted in budget telemetry rather than as provider usage.

Hosted thinking-budget retries also reserve a new attempt, input payload and output
allowance before transport. They use the admitted output limit, including the
8,192-token cap; a tier requiring more can still fail and needs reconfiguration.
The previous attempt stays spent. Its settled transport releases its slot before
retry admission, so another active background call does not double-count this
request. Foreground hosted retries retain their existing behavior.

The existing `background` origin marks awareness, background agents and memory
extraction. Suggestion composition now explicitly uses that origin. The composer
adapter treats a detached call with no origin as background too, including the
F-09 timer-driven prepared composer when integrated. Explicit `user` and
`workflow` origins retain their meanings. Workflow execution, voice transports,
image-generation endpoints and arbitrary direct provider clients are outside this
model-manager bound. A continuous user conversation can defer background work.

Queued suggestions stay queued when admission is paused. An attempt already in
progress can fail if a later model call is refused; its existing journal and saved
request remain available for explicit retry, subject to the per-job limit. An
exhausted job remains inspectable, never silently reset. Opportunistic awareness
and extraction do not gain a new durable retry queue: a refused enrichment is
observable in the aggregate counters and existing caller diagnostics, and its
source remains under the existing retention policy.

Expired preparation leases are recovered even while model admission is paused.
A lease surviving restart therefore becomes failed and explicitly retryable on
expiry; recovery itself consumes no model allowance.

## Inspecting the state

Open Workflows → Routine requests. The page shows queued/running counts and
explains unavailable preparation, foreground work, provider backoff, concurrency
and daily allowance pauses. Existing clients can ignore the additive `background`
field on routines/compositions responses. `GET /api/awareness/background` returns
current model counters, reserved resources, limits, refusal reason and retry time,
plus suggestion queue counts and worker availability. It exposes no prompt,
credential or captured content.

Memory uses `GET /api/vault/page?kind=entities|facts|relationships&cursor=<id>`.
The server hydrates at most 100 records per page through the existing qualified
readers, excluding superseded facts. The browser reads pages with a yield between
them and publishes only a complete set; a failed or timed-out refresh retains the
previous set with an error. This is a live paginated read, not a transactionally
frozen snapshot across edits. The browser still retains the loaded vault for the
existing graph/search; this change does not claim constant client memory for an
arbitrarily large vault. Legacy array endpoints remain available to older clients.

Memory and Routine requests do not start polls while hidden. Memory also aborts
in-flight page reads when hidden/unmounted and resumes when visible. No UI motion
or design-system change is involved.

## Evidence and integration

Run `bun scripts/measure-background-work.ts`. It measures an idle fixture and a
200-call eligible-background burst, with two foreground calls (one cancelled) and
a real SQLite approval denial. It reports CPU time, sampled RSS/heap, provider
calls, concurrency and response timing, with the hardware and synthetic profile.
The control disables only the governor on the same checkout. It is not a live
provider measurement, complete capture pipeline benchmark or production capacity
certificate. The recorded 250 ms responsiveness thresholds apply only to this
fixture and hardware. No paid calls or external effects are used.

Q-20 is based on main `5024ea7455a5613be0514475be32c0dee6de0edd`, not on Q-19 or
the unmerged F stack. There is no new activation flag: these bounds apply when
this daemon revision starts. F-09 retains its own prepared queue, ownership and
attempt limits; its merge must preserve these legacy queue bounds and use the
shared composer adapter/manager. Q-19's typed failure projection should map the
new `background_throttled` code to a resource pause when the stacks are assembled.
Neither stacked integration nor Q-22 certification is claimed here.

Rollback: revert Q-20 and rebuild the daemon/UI together. Keep the additive
`background_model_reservations`, `background_model_backoff` and
`suggestion_composition_attempts` tables; old binaries ignore them. Preserve jobs,
composition journals and authority/effect history. Rollback does not replay work.
