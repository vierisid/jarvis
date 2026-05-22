/**
 * `@jarvispieces/piece-jarvis-regex` -- text-utility piece for regex
 * match / extract / replace operations on strings.
 *
 * Why a piece (not a template function): regex output (capture groups,
 * replaced text) needs to flow into downstream steps via
 * `{{step.field}}` references; the AP template language is a simple
 * `{{...}}` lookup, not an expression evaluator, so transforms live in
 * pieces. Boolean "does this match" tests go through the new
 * `TEXT_MATCHES_REGEX` ROUTER condition operator (no piece needed for
 * that case -- the condition is inline).
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { matchAction } from "./lib/actions/match";
import { extractAction } from "./lib/actions/extract";
import { replaceAction } from "./lib/actions/replace";

export const jarvisRegexPiece = createPiece({
  displayName: "Jarvis: Regex",
  description: "Match, extract, and replace text using JavaScript regular expressions.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [matchAction, extractAction, replaceAction],
  triggers: [],
});
