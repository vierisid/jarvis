import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RailConfirmationStack } from "./RailConfirmationStack";
import { LiveDataProvider, type LiveData } from "../shell/LiveDataContext";
import type { PendingApproval } from "../../hooks/useWebSocket";
import { voiceHint } from "./shownApproval";

/**
 * #855. With several approvals pending, "yes" names one only by position, so
 * the daemon refuses a voice decision. The rail must not keep inviting one.
 */
const approval = (id: string, timestamp: number): PendingApproval => ({
  id, shortId: id, intent: `Send email ${id}`, intentReason: "", category: "send_email",
  impact: "external", agentName: "PA", toolName: "send_email", urgency: "normal", reason: "", timestamp,
});

function hint(approvals: PendingApproval[]): string {
  const live = { approvals, clarifiers: [], repeatBacks: [] } as unknown as LiveData;
  const html = renderToStaticMarkup(<LiveDataProvider value={live}><RailConfirmationStack /></LiveDataProvider>);
  const m = /<div class="v2-rail-confirm__voice-hint">([\s\S]*?)<\/div>/.exec(html);
  if (!m) throw new Error("no voice hint");
  return m[1]!.replace(/<[^>]+>/g, "");
}

describe("#855: the rail's voice hint", () => {
  test("offers voice while one approval is pending", () => {
    expect(hint([approval("a", 1)])).toBe("Or say “approve” / “cancel”");
  });

  test("says to decide each on its card once two are pending", () => {
    const text = hint([approval("a", 1), approval("b", 2)]);
    expect(text).toBe("Several approvals are waiting: decide each on its card");
    expect(text).not.toContain("approve”");
  });

  test("voiceHint switches at exactly two", () => {
    expect([0, 1, 2, 3].map(voiceHint)).toEqual(["voice", "voice", "cards", "cards"]);
  });
});
