import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedMirror,
  CODE_STEP_CAPTURE_CHARS,
  CODE_STEP_MEMORY_MB_DEFAULT,
  codeStepMemoryCeilingMb,
  keepTail,
  noOpCodeSandbox,
  oversizedResultMessage,
  ranOutOfMemory,
  withMemoryCeiling,
} from "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox";

function step(body: string): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-code-limits-"));
  const file = join(dir, "step.js");
  writeFileSync(file, `exports.code = async (inputs) => { ${body} };\n`);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("a CODE step's limits", () => {
  test("the memory ceiling defaults to 4 GiB, can be changed, and 0, Windows or macOS (which does not enforce it) removes it; a bad value keeps the default", () => {
    expect(codeStepMemoryCeilingMb({}, "linux")).toBe(CODE_STEP_MEMORY_MB_DEFAULT);
    expect(codeStepMemoryCeilingMb({ AP_CODE_STEP_MEMORY_MB: "512" }, "linux")).toBe(512);
    expect(codeStepMemoryCeilingMb({ AP_CODE_STEP_MEMORY_MB: "0" }, "linux")).toBeNull();
    expect(codeStepMemoryCeilingMb({ AP_CODE_STEP_MEMORY_MB: "lots" }, "linux")).toBe(CODE_STEP_MEMORY_MB_DEFAULT);
    expect(codeStepMemoryCeilingMb({}, "win32")).toBeNull();
    expect(codeStepMemoryCeilingMb({}, "darwin")).toBeNull();
    const [command, args] = withMemoryCeiling("/usr/bin/bun", ["--eval", "x"], 2048);
    expect(command).toBe("/bin/sh");
    expect(args.slice(-3)).toEqual(["/usr/bin/bun", "--eval", "x"]);
    expect(args).toContain(String(2048 * 1024));
    expect(args.join(" ")).toContain("env -u PWD");
  });

  test("the log copy stops at its budget, says so once, and counts what it left out", () => {
    const lines: string[] = [];
    const mirror = boundedMirror((line) => lines.push(line), 100);
    for (let i = 0; i < 50; i++) mirror.push(Buffer.from("x".repeat(40) + "\n"));
    mirror.finish();
    const shown = lines.filter((l) => /^x+$/.test(l)).join("").length;
    expect(shown).toBeLessThanOrEqual(100);
    expect(lines.filter((l) => l.includes("only copied to this log"))).toHaveLength(1);
    expect(lines.at(-1)).toMatch(/^\[\d+ bytes of CODE step output were not copied to this log\]$/);
    const omitted = Number(/\[(\d+) bytes/.exec(lines.at(-1)!)![1]);
    expect(omitted).toBeGreaterThan(1500);
  });

  test("the copy kept for a failure message is the end of the output, marked", () => {
    let kept = "";
    for (let i = 0; i < 20; i++) kept = keepTail(kept, `${i}:`.padEnd(8_000, "."));
    expect(kept.length).toBeLessThanOrEqual(CODE_STEP_CAPTURE_CHARS + 30);
    expect(kept.startsWith("[earlier output omitted]")).toBe(true);
    expect(kept).toContain("19:");
  });

  test.skipIf(process.platform !== "linux")("a step that prints 30 MB copies at most the budget to the daemon log and still succeeds", async () => {
    const { file, done } = step("for (let i = 0; i < 300; i++) console.log('y'.repeat(100000)); return { ok: 1 };");
    const logged: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
    try {
      expect(await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} })).toEqual({ ok: 1 });
      await new Promise((resolve) => setTimeout(resolve, 300)); // the child's close, and the note about what was left out
    } finally { console.log = original; done(); }
    const bytes = logged.reduce((n, l) => n + l.length, 0);
    expect(bytes).toBeLessThan(200 * 1024);
    expect(logged.some((l) => l.includes("not copied to this log"))).toBe(true);
  }, 60_000);

  test.skipIf(process.platform !== "linux")("a step that allocates past the ceiling fails with a plain message and the machine keeps its memory", async () => {
    const previous = process.env.AP_CODE_STEP_MEMORY_MB;
    process.env.AP_CODE_STEP_MEMORY_MB = "1024";
    const { file, done } = step("const kept = []; for (let i = 0; i < 16; i++) kept.push(Buffer.alloc(256 * 1024 * 1024, 1)); return { allocated: kept.length };");
    try {
      const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} }).then(() => null, (e: Error) => e);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("This CODE step ran out of memory: a step may use up to 1024 MB.");
      expect(error!.message).toContain("JARVIS_CODE_STEP_MEMORY_MB");
    } finally {
      if (previous === undefined) delete process.env.AP_CODE_STEP_MEMORY_MB; else process.env.AP_CODE_STEP_MEMORY_MB = previous;
      done();
    }
  }, 60_000);

  test("a result past the run's 10 MB data cap fails the step in plain words, and a smaller one passes", async () => {
    const big = step("return { blob: 'x'.repeat(11 * 1024 * 1024) };");
    const fine = step("return { blob: 'x'.repeat(2 * 1024 * 1024) };");
    try {
      const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: big.file, inputs: {} }).then(() => null, (e: Error) => e);
      expect(error!.message).toBe(oversizedResultMessage(11 * 1024 * 1024 + 12));
      expect(error!.message).toContain("returned 11 MB of data, more than a run can keep (10 MB)");
      expect(error!.message).toContain("Return less from the step");
      const ok = await noOpCodeSandbox.runCodeModule({ codeFilePath: fine.file, inputs: {} }) as { blob: string };
      expect(ok.blob.length).toBe(2 * 1024 * 1024);
    } finally { big.done(); fine.done(); }
  }, 60_000);

  test.skipIf(process.platform !== "linux")("the wrapper adds nothing to the step's environment", async () => {
    const { file, done } = step("return Object.keys(process.env).sort();");
    const previous = process.env.AP_CODE_STEP_MEMORY_MB;
    try {
      delete process.env.AP_CODE_STEP_MEMORY_MB;
      const wrapped = await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} }) as string[];
      process.env.AP_CODE_STEP_MEMORY_MB = "0";
      const direct = await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} }) as string[];
      // Whatever /bin/sh is (dash, or bash, which also exports SHLVL), the step sees the same names as without it.
      expect(wrapped).toEqual(direct);
      for (const name of ["PWD", "OLDPWD", "_", "SHLVL"]) expect(wrapped).not.toContain(name);
      const shellExports = withMemoryCeiling("/bin/true", [], 1)[1][1];
      for (const name of ["PWD", "OLDPWD", "SHLVL", "_"]) expect(shellExports).toContain(`-u ${name} `);
    } finally {
      if (previous === undefined) delete process.env.AP_CODE_STEP_MEMORY_MB; else process.env.AP_CODE_STEP_MEMORY_MB = previous;
      done();
    }
  }, 60_000);

  test("out of memory is said for the runtime's own failure or a crash, never for what the step printed", () => {
    expect(ranOutOfMemory("RangeError: Out of memory\n    at step.js:1", "", null)).toBe(true);
    expect(ranOutOfMemory("Error: spawn ENOMEM", "", null)).toBe(true);
    expect(ranOutOfMemory("Code process exited with code null and signal SIGABRT", "", "SIGABRT")).toBe(true);
    expect(ranOutOfMemory("Code process exited with code null and signal SIGILL", "Bun has crashed", "SIGILL")).toBe(true);
    expect(ranOutOfMemory("Code process exited with code 1 and signal null", "ENOMEM out of memory", null)).toBe(false);
    expect(ranOutOfMemory("Error: api failure", "the API said: out of memory, ENOMEM, allocation failed", null)).toBe(false);
    expect(ranOutOfMemory("Code process exited with code null and signal SIGTERM", "", "SIGTERM")).toBe(false);
  });

  test("a step that prints an out-of-memory word and then throws keeps its own error", async () => {
    const { file, done } = step("console.error('upstream said ENOMEM: out of memory'); throw new Error('api failure');");
    try {
      const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} }).then(() => null, (e: Error) => e);
      expect(error!.message).toContain("api failure");
      expect(error!.message).not.toContain("ran out of memory");
    } finally { done(); }
  }, 60_000);

  test.skipIf(process.platform !== "linux")("an over-size result is refused in the step's own process, so it never reaches the engine's memory", async () => {
    // 200 MB: carried over IPC, parsed and measured here it cost this process about 1 GB of peak memory.
    const { file, done } = step("return 'x'.repeat(200 * 1024 * 1024);");
    try {
      const before = process.resourceUsage().maxRSS;
      const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: file, inputs: {} }).then(() => null, (e: Error) => e);
      const grewKb = process.resourceUsage().maxRSS - before;
      expect(error!.message).toContain("returned 200 MB of data, more than a run can keep (10 MB)");
      expect(grewKb).toBeLessThan(150 * 1024);
    } finally { done(); }
  }, 60_000);

  test("an ordinary step is unaffected, and an error thrown by the step keeps its own message", async () => {
    const ok = step("return { sum: inputs.a + inputs.b };");
    const bad = step("throw new Error('boom from the step');");
    try {
      expect(await noOpCodeSandbox.runCodeModule({ codeFilePath: ok.file, inputs: { a: 2, b: 3 } })).toEqual({ sum: 5 });
      const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: bad.file, inputs: {} }).then(() => null, (e: Error) => e);
      expect(error!.message).toContain("boom from the step");
      expect(error!.message).not.toContain("ran out of memory");
    } finally { ok.done(); bad.done(); }
  }, 60_000);
});

test("the daemon's JARVIS_CODE_STEP_MEMORY_MB reaches the engine as digits only", async () => {
  const { engineEnv } = await import("./spawn");
  const base = { bundlePath: "/x/main.js", sandboxId: "sb", sandboxWsPort: 1, baseCodeDir: "/tmp" };
  const saved = process.env.JARVIS_CODE_STEP_MEMORY_MB;
  try {
    process.env.JARVIS_CODE_STEP_MEMORY_MB = "4096";
    expect(engineEnv(base).AP_CODE_STEP_MEMORY_MB).toBe("4096");
    process.env.JARVIS_CODE_STEP_MEMORY_MB = "4096; rm -rf /";
    expect(engineEnv(base).AP_CODE_STEP_MEMORY_MB).toBeUndefined();
    delete process.env.JARVIS_CODE_STEP_MEMORY_MB;
    expect(engineEnv(base).AP_CODE_STEP_MEMORY_MB).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.JARVIS_CODE_STEP_MEMORY_MB; else process.env.JARVIS_CODE_STEP_MEMORY_MB = saved;
  }
});
