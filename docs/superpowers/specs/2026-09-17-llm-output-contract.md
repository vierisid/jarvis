# W7: required JSON output is a typed outcome

## Contract

`POST /v1/jarvis/llm/chat` accepts `parseJson`, `outputSchema` and
`requireSuccess` beside the existing prompt fields and answers
`{ text, parsed?, outcome }`, or 202 with a pending approval.

| Reply | `outcome` | `parsed` | HTTP, required | HTTP, handled |
| --- | --- | --- | --- | --- |
| No JSON requested | `succeeded` | absent | 200 | 200 |
| JSON requested; reply parses; schema met or absent | `succeeded` | the value | 200 | 200 |
| JSON requested; reply does not parse | `error` `INVALID_JSON_OUTPUT` | absent | 422 | 200 |
| Reply parses; misses the schema | `error` `OUTPUT_SCHEMA_MISMATCH` | absent | 422 | 200 |
| Schema declaration not honorable | refused | | 400 | 400 |

"Handled" is `requireSuccess: false`, the piece's `Require valid output` turned
off. The piece asserts the outcome independently of HTTP status, fails closed
on a missing or malformed outcome envelope, and by default throws the
outcome's message, so `flow_run.failed_step.errorMessage` names the contract
that failed. A handled step routes on `{{step.outcome.status}}` and
`{{step.outcome.code}}`; the real-engine tests do exactly that.

## Invariants this protects

- `parsed` is never present unless the outcome is `succeeded`. A handled
  branch can read `text` and the outcome; it cannot read a value that failed
  the contract as though it had passed.
- A schema keyword the validator does not implement is refused at declaration,
  never ignored. The supported set is closed: `type`, `properties`,
  `required`, `additionalProperties` (boolean), `items`, `enum`, `minItems`,
  `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, plus `title` and
  `description` as documentation. Declarations are bounded (256 nodes, nesting
  depth 8 below the root, 64 properties per object, 64 enum values, property
  names up to 128 characters) and property names that reach the prototype are
  refused.
- The piece takes the schema as text and parses it itself. The engine's JSON
  property processor drops a value it cannot parse, which would run the prompt
  with no contract at all; the piece fails the step before anything is sent.
- The route owns the contract. A backend, or a receipt written before this
  change, that answers with text alone is evaluated at the route; nothing that
  asked for JSON is stamped `succeeded` because an outcome was missing.
- The contract failure lives inside a completed effect, under the receipt
  rule shared with A2 (#478) for every adapter: an effect that completed
  records `succeeded` with its qualified outcome inside `result`; an effect
  that did not complete records `failed`, `blocked` or `unknown` with the
  outcome at the top level of the receipt. Top-level `outcome` therefore means
  "did not complete". A completed LLM call never sets it, so A2's replay path,
  which rethrows a top-level failure, never fires for a contract failure, and
  a handled branch gets the receipt's text and outcome back. The provider call
  is the effect: it happened once, and a resumed or restarted run returns the
  receipt without a second call. This is why the failure's effect is
  `may_have_occurred` and not `not_started`.
- `requireSuccess` is not part of the effect request digest. An approval
  granted to a request from the previous piece still matches once the upgraded
  piece sends the default explicitly. `parseJson` and `outputSchema` stay in
  the digest and in the frozen arguments: they are part of what was reviewed,
  and a resumed run validates against the schema that was approved.
- Outcome messages quote schema keywords, JSON-pointer paths and property
  names, escaped and bounded because a reply's keys are model output. They
  never quote a reply's values. A quoted reply key is pointer-escaped so it
  cannot forge a path segment, and its quotes and control characters are
  escaped so it cannot close the quoted fragment or add lines of its own: the
  message reaches `flow_run.failed_step.errorMessage`, which `manage_workflow`
  reads back, and 80 characters of reply key must not pass for text the
  message wrote itself. The text travels beside the outcome for whoever needs
  it.

## Validation

- An unchanged-main checkout reproduces the defect through the real engine:
  a step with `Parse JSON` on whose reply is prose reaches `SUCCEEDED`, the
  downstream step runs, and the effect receipt stores the prose as a
  successful result with no `parsed` and no outcome.
- `src/workflows/runtime/llm-output-contract.ts` is covered directly by
  `llm-output-contract.test.ts`: the closed keyword set, the declaration
  budgets, every validation keyword, the bounded violation list, and messages
  that quote no reply value and neutralize a hostile reply key.
- `llm-output-outcomes.test.ts` covers the route statuses, the durable
  receipt across a database reopen, a legacy text-only receipt evaluated at
  the route, approval pause with resume against the approved schema, and the
  handled-outcome branch. Its engine and compiled-piece cases are
  deliberately NOT gated on a cached bundle or `JARVIS_TEST_ENGINE_BUILD=1`,
  so the headline evidence runs in CI rather than skipping there.

## What this does not do

- It does not steer the model. The schema validates the reply; the prompt has
  to ask for the shape.
- It does not unwrap code fences or extract JSON from prose. A fenced reply is
  `INVALID_JSON_OUTPUT`, and the message says the fence is the likely cause.
- It is not a JSON Schema implementation. No `pattern`, `format`, `oneOf`,
  `anyOf`, `$ref`, `patternProperties`, type unions, `nullable` or defaults.
- Only `jarvis-ask` gains the contract. Community pieces, CODE steps and the
  delegated-agent path are untouched; agent outcomes remain A3.
- The receipt records what the model answered and whether it met the
  contract. It does not establish that a met contract is a correct answer.

## Relationship to A2 (#478)

`src/actions/action-outcome.ts` is used as A2 left it, including the
empty-message fallback in `ActionOutcomeError`. Both pieces, `jarvis-ask`
here and `jarvis-tool` there, assert the same outcome shape, and
`pieceHash()` already mixes that file into every Jarvis piece bundle, so an
`ask` bundle cannot keep an old assertion. The receipt rule above is stated
in both specs so they cannot be read as two conventions.
