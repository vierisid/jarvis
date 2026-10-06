import React, { useState } from "react";
import { ComposerSpecimen } from "../../composer/preview/ComposerSpecimen";
import { AttachmentFan } from "../AttachmentFan";
import type { AttachmentFanBinding } from "../model";
import "./specimen.css";

/** Selection-only fixture. No file picker, upload, account or desktop is invoked. */
export function AttachmentSpecimen() {
  const [screenshot, setScreenshot] = useState(false), [fail, setFail] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  return <><ComposerSpecimen attachmentEntry={({ conversationId, connected, reducedMotion }) => {
    const id = conversationId ?? "";
    const binding: AttachmentFanBinding = { source: "fixture", scopeId: "attachment-preview", conversationId,
      enabled: connected && !!id, screenshot: { available: screenshot, reason: "No capture-capable desktop connected." },
      reason: "Connect to attach files.",
      async choose(kind, signal) {
        // The selected conversation is captured before this simulated acknowledgment.
        await new Promise(resolve => setTimeout(resolve, 350));
        if (signal.aborted) return "cancelled";
        if (fail) throw Error("Illustrative failure");
        setSelected(previous => [...previous, `${id}: ${kind}`]);
        return "attached";
      },
    };
    return <AttachmentFan mode="preview" binding={binding} reducedMotion={reducedMotion}
      onFeedback={message => setFeedback(previous => ({ ...previous, [id]: message }))} />;
  }} />
    <aside className="d14-fixture-controls" aria-label="Attachment fixture controls">
      <strong>Attachment fixture only</strong>
      <label><input type="checkbox" checked={screenshot} onChange={event => setScreenshot(event.target.checked)} /> Screenshot available</label>
      <label><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} /> Fail attachment</label>
      <output aria-label="Attachment selections">{selected.length} selections{selected.length ? ` · ${selected.at(-1)}` : ""}</output>
      <output aria-label="Attachment feedback" role="status">{Object.values(feedback).filter(Boolean).join(" · ")}</output>
    </aside>
  </>;
}
