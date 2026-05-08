/**
 * `@jarvispieces/piece-jarvis-validate` -- the Phase L plumbing-validation
 * piece. Stands in for the proposal's "gmail end-to-end smoke" by exercising
 * the same engine surface gmail would (connection resolver, context.store,
 * run-progress streaming) without dragging in external deps like
 * `googleapis`. Real-piece smoke (gmail) is a follow-up that needs a
 * per-piece dep-install layer for community pieces.
 *
 * The piece declares `PieceAuth.OAuth2` so the engine has to round-trip the
 * connection through `/v1/worker/app-connections/:externalId`. Its single
 * action reads `context.auth.access_token`, writes + reads from
 * `context.store`, and returns both -- the test asserts the values match
 * what the daemon's CredentialResolver minted.
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { validateAction } from "./lib/actions/validate";

export const jarvisValidatePiece = createPiece({
  displayName: "Jarvis: Validate Plumbing",
  description:
    "Engine-runtime test fixture: exercises connection resolver + store + run-progress over OAuth2 auth.",
  auth: PieceAuth.OAuth2({
    description: "Mock OAuth2 connection. The test's CredentialResolver returns a fixed access_token.",
    authUrl: "http://127.0.0.1/oauth/authorize",
    tokenUrl: "http://127.0.0.1/oauth/token",
    required: true,
    scope: ["test.read", "test.write"],
  }),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [validateAction],
  triggers: [],
});
