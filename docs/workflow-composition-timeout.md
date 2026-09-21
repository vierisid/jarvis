# Workflow composition deadline

Composition has one default 180,000 ms budget, covering tool discovery, text generation, validation repairs, provider retries, Retry-After waits and tool-to-text fallback. Internal callers/tests may override `ComposeDeps.totalTimeoutMs` with a positive finite timer duration. The existing 90-second per-request limit and bounded provider retry policy remain; they cannot extend the total composition deadline. Starting a repair or fallback does not reset it. The budget sits inside the 5-minute claim lease in `src/awareness/suggestion-composer.ts`, so a composition always settles before its job can be re-claimed.

## Failure contract

- A manager request timeout is an `LLMProviderError` with code `network`. Legacy messages containing either `timeout` or `timed out` classify as network failures too, so a timeout is retried within the total budget instead of being read as an unclassified failure.
- Total budget expiry returns `ComposeFail` with `errorCode: "composition_timeout"` and a message naming the phases that shared the budget. `manage_workflow` forwards that code in its failure response. Expiry never yields `ok: true`, and never substitutes a default flow: a downstream step has nothing to consume.
- Provider failures keep their typed classification. Only an explicit first-turn `unsupported_tools` failure permits retrying without tools. A generic HTTP 400 may be refined to that code when its body explicitly identifies unsupported tool calling; a 5xx is classified as `server` first, so a server error whose body happens to mention tools is not read as a capability failure. Unknown errors, missing models, timeouts, auth failures and server failures do not authorize this fallback.
- A successful first-turn prose/inline response can still use the existing text-composition path. Clients with no `chatTools` method still use text composition directly. Both paths share the same budget.
- Caller cancellation rejects with the caller's original reason. Deadline expiry or cancellation stops waiting even if an adapter ignores its signal, cancels active provider requests/retry waits, and prevents another composition attempt. Late replies are checked before validation or persistence. Cancellation cannot prove a remote provider stopped computing or billing.

The deadline uses a monotonic clock as well as a timer. The composer passes its `checkDeadline` callback through both adapter paths into the manager, which checks before every provider attempt and after it settles. Hosted thinking-budget recovery, compatible-endpoint probing and Groq prompt reduction also check before their internal HTTP retries. These checks prevent another request when synchronous work has crossed the deadline but the abort timer has not fired. Timers/listeners are disposed when the operation completes. This contract covers non-streaming workflow composition; it does not introduce a deadline for unrelated streaming conversations.

## Tests

```sh
bun test src/llm src/actions/tools/workflow-composition-timeout.test.ts src/actions/tools/workflow-composer.test.ts src/actions/tools/composer-llm.test.ts src/actions/tools/manage-workflow.test.ts src/awareness/suggestion-feedback.test.ts
```

Deadline tests advance an injected monotonic clock and synchronize phases with explicit promises rather than sleeping, so they do not depend on a scheduling margin. No test issues a real provider request.
