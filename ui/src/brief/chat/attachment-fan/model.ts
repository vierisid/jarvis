export const attachmentChoices = ["document", "image", "screenshot"] as const;
export type AttachmentChoice = typeof attachmentChoices[number];
export type AttachmentResult = "attached" | "cancelled";
export interface AttachmentFanBinding {
  source: "fixture" | "live";
  scopeId: string | null;
  conversationId: string | null;
  enabled: boolean;
  reason?: string;
  screenshot: { available: boolean; reason?: string };
  choose(kind: AttachmentChoice, signal: AbortSignal): Promise<AttachmentResult>;
}
/** F-05 owns files, readiness, retries and removal. These are its existing methods. */
export interface AttachmentOwner {
  getSnapshot(): { mode: string; connected: boolean; attachmentsEnabled: boolean; pending: number };
  store: { getSnapshot(): { workspaceId: string | null; activeId: string | null; order: readonly string[] } };
  attachments: {
    upload(conversationId: string, kind: "document" | "image", file: File): Promise<unknown>;
    capture(conversationId: string, deviceId: string, confirm: boolean): Promise<unknown>;
  };
}
export interface AttachmentPickers {
  file(kind: "document" | "image", signal: AbortSignal): Promise<File | null>;
  /** Host must show the chosen device and obtain explicit confirmation. */
  screenshot(signal: AbortSignal): Promise<{ deviceId: string; confirmed: true } | null>;
  screenshotAvailability: { available: boolean; reason?: string };
}
export function bindAttachmentFan(owner: AttachmentOwner, pickers: AttachmentPickers, source: AttachmentFanBinding["source"]): AttachmentFanBinding {
  const state = owner.store.getSnapshot(), status = owner.getSnapshot();
  const conversationId = state.activeId, scopeId = state.workspaceId;
  const enabled = status.mode === "scoped" && status.connected && status.attachmentsEnabled && !status.pending
    && !!scopeId && !!conversationId && state.order.includes(conversationId);
  const valid = (signal: AbortSignal) => {
    const now = owner.store.getSnapshot(), status = owner.getSnapshot();
    if (signal.aborted) return false;
    if (!enabled || now.workspaceId !== scopeId || !now.order.includes(conversationId!)
      || status.mode !== "scoped" || !status.connected || !status.attachmentsEnabled || status.pending) throw Error("Attachment entry is unavailable.");
    return true;
  };
  return { source, scopeId, conversationId, enabled, screenshot: pickers.screenshotAvailability,
    reason: !status.connected ? "Connect to attach files." : "Attachments are unavailable for this conversation.",
    async choose(kind, signal) {
      if (!valid(signal)) return "cancelled";
      let result: unknown;
      if (kind === "screenshot") {
        if (!pickers.screenshotAvailability.available) throw Error("Screenshot capture is unavailable.");
        const selected = await pickers.screenshot(signal);
        if (!selected || !valid(signal)) return "cancelled";
        if (selected.confirmed !== true || !selected.deviceId) throw Error("Confirm a connected device first.");
        result = await owner.attachments.capture(conversationId!, selected.deviceId, true);
      } else {
        const file = await pickers.file(kind, signal);
        if (!file || !valid(signal)) return "cancelled";
        result = await owner.attachments.upload(conversationId!, kind, file);
      }
      if (!valid(signal)) return "cancelled";
      // F-05 returns undefined when a closed/removed upload is superseded.
      // Dispatch completion is not proof that a usable attachment exists.
      if (!result || typeof result !== "object" || !("state" in result) || result.state !== "ready"
        || !("conversationId" in result) || result.conversationId !== conversationId) throw Error("Attachment was not retained.");
      return "attached";
    },
  };
}
export function fanAvailable(mode: "preview" | "live", binding?: AttachmentFanBinding): boolean {
  return !!binding && binding.source === (mode === "live" ? "live" : "fixture") && binding.enabled
    && !!binding.scopeId && !!binding.conversationId;
}
