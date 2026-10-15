# Untrusted content across workflow preparation and results

Q-21 covers deterministic boundaries on the main-based implementation. It does not certify model obedience or the assembled Brief release. The synthetic fixtures use source IDs and fabricated values; no customer captures, credentials, provider calls, or real external effects are needed.

| Boundary | Enforcement and regression |
| --- | --- |
| Capture → opportunity → accepted draft | Real capture ingestion retains bounded job cues and source IDs. A proposal cannot accept itself. Explicit acceptance invokes the persisted composer; grant-shaped model fields cannot enable the resulting draft or opt it into CODE. Reopened SQLite retains that state. |
| Conversation/document text → extraction → memory → next prompt | Each conversation side gets its own fresh untrusted frame. The actual extractor ignores model-supplied confirmation, verification and source fields. Exact quotes remain reported; recall preserves qualification and `queryFact` refuses an unconfirmed binding. |
| Piece metadata/output samples → composition/repair/fallback | Catalogs, discovery replies, machine inventory, role/tool descriptions and candidate/error context get fresh frames at the model boundary. Trusted OS/routing rules stay outside the machine-data frame; composer provenance is `w8-3`. Payload bytes remain intact. Original specification and repair history survive both composer paths. A draft is not permission to execute. |
| Screen/browser result → tool action | Real orchestrator taint blocks a command after a hostile reader result, despite grant-shaped arguments. No simulated effect runs before a decision. Existing file-reader exemptions remain unchanged. |
| Piece result → governed effect/approval | A synthetic governed send uses the real durable effect boundary. Claimed approval is only data. Changing the account after review invalidates the frozen request; explicit fixture approval permits the original simulated effect once. Auth fields are absent from the review projection. |
| Connection selector → credential lookup | Authenticated sandbox HTTP requests stay in the token's project. Native and managed cross-project overrides fail before credential resolution. Same-project lookup remains available; credentials are still encrypted at rest. |
| Billing query → instance-owner read | A brain API query cannot override the configured instance or owner. The request carries the configured instance and a matching HMAC; credentials and instance identity stay out of the browser response. |
| Result text → thread/answer/task room | One shared Markdown component disables raw HTML, rejects executable/custom URL schemes, and converts images to explicit links. Rendering causes no image request; linked images do not nest anchors. GFM tables and ordinary explicit links remain usable. Footnote metadata is retained; unique reference IDs and result-scoped scroll/focus preserve the application hash route. |

## Quick verification

Use the branch's Bun pin (1.4.2):

```bash
bun install --frozen-lockfile
bun test src/trust-boundaries ui/src/components/SafeMarkdown*.test.tsx src/daemon/api-billing.test.ts
bunx tsc --noEmit
bun run build:ui
bun scripts/verify-trust-boundaries-browser.ts
```

Open the printed loopback URL and click **Check boundaries** after all three rooms load. Expect `imageRequests`, `activeElements`, and `executableLinks` to be zero; `imageLinks`, `tables`, `footnoteRoundTrips` and `uniqueFootnoteIds` to be three; `hashPreserved` to be true and `scriptExecuted` to be false. Stop the probe with Ctrl-C. It serves only synthetic records on a randomly allocated loopback port and starts no daemon. Browser evidence is a rendering/behavior check, not a Figma layout approval.

The wider regression selection and removed-fix checks are recorded in [the delivery evidence](brief-delivery/Q-21.json). Reports contain fixture IDs, counts, outcomes and source references. Raw local test logs are not public delivery artifacts.

## Limits and integration

- Framing tells a model which text is data; it does not make an LLM a security boundary. Persistence, immutable approval arguments, account claims and CODE opt-in provide the deterministic checks tested here. A model can still produce a semantically wrong draft or untrue prose.
- The existing [workflow data-plane decision](WORKFLOW_AUTOMATION.md#a-steps-tool-result-is-not-framed-as-untrusted-content) remains intact: tool output used by expressions is byte-preserving. An author-composed `jarvis-ask` prompt interpolating step/trigger data still lacks segment provenance across the sandbox. This known gap is not reported fixed by catalog/composer framing. Prompt-provenance integration and deployed-model evaluation remain release work.
- Approved CODE and ungoverned community pieces retain the privileges documented in workflow architecture. This card does not sandbox them, broaden taint coverage, or change account scopes within one project. A literal document can still contain sensitive data; review projection is not a universal secret scanner.
- Hosting `billing-instance.ts` was inspected at current source and is unchanged from the roadmap's pinned source. Its signature-first, active-instance and owner-derived lookup remain external controls. The new billing test exercises the brain's side with synthetic transport; live Clerk/Stripe/control-plane verification is `not_run`.
- Q-21 has no compile-time or activation dependency. It starts from current main, independently of unmerged Q-20. Preserve Q-20's budget admission and Q-19's failure projections during integration. The D/F/Q stacks, hosted/local deployed profiles, paid evaluations and native webview matrix are not certified by this isolated branch. Q-22 remains separate and blocked on its own prerequisites.
- Rendering now requires an explicit click for images, including relative images. Clicking an ordinary HTTP(S) or mail link still follows that destination; the no-request guarantee applies to rendering.

## Rollback

Revert the Q-21 commits and rebuild daemon and UI together. There are no migrations, config flags or permission changes. Keep saved drafts, facts, journals, approval and effect history. Do not replay effects as part of rollback. Reverting the renderer restores automatic Markdown image loads; reverting the prompt changes restores the unframed model-entry paths.
