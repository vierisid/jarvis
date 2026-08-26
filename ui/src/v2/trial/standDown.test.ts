import { describe, expect, it } from "bun:test";
import {
  STANDDOWN_BACKSTOP_MS,
  STANDDOWN_MAX_WAIT_MS,
  STANDDOWN_SPEECH_GRACE_MS,
  standDownVerdict,
  type StandDownInput,
} from "./standDown";

const T0 = 1_800_000_000_000;

function at(patch: Partial<StandDownInput>): StandDownInput {
  return {
    requestedAt: null,
    finishedAt: null,
    speaking: false,
    spokeSinceRequest: false,
    now: T0,
    ...patch,
  };
}

describe("the conductor's stand-down", () => {
  it("does nothing while nobody has asked and nothing has finished", () => {
    expect(standDownVerdict(at({}))).toEqual({ stand: false, because: "not-asked" });
  });

  /* ── Rule 2: never over the top of the sentence they just earned ── */

  it("waits while Jarvis is still speaking", () => {
    const v = standDownVerdict(at({ requestedAt: T0, speaking: true, now: T0 + 3_000 }));
    expect(v).toEqual({ stand: false, because: "speaking" });
  });

  it("stands down the moment the acknowledgement finishes", () => {
    const v = standDownVerdict(
      at({ requestedAt: T0, speaking: false, spokeSinceRequest: true, now: T0 + 4_000 }),
    );
    expect(v).toEqual({ stand: true, because: "spoke-and-stopped" });
  });

  it("holds briefly for a sentence that has not started yet", () => {
    const v = standDownVerdict(at({ requestedAt: T0, now: T0 + STANDDOWN_SPEECH_GRACE_MS - 1 }));
    expect(v).toEqual({ stand: false, because: "waiting-for-speech" });
  });

  /* ── Rule 3: it always finishes ── */

  it("stops holding when nothing is ever said", () => {
    const v = standDownVerdict(at({ requestedAt: T0, now: T0 + STANDDOWN_SPEECH_GRACE_MS }));
    expect(v).toEqual({ stand: true, because: "nothing-said" });
  });

  it("stands down mid-sentence rather than never, past the ceiling", () => {
    const v = standDownVerdict(
      at({ requestedAt: T0, speaking: true, spokeSinceRequest: true, now: T0 + STANDDOWN_MAX_WAIT_MS }),
    );
    expect(v).toEqual({ stand: true, because: "timed-out" });
  });

  it("a model that talks forever does not keep the shell", () => {
    // Every second from the request to the ceiling, speaking throughout.
    for (let t = 0; t < STANDDOWN_MAX_WAIT_MS; t += 1_000) {
      expect(
        standDownVerdict(at({ requestedAt: T0, speaking: true, spokeSinceRequest: true, now: T0 + t })).stand,
      ).toBe(false);
    }
    expect(
      standDownVerdict(
        at({ requestedAt: T0, speaking: true, spokeSinceRequest: true, now: T0 + STANDDOWN_MAX_WAIT_MS + 1 }),
      ).stand,
    ).toBe(true);
  });

  /* ── Rule 1: it happens even when nobody asks ──
     This is the one that fixes the reported bug. A model that finishes the
     finale and never calls `teach_summon` used to leave the founder under a
     conductor forever. */

  it("hands the shell back on its own if the model never asks", () => {
    const v = standDownVerdict(at({ finishedAt: T0, now: T0 + STANDDOWN_BACKSTOP_MS }));
    expect(v).toEqual({ stand: true, because: "backstop" });
  });

  it("does not fire the backstop early", () => {
    const v = standDownVerdict(at({ finishedAt: T0, now: T0 + STANDDOWN_BACKSTOP_MS - 1 }));
    expect(v).toEqual({ stand: false, because: "not-asked" });
  });

  it("the backstop does not cut across a sentence either", () => {
    const v = standDownVerdict(at({ finishedAt: T0, speaking: true, now: T0 + STANDDOWN_BACKSTOP_MS + 60_000 }));
    expect(v).toEqual({ stand: false, because: "not-asked" });
    // ...and lands as soon as the sentence ends.
    expect(
      standDownVerdict(at({ finishedAt: T0, speaking: false, now: T0 + STANDDOWN_BACKSTOP_MS + 61_000 })).stand,
    ).toBe(true);
  });

  it("a request always beats the backstop, whichever came first", () => {
    // Onboarding finished long ago AND the daemon has just asked: the request
    // is the live thing, so its own rules apply rather than the backstop's.
    const v = standDownVerdict(
      at({ finishedAt: T0, requestedAt: T0 + STANDDOWN_BACKSTOP_MS, speaking: true, now: T0 + STANDDOWN_BACKSTOP_MS + 1_000 }),
    );
    expect(v).toEqual({ stand: false, because: "speaking" });
  });

  /* ── the founder who never presses the key ── */

  it("stands down for a founder who never pressed anything", () => {
    // `pressed` is not an input here on purpose: the daemon asks for the
    // stand-down on both branches of `await_summon`, so a founder who walked
    // away gets their shell back exactly like one who pressed it.
    const v = standDownVerdict(at({ requestedAt: T0, spokeSinceRequest: true, now: T0 + 2_000 }));
    expect(v.stand).toBe(true);
  });
});
