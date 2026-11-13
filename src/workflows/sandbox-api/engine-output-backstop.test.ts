/**
 * The daemon's own cut of engine output (runtime/engine-console-redaction.ts):
 * a serialized failed request that reached the engine's pipes or its notify
 * channel anyway is cut before the daemon log and the per-run log buffer
 * keep it. The engine-side redaction is tested on its own; these feed the
 * daemon raw text, as an engine without it would send.
 */
import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { DefaultWorkerHandlers, type LogLine } from "./worker-handlers";
import { SandboxRegistry } from "./sandbox-registry";
import { bindEngineStream } from "../runner/engine-runtime/engine-runtime";

const RAW = 'step failed {"response":{"status":401,"body":{"refresh_token":"RESP-SECRET"}},"request":{"body":{"password":"BODY-SECRET"}}}\nnext line\n';

test("the per-run log buffer keeps no serialized request body", () => {
  const registry = new SandboxRegistry();
  registry.register({ sandboxId: "sbx", runId: "run1", projectId: "p", engineToken: "t", expiresAt: Date.now() + 60_000, terminatedAt: null });
  const lines: LogLine[] = [];
  const handlers = new DefaultWorkerHandlers({ registry, onLogLine: (entry) => { lines.push(entry); } });
  handlers.stderr("sbx", { message: RAW });
  expect(lines).toHaveLength(1);
  expect(lines[0]!.message).toBe("step failed [request and response bodies withheld]\nnext line\n");
});

test("engine output copied into the daemon log keeps no serialized request body", () => {
  const stream = new PassThrough();
  const written: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const tail: string[] = [];
  try {
    bindEngineStream(stream, "stderr", "sandbox-1", tail);
    stream.emit("data", Buffer.from(RAW));
  } finally {
    process.stderr.write = write as typeof process.stderr.write;
  }
  const text = written.join("") + tail.join("");
  for (const secret of ["RESP-SECRET", "BODY-SECRET"]) expect(text).not.toContain(secret);
  expect(text).toContain("step failed [request and response bodies withheld]");
  expect(text).toContain("next line");
});
