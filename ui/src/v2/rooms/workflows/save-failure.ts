/** Why a save did not happen, in words, and what happened to the edits (they are still here). */

export const OFFLINE_SAVE_TEXT = "You are offline, so this was not saved. Your edits are still here; save again when you are back online.";
export const SESSION_ENDED_SAVE_TEXT = "Your session ended, so this was not saved. Your edits are still here and a copy is kept in this tab. Sign in again to save them.";
export const WORKFLOW_REMOVED_TEXT = "This workflow was deleted in another tab or window, so these edits cannot be saved to it. Copy what you need, then go back to All workflows.";

/** The refusals that mean the workflow itself is gone (deleted, or being deleted). */
export function workflowGone(body: { error?: unknown; code?: unknown } | null): boolean {
  return ["workflow_removed", "workflow_purging"].some((code) => body?.code === code || body?.error === code);
}

/** A write that never got an answer: offline, timed out, the session ended, or the page lost its owner. */
export function describeSaveFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/^authentication required$/i.test(message)) return SESSION_ENDED_SAVE_TEXT;
  if (/^host unavailable$/i.test(message)) return "This page lost its connection to Jarvis, so this was not saved. Your edits are still here. Reload to reconnect.";
  if (name === "AbortError" || name === "TimeoutError") return "Saving took too long and was stopped. Your edits are still here; try again.";
  if (error instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) return OFFLINE_SAVE_TEXT;
  return "This could not be saved. Your edits are still here; try again.";
}
