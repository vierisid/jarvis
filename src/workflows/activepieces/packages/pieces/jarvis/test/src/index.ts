/**
 * `@jarvispieces/piece-jarvis-test` -- a fixture piece used only by the
 * engine-runtime end-to-end tests. Provides a `manual` trigger that returns
 * its propsValue.payload (so flows starting with this trigger don't need
 * external infrastructure) and an `echo` action that returns its inputs.
 *
 * Not shipped or surfaced in the dashboard catalog. Lives under
 * packages/pieces/jarvis/test/ next to the production Jarvis pieces so the
 * piece-loader picks it up via the same dev-pieces flow.
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { manualTrigger } from "./lib/triggers/manual";
import { echoAction } from "./lib/actions/echo";
import { waitForSignalAction } from "./lib/actions/wait-for-signal";

export const jarvisTestPiece = createPiece({
  displayName: "Jarvis Test",
  description: "Test fixture piece for the engine-runtime smoke tests.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [echoAction, waitForSignalAction],
  triggers: [manualTrigger],
});
