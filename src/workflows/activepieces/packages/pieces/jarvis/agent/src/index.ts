/**
 * `@jarvispieces/piece-jarvis-agent` -- delegate a goal to a Jarvis sub-agent
 * (M7). The agent runs its own LLM + tool-loop and returns a final message
 * plus the trace of tools it invoked. Use this when the LLM should plan and
 * pick tools; for known-tool invocation use `jarvis-tool`, for single-shot
 * LLM completion use `jarvis-ask`.
 *
 * Calls back to `/v1/jarvis/agent/delegate`.
 */

import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { delegateAction } from "./lib/actions/delegate";

export const jarvisAgentPiece = createPiece({
  displayName: "Jarvis: Agent",
  description:
    "Run a Jarvis sub-agent (M7) with a goal. The agent uses its full reasoning + tool loop and returns the final answer plus the tool-call trace.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.0.0",
  logoUrl: "",
  authors: ["jarvis"],
  actions: [delegateAction],
  triggers: [],
});
