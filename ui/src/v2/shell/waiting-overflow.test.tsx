/**
 * #1160: "Open Jarvis" on an approval notification opens home, whose "waiting
 * on you" tile showed only the first three live approvals (and the first three
 * saved ones) with nothing saying more were waiting. A fourth approval was
 * invisible from the screen the tap lands on. The tile now says how many it is
 * not showing and links to Authority, which lists them all.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LiveData } from "./LiveDataContext";
import type { PendingApproval } from "../../hooks/useWebSocket";
import { WaitingWidget } from "./NowRoom";

function approval(id: string): PendingApproval {
  return { id, shortId: id, intent: `do ${id}`, intentReason: "", category: "execute_command", impact: "destructive",
    agentName: "PA", toolName: "run_command", urgency: "normal", reason: "", timestamp: 0 };
}
const ready = <T,>(data: T[]) => ({ data, availability: "ready" as const, error: null, updatedAt: 0, refresh: async () => {} });

function render(liveCount: number, saved: Array<{ id: string; tool_name: string; reason: string }> = []): string {
  const live = { approvals: Array.from({ length: liveCount }, (_, i) => approval(`a${i}`)), clarifiers: [], repeatBacks: [] } as unknown as LiveData;
  return renderToStaticMarkup(<WaitingWidget live={live} inbox={{ pending: ready(saved), unresolved: ready([]) } as never}
    failures={ready([]) as never} connection="live" onApprove={() => {}} onCancel={() => {}} />);
}

const MORE = /\+(\d+) more approvals? waiting - open Authority/;

describe("#1160: the home tile says when approvals are not shown", () => {
  test("three live approvals fit: no overflow row", () => {
    const html = render(3);
    expect(html.match(/class="rs-apr"/g)?.length).toBe(3);
    expect(html).not.toMatch(MORE);
  });

  test("five live approvals: three cards and a row naming the other two", () => {
    const html = render(5);
    expect(html.match(/class="rs-apr"/g)?.length).toBe(3);
    expect(html.match(MORE)?.[1]).toBe("2");
    expect(html).not.toContain("do a3");
  });

  test("one hidden approval reads in the singular", () => {
    expect(render(4)).toContain("+1 more approval waiting - open Authority");
  });

  test("saved approvals past three count too", () => {
    const saved = Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, tool_name: "send_email", reason: "r" }));
    expect(render(4, saved).match(MORE)?.[1]).toBe("2");
  });

  test("a saved approval that is also live is counted once", () => {
    // a0-a4 are the five live ones; the inbox also holds them, plus s0.
    const saved = [...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, tool_name: "run_command", reason: "r" })),
      { id: "s0", tool_name: "send_email", reason: "r" }];
    expect(render(5, saved).match(MORE)?.[1]).toBe("2");
  });
});
