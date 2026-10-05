/**
 * Neutralise framing delimiters in a governed piece's bounded input, on its way
 * into a durable record and onto an approval card a human reads (#634).
 *
 * THE DEFECT. `piece-effects.ts`'s `bound()` cuts every string in a governed
 * piece's input to 512 characters. A flow author can wire a prior
 * `manage_workflow` step's result into that input with a `{{ }}` expression,
 * and `manage_workflow` is the one tool that FRAMES its own return -- so the
 * cut lands inside an `UNTRUSTED_CONTENT` block, keeps the open delimiter and
 * drops the close. That projection becomes `workflow_effect.arguments`, is
 * copied into `approval_requests.tool_arguments` (`effect-boundary.ts`) and is
 * rendered on the approval card. An unterminated block does not merely
 * disclaim its own payload: it disclaims whatever is rendered after it.
 *
 * Same shape #609 fixed at its four slice sites, at a tighter cap than any of
 * them.
 *
 * WHY THIS IS ITS OWN FILE, which is the whole design of the fix.
 * `piece-effects.ts` is compiled INTO the engine bundle -- it is listed in
 * `PATCHED_VENDOR_SOURCES` in `runner/engine-runtime/build.ts` -- and its own
 * docblock says "keep it pure: type-only imports". Importing
 * `roles/untrusted.ts` there would make a 1000-line module a new bundle input
 * that is NOT registered for cache invalidation, so a later edit to
 * `defangDelimiters` would leave cached engines applying the old projection
 * while the daemon applied the new one, on the exact function whose output
 * feeds `requestDigest`. Registering it instead would mean every edit to
 * `untrusted.ts` -- a comment included -- invalidating every cached engine
 * bundle and every compiled piece, which is a cost `build.ts` accepts for one
 * small file and should not pay for this one.
 *
 * So the defang lives on the DAEMON side only, and that is sufficient rather
 * than a compromise. The input is bounded twice -- by `sanitizePieceInput` in the
 * engine (`piece-effect-guard.ts`, before the authorize POST) and by
 * `reprojectPieceInput` in the daemon (`service-backends.ts`) -- and NOTHING is durable before the daemon's pass:
 * `effect-boundary.invoke` is the only writer. A stale engine bundle therefore
 * cannot reopen the hole, and no coordinated rebuild is needed to deploy this.
 *
 * WHY `defangDelimiters` AND NOT `boundedReceiptText`, which is the helper the
 * issue names. `boundedReceiptText` bundles a cut with the defang, and this
 * site must not cut again: `bound()` has already produced
 * `prefix512 + "... [N more characters]"`, at most 544 characters, and re-cutting
 * at 512 would eat the note that tells a reviewer the card shows less than the
 * step will send. `defangDelimiters` alone is the right half of that helper
 * here, and its stated precondition is already satisfied -- it asks callers to
 * cut first, and every string reaching this function has been cut to 544 or less by
 * `bound()`, so the span-map scan is bounded by construction.
 *
 * DETERMINISTIC, which `bound()`'s own docblock requires because the digest an
 * approval was granted against is recomputed from this projection on resume.
 * `defangDelimiters` is pure and has no state across calls (`markerPattern()`
 * builds a fresh regex per use). It also repairs ill-formed UTF-16 first, which
 * covers the lone surrogate `bound()`'s cut can leave at index 512 -- a lone
 * surrogate in a durable row that later reaches a provider request is the
 * failure the frame wrapper's own comment names.
 *
 * WHAT MOVES, AND WHAT IT COSTS. For a string that does not spell the marker
 * token and is well-formed UTF-16, `defangDelimiters` returns its input
 * byte-exact, so the projection and its digest are unchanged and in-flight
 * approvals resume normally. Two classes differ, and the first is WIDER than
 * the defect -- state it at full width, because this is where a reader sizes
 * the blast radius wrong:
 *
 *   1. the string contains the BARE TOKEN `UNTRUSTED_CONTENT`, in any case or
 *      split by invisibles -- NOT merely the `<<<` delimiter. `markerPattern()`
 *      matches the token alone, so `SELECT untrusted_content FROM pages`, a
 *      JSON key of that name, and a filename are all rewritten to a hyphen.
 *      This is `defangDelimiters`' own documented accepted cost, and on THIS
 *      path it has two consequences, not one: such an approval fails to resume
 *      (below), AND the durable row is no longer byte-exact -- a `custom_api_call`
 *      body or URL that legitimately discusses this feature is stored with a
 *      hyphen. Worth it, because the alternative is a stored boundary that
 *      disclaims whatever the card renders next, and what is lost is one
 *      character in a field nothing resolves by.
 *   2. ill-formed UTF-16 in the kept prefix, including a surrogate pair split
 *      by `bound()`'s own cut, which `toWellFormed` repairs to U+FFFD.
 *
 * A token appearing only AFTER the 512-character cut changes nothing -- not
 * because of any property of the defang, but because `bound()` already dropped
 * it, so the defang never sees it.
 *
 * For (1) and (2), `effect-boundary.ts`'s `requestDigest` fence -- which IS
 * recomputed from this projection on every resume -- will not match the stored
 * digest, and the step fails with "Workflow effect changed since it was
 * recorded; start a new run for new arguments or version". That is a pending
 * governed-piece approval needing its run restarted; it is not silently
 * executed against a different projection. Everything else resumes untouched,
 * and there is no migration. (The card's own `tool_arguments` digest check is
 * DB-vs-DB and cannot move: `prepare()` only runs when no effect record
 * exists.)
 *
 * One length note, since it is the only place a length change propagates: the
 * defang can SHORTEN a string, because the span path drops a matched span's
 * interior invisibles. `governedPieceTarget` bounds again after this runs, but
 * with the slack a projection is allowed (#651), so a string the defang
 * shortened is still inside the envelope and keeps the count it had.
 *
 * `governedPieceTarget` inherits the fix for free, because
 * `service-backends.ts` builds its target from the value this function
 * returned.
 */

import { defangDelimiters } from '../../roles/untrusted';

/**
 * Defang every string in an already-bounded piece projection.
 *
 * The input is `bound()`'s output, so its shape is bounded too -- at most 41
 * keys, depth 5, 26 array items (each cap plus the slot for its count), strings
 * of at most 544 characters -- which is what
 * makes this walk safe without a budget of its own. Objects are rebuilt in
 * their existing key order, so nothing about the projection's identity changes
 * beyond the string contents.
 */
export function defangPieceProjection<T>(value: T, depth = 0): T {
  // A depth cap even though `bound()` already caps at 5 and cannot emit a
  // cycle. The signature invites direct use, and a value this function was not
  // promised -- a cyclic object, a class instance -- would otherwise overflow
  // the stack. Removing the hazard class costs one line; documenting it as a
  // precondition would not, which is the argument `markerPattern()`'s own
  // docblock makes for building a fresh regex per call.
  if (depth > 16) return value;
  if (typeof value === 'string') return defangDelimiters(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => defangPieceProjection(item, depth + 1)) as unknown as T;
  // A null prototype, so a `__proto__` key could not assign the prototype even
  // if one reached here. `bound()` cannot emit one -- it assigns onto a plain
  // object too, so the key becomes the prototype there and never an own
  // property -- but this makes the safety unconditional rather than inherited.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = defangPieceProjection(item, depth + 1);
  }
  return { ...out } as unknown as T;
}
