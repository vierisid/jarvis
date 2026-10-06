# F-08: selected composition ingredients

F-08 makes typed connection and installed library-action selections constrain F-07 composition. It is backend/API work for the future D-16 workflow prompt. No UI was rewired, no piece is automatically installed, and composing still creates only a disabled draft.

This branch follows the owner-approved unmerged stack on corrected F-07 `b53fb22d53ed1337e4dacafa597e6776fe04c060`. F-07 is now a compile dependency because this card extends its job service. Enablement requires both capabilities.

## Activation and discovery

The daemon registers `compositionIngredients` with the actual workflow composition provider. Both flags default off:

```text
JARVIS_BRIEF_WORKFLOW_COMPOSITION=1
JARVIS_BRIEF_COMPOSITION_INGREDIENTS=1
```

Check `/api/brief/capabilities` before rendering selection controls. Both capabilities must be enabled and ready. The provider must own the live workflow database and have the existing composer configured. These instructions do not activate a running daemon.

`GET /api/brief/composition-ingredients?q=SEARCH&offset=0` uses existing panel authentication, CORS and `Cache-Control: no-store`. It returns `{ingredients: [{selection, displayName}], nextOffset}`. Pages contain at most 100 entries; use the returned offset, and restart pagination after a catalog change. `q` is optional and limited to 128 characters. The installed catalog supplies actions and package versions. Account-scoped connection metadata supplies active, compatible connection choices. Display names are presentation text; send the separate `selection` object to the composer unchanged.

This is an adapter over the current catalog and connection tables. It neither scans a new marketplace nor extracts/rebuilds metadata on a selection request. Existing catalog construction now attaches the discovered package version on fresh extraction and old/shared cache hits without invalidating those caches or starting extra engines.

## Typed request

`POST /api/brief/workflow-compositions` accepts the F-07 fields plus optional `ingredients`. A library ID is the canonical installed package name, with an explicit action name. A connection ID is the exact connection row ID. Equal IDs or labels across kinds never identify the same selection.

```json
{
  "requestId": "caller-saved-stable-key",
  "prompt": "Use the selected action and account to prepare this workflow.",
  "ingredients": [
    {"kind":"connection","id":"CONNECTION_ROW_ID","pieceName":"INSTALLED_PACKAGE_NAME","pieceVersion":"INSTALLED_VERSION","required":true},
    {"kind":"library-action","id":"INSTALLED_PACKAGE_NAME","actionName":"ACTION_NAME","pieceVersion":"INSTALLED_VERSION","actionVersion":"COPY_THE_64_CHARACTER_HASH_FROM_DISCOVERY","required":true}
  ]
}
```

Use actual objects from discovery, not these placeholders. `pieceVersion` is the installed package version. Actions have no separate semver in the source catalog, so `actionVersion` is a SHA-256 revision of the canonical action metadata and piece auth declaration. The server checks both. This pins the installed contract; it does not install, retain or execute historical package versions.

There may be at most 64 selections. Identity fields are limited to 256 characters, version fields to 128. Every field is explicit, including boolean `required`. Unknown fields, duplicate typed identities, malformed hashes and client-supplied bindings/credentials are rejected. The existing 100,000-byte HTTP body limit still applies. `required:false` permits omission but does not exempt a selection from availability/ownership/version checks. An authenticated selected action also needs a selected compatible connection; the composer must use one of those exact bindings for that action.

The service saves the exact ordered selections separately from user prose before model work. They appear in the receipt specification and the durable composition journal, and remain intact on every repair/fallback. Input objects are copied before awaits. Retrying a request key with a changed selection, version or requirement returns 409. Missing and empty ingredient lists are equivalent for legacy requests. A new intentional attempt requires a new key. If ingredient authoring is disabled, a POST carrying the field returns 503 (501 for a missing/mismatched provider); it is never silently treated as prose-only. Existing receipts remain readable through the F-07 GET routes while F-07 is enabled.

## Validation and safe data

Before a model call the adapter checks installed package/action identity and version, active connection status, matching piece/auth type, unambiguous binding, project ownership and account ownership. The current single-user server supplies the trusted user/project IDs. Project-shared connections with no owner are valid; foreign projects and foreign owners are refused. Clients cannot choose those identities.

Connection queries explicitly select only identity, binding, piece, auth type, status and ownership columns. They do not select or decrypt `value`, read private connection `metadata`, refresh OAuth tokens or copy connection display names into model context. The server adds only the validated external binding and an action auth requirement to the typed prompt data. Tests store deliberately unreadable credential canaries and private labels to prove this path needs no secrets.

Every normalized candidate is checked across its full graph, including loops and branches. A required action must appear as that exact installed action. A required connection must be the matching piece's exact auth binding on an operation that uses auth; a decorative auth field on an unauthenticated operation does not qualify. Conflicting graph version pins are rejected. Validation failures feed the existing bounded repair loop; unresolved ingredient errors or an explicit `report_blocked` produce a blocker without a draft. This checks structural use, not whether a conditional branch will execute on every run or whether every prose constraint is satisfied.

Missing, revoked, incompatible, unavailable and stale selections block before inference. The original request remains recoverable. No substitution or installation occurs. Managed `jarvis:` credential sources without stable connection rows, unsafe external binding syntax and unversioned catalog entries cannot currently be selected. They fail explicitly rather than losing the user's selection. A locally ACTIVE credential is not a guarantee that a remote service still accepts it; normal runtime credential/error handling remains responsible for provider-side expiry or revocation that is not reflected locally.

## Readiness and persistence

The adapter re-reads current catalog and connection metadata in the transaction that attaches the resulting draft. A removed, revoked, retargeted or replaced row prevents attachment. Package/action contract drift does the same.

The resulting flow gets an immutable `workflow_composition_ingredients` record in that same transaction. Canonical readiness, enable, publish, live-draft edits and nested-workflow validation recheck it. Replacing a deleted connection with another row using the same external name cannot satisfy the original row-ID pin. Ordinary workflow metadata edits cannot erase the requirements. Disabling ingredient authoring or restarting the daemon does not disable these checks. To change pinned selections, compose a new explicit request. Keep readiness checks intact when integrating D-16 or later activation work.

The job schema adds an `ingredients` column with default `[]`; old receipts and old writers remain valid. The flow-requirements table is additive and cascades only with deletion of its owning workflow. Existing F-07 storage recovery, cancellation, idempotency and atomic attachment behavior is preserved.

## Verification

Run without a model account or a live daemon:

```bash
cd /home/vierisid/.cache/codex/jarvis-f-08
bun test src/brief/composition-ingredients.test.ts
```

The tests exercise equal connection/library IDs, secret exclusion, ownership/auth failures, missing/stale selections, all composer candidate paths, long multiple selections through repairs, blockers, restart and F-07 schema upgrade, immutable replay identity, default-off/provider gates, and revocation/replacement before attachment and before enable/publish. Five unsafe mutations must fail these tests. Full affected commands and raw logs are in `docs/brief-delivery/evidence/F-08/`; the receipt is `docs/brief-delivery/F-08.json`.

For an explicitly enabled integration host, fetch discovery through its authenticated panel, select compatible action/connection objects, POST them alongside a prompt and poll the job. Inspect its retained selections and populated disabled draft. Repeat the same request key and confirm the same receipt; change a pin with the same key and expect 409. Make a selected connection unavailable before enabling the draft and confirm an INGREDIENT readiness blocker. This optional exercise calls the configured model; fixture verification does not.

No screenshot is supplied because this card has no visible UI change. D-16 owns chips, labels, blocker rendering and the submit interaction. Treat server/model blocker text as plain text.

## Integration and rollback

The parallel Q-03 PR also edits composer prompt provenance. F-08 keeps its public composer/dependency APIs additive, retains planning-policy behavior and advances the prompt version to `w8-3-ingredients`. When integrating the stacks, retain both changes and regenerate Q-03's prompt fixtures for this version; do not drop its policy selection or F-08's ingredient validation. No other agent branch is rebased or modified here.

Roll back authoring by removing `JARVIS_BRIEF_COMPOSITION_INGREDIENTS=1` and hiding its selector. Keep F-07 available for receipt recovery and prose-only requests if desired. Retain saved selections, flow pins, journals and drafts. Keep current readiness enforcement in place. A binary rollback to pre-F-08 code cannot enforce these new pins, so leave F-08-created workflows disabled before such a downgrade. Never remove user rows or replay an accepted request as rollback.
