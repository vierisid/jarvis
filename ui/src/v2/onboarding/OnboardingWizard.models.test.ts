import { describe, expect, test } from "bun:test";
import { NVIDIA_DEFAULT_MODEL, selectLiveNvidiaModel } from "./OnboardingWizard";

describe("selectLiveNvidiaModel", () => {
  test("keeps a selection that remains in the live catalog", () => {
    expect(selectLiveNvidiaModel("publisher/current", ["publisher/current", NVIDIA_DEFAULT_MODEL]))
      .toBe("publisher/current");
  });

  test("replaces a retired selection with the preferred live model", () => {
    expect(selectLiveNvidiaModel("meta/llama-3.3-70b-instruct", ["other/chat", NVIDIA_DEFAULT_MODEL]))
      .toBe(NVIDIA_DEFAULT_MODEL);
  });

  test("falls back predictably when the preferred model is unavailable", () => {
    expect(selectLiveNvidiaModel("retired", ["first/live", "second/live"]))
      .toBe("first/live");
    expect(selectLiveNvidiaModel("retired", [])).toBe("retired");
  });
});
