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
import { OPEN_FAILURES_LIMIT, WaitingWidget, failureOverflow } from "./NowRoom";
import { OPEN_FAILURES_LIMIT as SERVER_LIMIT } from "../../../../src/workflows/runtime/open-failures";

function approval(id: string): PendingApproval {
  return { id, shortId: id, intent: `do ${id}`, intentReason: "", category: "execute_command", impact: "destructive",
    agentName: "PA", toolName: "run_command", urgency: "normal", reason: "", timestamp: 0 };
}
const ready = <T,>(data: T[]) => ({ data, availability: "ready" as const, error: null, updatedAt: 0, refresh: async () => {} });

function render(liveCount: number, saved: Array<{ id: string; tool_name: string; reason: string }> = [], failureCount = 0): string {
  const live = { approvals: Array.from({ length: liveCount }, (_, i) => approval(`a${i}`)), clarifiers: [], repeatBacks: [] } as unknown as LiveData;
  return renderToStaticMarkup(<WaitingWidget live={live} inbox={{ pending: ready(saved), unresolved: ready([]) } as never}
    failures={ready(Array.from({ length: failureCount }, (_, i) => failure(i))) as never} connection="live" onApprove={() => {}} onCancel={() => {}} />);
}
function failure(i: number) {
  return { keys: [`k${i}`], repeats: 0, source: "run", title: `Flow ${i}`, flowId: `f${i}`, runId: `r${i}`, at: 0,
    failure: { category: "not_started", effect: "none", headline: `Run ${i} stopped.`, outcome: "Nothing was done.", next: [], links: {}, code: null, detail: "", key: `k${i}` } };
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

const MORE_FAILURES = /\+(\d+) more failures?(?:, and older ones may not be listed)? - show/;

describe("#1303 follow-up: the home tile says when failures are not shown, and shows them in place", () => {
  test("three failures fit: no overflow row", () => {
    const html = render(0, [], 3);
    expect(html).toContain("Run 2 stopped.");
    expect(html).not.toMatch(MORE_FAILURES);
  });

  test("five failures: three rows and a row naming the other two", () => {
    const html = render(0, [], 5);
    expect(html).not.toContain("Run 3 stopped.");
    expect(html.match(MORE_FAILURES)?.[1]).toBe("2");
    // The tile is the only list of open failures (runs, deliveries and chat): it does not send the person elsewhere.
    expect(html).not.toContain("open Workflows");
  });

  test("one hidden failure reads in the singular", () => {
    expect(render(0, [], 4)).toContain("+1 more failure - show");
  });

  test("expanded, every listed failure is shown, of any source", () => {
    const rows = [failure(0), failure(1), { ...failure(2), source: "chat" }, { ...failure(3), source: "delivery" }, { ...failure(4), source: "chat" }];
    expect(failureOverflow(rows, true)).toEqual({ visible: rows, hidden: 0, capped: false });
    expect(failureOverflow(rows, false)).toEqual({ visible: rows.slice(0, 3), hidden: 2, capped: false });
  });

  test("a full list may have been cut by the server, so it says older ones are not listed", () => {
    expect(OPEN_FAILURES_LIMIT).toBe(SERVER_LIMIT);
    const html = render(0, [], SERVER_LIMIT);
    expect(html).toContain(`+${SERVER_LIMIT - 3} more failures, and older ones may not be listed - show`);
    expect(render(0, [], SERVER_LIMIT - 1)).toContain(`+${SERVER_LIMIT - 4} more failures - show`);
    expect(failureOverflow(Array.from({ length: SERVER_LIMIT }, (_, i) => i), true).capped).toBe(true);
  });
});
