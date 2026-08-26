import { describe, expect, test } from "bun:test";
import { STALE_ROOMS_TEXT, pebbleView, type ConductorPhase } from "./pebbleState.ts";

const PHASES: ConductorPhase[] = ["connecting", "speaking", "listening", "closed", "error"];

describe("the reported bug: Jarvis's words under a resting vermilion pebble", () => {
  test("a caption left over from Jarvis's turn is not shown while listening", () => {
    const v = pebbleView({
      phase: "listening",
      caption: "I am Jarvis. From here on I am your co-founder,",
      error: null,
      pointing: null,
    });
    expect(v.state).toBe("listening");
    expect(v.bubble.kind).toBe("hint");
    expect(v.bubble.text).toBe("your turn");
  });

  test("there is NO input at all that shows a caption without the speaking state", () => {
    for (const phase of PHASES) {
      for (const caption of ["", "something Jarvis said"]) {
        for (const error of [null, "the connection failed"]) {
          for (const pointing of [null, "their quarter"]) {
            const v = pebbleView({ phase, caption, error, pointing });
            if (v.bubble.kind === "caption") expect(v.state).toBe("speaking");
          }
        }
      }
    }
  });

  test("the caption is shown while Jarvis is actually speaking", () => {
    const v = pebbleView({ phase: "speaking", caption: "Tell me about it.", error: null, pointing: null });
    expect(v.bubble).toEqual({ kind: "caption", text: "Tell me about it." });
  });
});

describe("what the bubble says when there is nothing to quote", () => {
  test("speaking with no words yet is a pause, not an empty bubble", () => {
    expect(pebbleView({ phase: "speaking", caption: "", error: null, pointing: null }).bubble)
      .toEqual({ kind: "hint", text: "…" });
  });

  test("listening hands the floor back in words", () => {
    expect(pebbleView({ phase: "listening", caption: "", error: null, pointing: null }).bubble)
      .toEqual({ kind: "hint", text: "your turn" });
  });

  test("connecting says nothing at all", () => {
    expect(pebbleView({ phase: "connecting", caption: "", error: null, pointing: null }).bubble)
      .toEqual({ kind: "hint", text: "…" });
  });
});

describe("error and pointing outrank the words", () => {
  test("an error greys the pebble and replaces whatever was in the bubble", () => {
    const v = pebbleView({ phase: "speaking", caption: "mid-sentence", error: "The connection to Jarvis failed.", pointing: null });
    expect(v.state).toBe("error");
    expect(v.bubble).toEqual({ kind: "error", text: "The connection to Jarvis failed." });
  });

  test("a gesture replaces the caption for as long as it lasts (D21)", () => {
    const v = pebbleView({ phase: "speaking", caption: "here is your quarter", error: null, pointing: "their quarter" });
    expect(v.state).toBe("speaking");
    expect(v.bubble).toEqual({ kind: "point", text: "their quarter" });
  });

  test("a gesture during an error keeps the error colour", () => {
    const v = pebbleView({ phase: "listening", caption: "", error: "gone", pointing: "the week" });
    expect(v.state).toBe("error");
    expect(v.bubble.kind).toBe("point");
  });
});

describe("the rooms going stale under a conversation that has not", () => {
  test("says so in the gaps, without claiming the conversation broke", () => {
    const v = pebbleView({ phase: "listening", caption: "", error: null, pointing: null, stale: true });
    // The colour stays honest: Jarvis really is still listening.
    expect(v.state).toBe("listening");
    expect(v.bubble).toEqual({ kind: "error", text: STALE_ROOMS_TEXT });
  });

  test("never eats Jarvis's own words", () => {
    const v = pebbleView({ phase: "speaking", caption: "here is your quarter", error: null, pointing: null, stale: true });
    expect(v.bubble).toEqual({ kind: "caption", text: "here is your quarter" });
  });

  test("never eats the gesture", () => {
    const v = pebbleView({ phase: "listening", caption: "", error: null, pointing: "their quarter", stale: true });
    expect(v.bubble).toEqual({ kind: "point", text: "their quarter" });
  });

  test("a page that renewed says nothing new", () => {
    const v = pebbleView({ phase: "listening", caption: "", error: null, pointing: null, stale: false });
    expect(v.bubble).toEqual({ kind: "hint", text: "your turn" });
  });
});
