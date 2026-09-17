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
  `description` as documentation. Declarations are bounded (256 nodes, depth
  8, 64 properties per object, 64 enum values) and property names that reach
  the prototype are refused.
- The piece takes the schema as text and parses it itself. The engine's JSON
  property processor drops a value it cannot parse, which would run the prompt
  with no contract at all; the piece fails the step before anything is sent.
- The contract failure lives inside a completed effect. The provider call is
  the effect: it happened once, the receipt is `succeeded` with the outcome in
  its result, and a resumed or restarted run returns that receipt without a
  second call. This is why the failure's effect is `may_have_occurred` and not
  `not_started`.
- `requireSuccess` is not part of the effect request digest. An approval
  granted to a request from the previous piece still matches once the upgraded
  piece sends the default explicitly. `parseJson` and `outputSchema` stay in
  the digest and in the frozen arguments: they are part of what was reviewed,
  and a resumed run validates against the schema that was approved.
- Outcome messages name paths and keywords, never the reply text. The text
  travels beside the outcome for whoever needs it.

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

## Merging with #478 (A2)

`src/actions/action-outcome.ts` and the hash line added to
`src/workflows/runner/engine-runtime/build-pieces.ts` are byte-identical
copies of #478's, so whichever branch lands second merges without conflict.
Both pieces, `jarvis-ask` here and `jarvis-tool` there, assert the same
outcome shape; keep both.

## Seeing it fail

Run `src/workflows/runtime/llm-output-outcomes.test.ts` against unchanged
main: a reply that is not JSON answers 200 with the text and no outcome, a
schema is accepted and never checked, and the required/handled distinction
does not exist. The real-engine cases show the required step stopping
downstream work, the handled step routing on the outcome, and a schema that
cannot be read failing before the model is called.
