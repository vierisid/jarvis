import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb } from "../../workflows/db/index";
import { getFlow } from "../../workflows/db/repos/flow";
import { createCompositionJournal, getWorkflowComposition } from "../../workflows/db/repos/workflow-composition";
import { sampleCatalog } from "../../workflows/runtime/test-fixtures";
import { composePersistedFlow } from "./persisted-workflow-composer";
import { createManageWorkflowTool } from "./manage-workflow";
import { jobSpecification, type ComposerLlmClient } from "./workflow-composer";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jarvis-compose-intent-"));
  path = join(directory, "test.db");
  initWorkflowDb(path);
});
afterEach(() => { closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });
const request = { name: "Private report", description: "On manual trigger, draft a Markdown report in the dashboard. Never send email or delete files." };
const valid = JSON.stringify({ displayName: request.name, trigger: { name: "trigger", type: "EMPTY" } });
const invalid = JSON.stringify({ displayName: request.name, trigger: { name: "trigger", type: "EMPTY",
  nextAction: { name: "bad", type: "PIECE", settings: { pieceName: "missing", actionName: "x" } } } });
function onlyId() {
  return getWorkflowDb().query<{ id: string }, []>("SELECT id FROM workflow_composition").get()!.id;
}

test("chat commits the specification and repair checkpoint before the next LLM call, then links the draft", async () => {
  let calls = 0;
  const llm: ComposerLlmClient = { async chat() {
    // A separate reader proves neither the specification nor repair checkpoint
    // is hidden in a transaction spanning a provider request.
    const reader = new Database(path, { readonly: true });
    try {
      const row = reader.query<{ specification: string; previous_response: string | null }, []>(
        "SELECT specification, previous_response FROM workflow_composition").get()!;
      expect(JSON.parse(row.specification)).toEqual(jobSpecification(request));
      expect(row.previous_response).toBe(calls === 0 ? null : "{unfinished");
    } finally { reader.close(); }
    return { text: ++calls === 1 ? "{unfinished" : valid };
  } };
  const tool = createManageWorkflowTool({ llm, pieceRegistry: sampleCatalog() });
  const result = JSON.parse(await tool.execute({ action: "compose", ...request }) as string);
  expect(result.ok).toBe(true);
  expect(calls).toBe(2);
  const metadata = JSON.parse(getFlow(result.flow.id)!.metadata!);
  expect(metadata.compositionRecordId).toBe(result.compositionRecordId);
  closeWorkflowDb(); initWorkflowDb(path);
  expect(getWorkflowComposition(result.compositionRecordId)).toMatchObject({
    specification: jobSpecification(request), state: "VALIDATED", previousResponse: valid, errors: [],
  });
});

test("failed composition retains its original spec, full candidate and focused errors across restart", async () => {
  const largeCandidate = JSON.stringify({ ...JSON.parse(invalid), notes: "Preserve this draft context. ".repeat(200) });
  expect(largeCandidate.length).toBeGreaterThan(4096);
  const result = await composePersistedFlow({ llm: { async chat() { return { text: largeCandidate }; } },
    pieceRegistry: sampleCatalog(), maxAttempts: 1 }, request);
  expect(result.ok).toBe(false);
  closeWorkflowDb(); initWorkflowDb(path);
  const record = getWorkflowComposition(result.compositionRecordId)!;
  expect(record).toMatchObject({ specification: jobSpecification(request), state: "FAILED", previousResponse: largeCandidate, previousGraph: JSON.parse(largeCandidate) });
  expect(record.errors[0]).toContain('unknown piece "missing"');
  expect(getWorkflowComposition(result.compositionRecordId, "another-project")).toBeNull();
});

test("caller mutation cannot change the saved specification or repair prompt", async () => {
  const input = { ...request };
  let calls = 0;
  const result = await composePersistedFlow({ pieceRegistry: sampleCatalog(), llm: { async chat({ prompt }) {
    if (++calls === 1) { input.description = "Email everybody instead"; return { text: invalid }; }
    expect(prompt).toContain(request.description);
    expect(prompt).not.toContain(input.description);
    return { text: valid };
  } } }, input);
  expect(result.ok).toBe(true);
  expect(getWorkflowComposition(result.compositionRecordId)!.specification).toEqual(jobSpecification(request));
});

test("cancellation retains the checkpoint and never accepts the late candidate", async () => {
  const abort = new AbortController();
  let calls = 0;
  const pending = composePersistedFlow({ pieceRegistry: sampleCatalog(), llm: { async chat() {
    if (++calls === 1) return { text: invalid };
    abort.abort(new Error("stopped"));
    return { text: valid };
  } } }, { ...request, signal: abort.signal });
  await expect(pending).rejects.toThrow("stopped");
  expect(getWorkflowComposition(onlyId())).toMatchObject({ state: "FAILED", previousResponse: invalid, errors: ["stopped"] });
  expect(calls).toBe(2);
});

test("checkpoint failure stops before another LLM attempt or draft creation", async () => {
  getWorkflowDb().exec(`CREATE TRIGGER broken_checkpoint BEFORE UPDATE ON workflow_composition
    BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`);
  let calls = 0;
  await expect(composePersistedFlow({ pieceRegistry: sampleCatalog(), llm: { async chat() {
    calls++; return { text: invalid };
  } } }, request)).rejects.toThrow("checkpoint write failed");
  expect(calls).toBe(1);
  expect(getWorkflowDb().query("SELECT * FROM flow").all()).toHaveLength(0);
});

test("an interrupted record remains inspectable after restart without becoming a runnable job", () => {
  const journal = createCompositionJournal(jobSpecification(request));
  journal.checkpoint({ previousResponse: invalid, previousGraph: JSON.parse(invalid), errors: ["missing piece"] });
  closeWorkflowDb(); initWorkflowDb(path);
  expect(getWorkflowComposition(journal.id)).toMatchObject({ state: "COMPOSING", specification: jobSpecification(request), previousResponse: invalid });
  expect(getWorkflowDb().query("SELECT * FROM flow").all()).toHaveLength(0);
});

test("a late completion cannot checkpoint into a replacement database", async () => {
  let release!: (value: { text: string }) => void;
  const pending = composePersistedFlow({ pieceRegistry: sampleCatalog(), llm: { async chat() {
    return new Promise(resolve => { release = resolve; });
  } } }, request);
  // Attach the handler before releasing the provider, without awaiting the
  // rejection matcher (Bun may wait synchronously inside it).
  const settled = pending.then(() => null, error => error);
  closeWorkflowDb(); initWorkflowDb(join(directory, "replacement.db"));
  release({ text: valid });
  expect(await settled).toBeInstanceOf(Error);
  expect(getWorkflowDb().query("SELECT * FROM workflow_composition").all()).toHaveLength(0);
});
