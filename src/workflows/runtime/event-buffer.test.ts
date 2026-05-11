/**
 * Coverage for the WorkflowEventBuffer's overflow + age-prune signal.
 * The capacity/age behavior itself is exercised indirectly via the
 * on_event polling tests, but the dropped() accessor that's surfaced to
 * the dashboard for "events may have been missed" warnings is new.
 */

import { describe, expect, test } from "bun:test";
import { WorkflowEventBuffer } from "./event-buffer";

describe("WorkflowEventBuffer dropped() signal", () => {
  test("starts at zero and ticks up when capacity overflows", () => {
    const buf = new WorkflowEventBuffer({ capacity: 3 });
    expect(buf.dropped()).toEqual({ count: 0, lastDroppedAt: 0, lastDroppedHeadId: 0 });

    // Fill to capacity -- no drops yet.
    buf.publish("e", { i: 1 });
    buf.publish("e", { i: 2 });
    buf.publish("e", { i: 3 });
    expect(buf.dropped().count).toBe(0);

    // One more event evicts the oldest -- single drop recorded.
    buf.publish("e", { i: 4 });
    const after = buf.dropped();
    expect(after.count).toBe(1);
    expect(after.lastDroppedAt).toBeGreaterThan(0);
    expect(after.lastDroppedHeadId).toBe(4);

    // Two more push out two more -- counter accumulates.
    buf.publish("e", { i: 5 });
    buf.publish("e", { i: 6 });
    expect(buf.dropped().count).toBe(3);
  });

  test("age pruning also bumps the drop counter", () => {
    // Fake clock so we can age-out without wall sleeps.
    let now = 1_000_000;
    const buf = new WorkflowEventBuffer({
      capacity: 1000,
      maxAgeMs: 100,
      now: () => now,
    });
    buf.publish("e", { i: 1 });
    buf.publish("e", { i: 2 });
    expect(buf.dropped().count).toBe(0);

    // Advance past maxAgeMs; the next publish prunes both.
    now += 1_000;
    buf.publish("e", { i: 3 });
    expect(buf.dropped().count).toBe(2);
    expect(buf.size()).toBe(1);
  });

  test("dropped events covered the consumer's gap", () => {
    // A polling trigger persists `since = head at last poll`. When it
    // polls again, it can compare its persisted `since` against
    // `dropped().lastDroppedHeadId`: if the dropped head id is > since,
    // events in the consumer's range were evicted -- they may have been
    // missed. The buffer doesn't decide, just surfaces the facts.
    const buf = new WorkflowEventBuffer({ capacity: 2 });
    buf.publish("e", { i: 1 });
    buf.publish("e", { i: 2 });
    // Consumer polled here with since=2.
    const consumerSince = 2;
    buf.publish("e", { i: 3 }); // drops id=1
    buf.publish("e", { i: 4 }); // drops id=2
    const sig = buf.dropped();
    // sig.lastDroppedHeadId is the head AT THE TIME of the most recent drop.
    // It's >= the events the consumer hadn't seen, so consumer can compare.
    expect(sig.lastDroppedHeadId).toBeGreaterThan(consumerSince);
    expect(sig.count).toBe(2);
  });
});
