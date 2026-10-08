/**
 * Which approval a spoken "yes" or "no" answers (#809).
 *
 * The voice rail lists pending approvals newest first
 * (`RailConfirmationStack`). Both use this ordering, so the id sent with an
 * utterance is the card the rail showed first. Ties keep their arrival order,
 * as a stable sort does.
 *
 * Position is only a safe answer while one approval is pending (#855): with
 * two up, the person may have been reading either. The daemon refuses a voice
 * decision then, and the rail's hint says to decide each on its card
 * (`voiceHint`).
 */
export function newestFirst<T extends { timestamp: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * The rail's line under the cards: how to answer by voice, or, with more than
 * one approval pending, that voice cannot pick between them (#855).
 */
export function voiceHint(pendingApprovals: number): "voice" | "cards" {
  return pendingApprovals > 1 ? "cards" : "voice";
}

/** The id of the approval on top of the rail, or null when it shows none. */
export function newestApprovalId(approvals: ReadonlyArray<{ id: string; timestamp: number }>): string | null {
  return newestFirst(approvals)[0]?.id ?? null;
}

/**
 * What a spoken answer is about: the approval on top of the rail, but only
 * while the dashboard is actually on screen (#809 review). A hidden or
 * minimised window showed nothing, though it still holds the approvals, and
 * the sidecar's wake word can start a recording then. Null makes the daemon
 * decide nothing and say no approval was on screen.
 *
 * "Visible" is what the page reports, not proof the card was read: a window
 * covered by others still reports visible, and the Windows sidecar panel
 * (WebView2) probably reports visible while hidden or minimised too, since the
 * panel never tells the controller otherwise. That is a sidecar fix, filed
 * with #809.
 */
export function shownApprovalId(
  approvals: ReadonlyArray<{ id: string; timestamp: number }>,
  visibilityState: string,
): string | null {
  return visibilityState === "visible" ? newestApprovalId(approvals) : null;
}
