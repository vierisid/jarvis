import { expect, test } from "bun:test";
import { workflowStatusWords } from "./status-words";

const acts = ["ENABLED", "DISABLED"] as const;
const readies = ["ready", "blocked", "unknown"] as const;

test("every combination maps to On or Off with at most one note, never old words", () => {
  for (const activation of acts)
    for (const draftChangesNotLive of [false, true])
      for (const readiness of readies) {
        const w = workflowStatusWords({ activation, draftChangesNotLive, readiness });
        expect(w.state).toBe(activation === "ENABLED" ? "On" : "Off");
        const expectedNote = draftChangesNotLive && activation === "ENABLED" ? "Draft changes not live yet"
          : readiness === "blocked" ? "Needs setup"
          : readiness === "unknown" ? "Setup status unknown"
          : null;
        expect(w.note).toBe(expectedNote);
        expect(w.line).toBe(expectedNote ? `${w.state} · ${expectedNote}` : w.state);
        expect(w.line).not.toMatch(/Unpublished|Published|Enabled|Paused|Ready/);
      }
});
