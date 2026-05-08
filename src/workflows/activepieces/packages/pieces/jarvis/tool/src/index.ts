/**
 * `@jarvispieces/piece-jarvis-tool` -- invoke a registered Jarvis tool by name
 * directly from a flow. Cheap and deterministic: no LLM round-trip, no agent
 * planning, the caller already knows the tool id.
 *
 * Calls back to the daemon's `/v1/jarvis/tools/invoke` endpoint via the
 * engine's per-run `context.server` bearer token.
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { invokeAction } from "./lib/actions/invoke";

export const jarvisToolPiece = createPiece({
  displayName: "Jarvis: Tool",
  description:
    "Invoke a registered Jarvis tool by name with the given parameters. Use this when you know exactly which tool to call; for LLM-picked tool dispatch use jarvis-agent.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [invokeAction],
  triggers: [],
});
