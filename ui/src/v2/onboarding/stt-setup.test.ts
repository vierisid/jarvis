import { describe, expect, test } from "bun:test";
import { localSTTSetup } from "./stt-setup";

describe("localSTTSetup", () => {
  test("keeps the selected whisper.cpp dialect", () => {
    expect(localSTTSetup(" http://localhost:8080 ", "whisper_cpp")).toEqual({
      endpoint: "http://localhost:8080",
      server_type: "whisper_cpp",
    });
  });

  test("keeps the selected OpenAI-compatible dialect", () => {
    expect(localSTTSetup("http://localhost:8000/v1", "openai_compatible")).toEqual({
      endpoint: "http://localhost:8000/v1",
      server_type: "openai_compatible",
    });
  });
});
