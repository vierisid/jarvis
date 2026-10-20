/**
 * The taint of ONE realtime voice session (#928).
 *
 * A text turn owns a Set that `executeTool` enters through AsyncLocalStorage.
 * A realtime voice session has no turn objects, so its taint lived in one
 * process-wide set on the orchestrator: the dashboard's session and every
 * pebble's read and cleared the same marks. A page read on one surface
 * refused an action spoken on another, and anyone starting to speak on one
 * surface cleared what another had read.
 *
 * Each realtime session now owns one of these. Its tool calls run inside
 * `marks` (see `AgentOrchestrator.executeRealtimeToolCall`), so taint noted by
 * a call, and anything a call spawns, belongs to that session alone. Nothing
 * outside a session or a turn reads or writes it.
 */
export class RealtimeTaint {
  /** The set the orchestrator enters for this session's tool calls. */
  readonly marks = new Set<string>();

  /**
   * The user has started a new utterance (server VAD): the session's turn
   * boundary for taint.
   */
  userTurnStarted(): void {
    this.marks.clear();
  }
}
