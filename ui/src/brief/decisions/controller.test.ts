import { afterEach, expect, test } from "bun:test";
import { DecisionsController } from "./controller";
import {
  decisionFixture,
  makeDecisionsFixture,
  type DecisionExample,
} from "./fixtures";
import {
  decisionId,
  documentError,
  matchesReceipt,
  type DecisionsPort,
  type DocumentReceipt,
  type DocumentRequest,
  type DecisionCollection,
} from "./model";
const owners: DecisionsController[] = [];
const wait = () => new Promise((r) => setTimeout(r, 20));
function owner(port: DecisionsPort) {
  const c = new DecisionsController("fixture", "test", port, 2);
  c.setAccess(true);
  owners.push(c);
  return c;
}
function fixture(example: DecisionExample = "ready") {
  const f = makeDecisionsFixture(example, 0);
  const c = owner(f.port);
  return { ...f, c };
}
const A = "fixture-decision-follow-up",
  B = "fixture-decision-invitation";
afterEach(() => owners.splice(0).forEach((c) => c.retire()));
test("selection follows identity through reorder and refresh", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.select(B);
  f.reorder();
  await f.c.refresh();
  expect(f.c.snapshot().selectedId).toBe(B);
});
test("approval is acknowledged before next selection, and never claims execution", async () => {
  const f = fixture();
  await f.c.refresh();
  await f.c.act(A, "approve");
  expect(f.c.snapshot().selectedId).toBe(A);
  expect(f.c.snapshot().phase).toBe("acknowledge");
  expect(f.c.snapshot().message).toContain("Sending has not been confirmed");
  await f.c.act(A, "approve");
  await wait();
  expect(f.calls.length).toBe(1);
  expect(f.c.snapshot().selectedId).toBe(B);
});
test("keep draft remains in the queue and requires reopening, not silent reapproval", async () => {
  const f = fixture();
  await f.c.refresh();
  await f.c.act(A, "keep_draft");
  expect(f.c.snapshot().message).toContain("Draft kept. Nothing sent");
  await wait();
  expect(f.c.snapshot().selectedId).toBe(B);
  f.c.select(A);
  expect(f.c.canAct(A, "approve")).toBe(false);
  expect(f.c.canAct(A, "reopen")).toBe(true);
  await f.c.act(A, "reopen");
  await wait();
  expect(f.c.canAct(A, "approve")).toBe(true);
});
test("rejection has a truthful local receipt and resolves only the chosen item", async () => {
  const f = fixture();
  await f.c.refresh();
  await f.c.act(A, "reject");
  expect(f.c.snapshot().message).toContain("Rejected");
  await wait();
  expect(f.c.snapshot().rows.map(decisionId)).toEqual([B]);
});
test("edit/save carries the complete typed document and uses the new approval revision", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.edit(A);
  const doc = f.c.snapshot().draft!.document;
  expect(doc.kind).toBe("email");
  if (doc.kind !== "email") return;
  f.c.change({
    ...doc,
    subject: "Confirmed pilot",
    body: "Thursday works.",
    cc: ["team@example.test"],
  });
  expect(f.c.canAct(A, "approve")).toBe(false);
  await f.c.act(A, "save");
  await wait();
  expect(f.calls[0]!.document).toEqual({
    ...doc,
    subject: "Confirmed pilot",
    body: "Thursday works.",
    cc: ["team@example.test"],
  });
  expect(f.c.snapshot().draft).toBeNull();
  expect(f.c.snapshot().selectedId).toBe(A);
  expect(f.c.canAct(A, "approve")).toBe(true);
  await f.c.act(A, "approve");
  expect(f.calls[1]!.revision).not.toBe(f.calls[0]!.revision);
});
test("stale refresh preserves unsaved content and prevents save or approval", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.edit(A);
  const doc = f.c.snapshot().draft!.document;
  f.changeRevision();
  await f.c.refresh();
  expect(f.c.snapshot().draft!.document).toEqual(doc);
  expect(f.c.canAct(A, "save")).toBe(false);
  expect(f.c.canAct(A, "approve")).toBe(false);
  f.c.cancelEdit();
  await wait();
  expect(f.c.snapshot().draft).toBeNull();
  expect(f.c.canAct(A, "approve")).toBe(true);
});
test("cancel edit writes nothing and restores original document", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.edit(A);
  const before = f.c.snapshot().rows[0]!.document;
  f.c.change({
    ...f.c.snapshot().draft!.document,
    kind: "email",
    to: ["a@example.test"],
    cc: [],
    bcc: [],
    subject: "Changed",
    body: "Different",
  });
  f.c.cancelEdit();
  await wait();
  expect(f.calls.length).toBe(0);
  expect(f.c.snapshot().rows[0]!.document).toEqual(before);
});
test("invalid edits cannot be submitted", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.edit(A);
  f.c.change({
    kind: "email",
    to: ["invalid"],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
  });
  await f.c.act(A, "save");
  expect(f.calls.length).toBe(0);
});
test.each(["stale", "read-only", "unavailable", "empty"] as const)(
  "%s never offers a mutation",
  async (example) => {
    const f = fixture(example);
    await f.c.refresh();
    for (const action of ["approve", "reject", "keep_draft", "save"] as const) {
      expect(f.c.canAct(A, action)).toBe(false);
      await f.c.act(A, action);
    }
    expect(f.calls.length).toBe(0);
  },
);
test("rendered revision must match even when a fresher controller view exists", async () => {
  const f = fixture();
  await f.c.refresh();
  f.changeRevision();
  await f.c.refresh();
  await f.c.act(A, "approve", "fixture-v1");
  expect(f.calls.length).toBe(0);
});
test("lost responses stay pinned through empty/reordered reads; recovery never resends", async () => {
  const f = fixture("uncertain");
  await f.c.refresh();
  await f.c.act(A, "approve");
  await f.c.refresh();
  expect(f.c.snapshot().selectedId).toBe(A);
  expect(f.c.snapshot().attempts.get(A)!.state).toBe("unknown");
  expect(f.c.canAct(A, "approve")).toBe(false);
  await f.c.act(A, "approve");
  await f.c.recover(A);
  await wait();
  expect(f.calls.length).toBe(1);
  expect(f.c.snapshot().selectedId).toBe(B);
});
test("unknown save keeps its draft frozen until receipt and fresh view reconcile", async () => {
  const f = fixture("uncertain");
  await f.c.refresh();
  f.c.edit(A);
  const before = f.c.snapshot().draft;
  await f.c.act(A, "save");
  f.c.cancelEdit();
  expect(f.c.snapshot().draft).toEqual(before);
  await f.c.recover(A);
  await wait();
  expect(f.c.snapshot().draft).toBeNull();
  expect(f.c.canAct(A, "approve")).toBe(true);
});
test("definitive refusal needs explicit refresh, unlike an unknown transport result", async () => {
  const f = fixture("refused");
  await f.c.refresh();
  await f.c.act(A, "approve");
  expect(f.c.snapshot().attempts.get(A)!.state).toBe("refused");
  expect(f.c.canAct(A, "approve")).toBe(false);
  await f.c.refresh();
  expect(f.c.canAct(A, "approve")).toBe(true);
});
test("all receipt correlations are required; execution is not a document receipt", () => {
  const request: DocumentRequest = {
    decisionId: A,
    revision: "v1",
    requestId: "request",
    action: "approve",
  };
  const receipt: DocumentReceipt = {
    decisionId: A,
    requestId: "request",
    approvalId: "approval",
    revision: "v2",
    generation: 2,
    decidedAt: 1,
    executed: false,
    outcome: "permission_granted",
  };
  expect(matchesReceipt(request, receipt)).toBe(true);
  for (const bad of [
    { requestId: "other" },
    { decisionId: B },
    { outcome: "rejected" },
    { executed: true },
    { generation: NaN },
    { approvalId: "" },
    { revision: "" },
    { decidedAt: NaN },
  ])
    expect(
      matchesReceipt(request, { ...receipt, ...bad } as DocumentReceipt),
    ).toBe(false);
});
test("mismatched receipt cannot advance or unlock a decision", async () => {
  const f = fixture();
  const c = owner({
    ...f.port,
    act: async (request) => ({
      ...(await f.port.act(request)),
      requestId: "wrong",
    }),
  });
  await c.refresh();
  await c.act(A, "approve");
  await wait();
  expect(c.snapshot().selectedId).toBe(A);
  expect(c.snapshot().attempts.get(A)!.state).toBe("unknown");
});
test("late reads cannot replace a newer refresh", async () => {
  let finish!: (value: DecisionCollection) => void;
  let n = 0;
  const f = fixture();
  const c = owner({
    ...f.port,
    read: () =>
      ++n === 1
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve({ status: "empty" }),
  });
  const old = c.refresh();
  await c.refresh();
  finish({ status: "ready", data: [decisionFixture()] });
  await old;
  expect(c.snapshot().rows).toEqual([]);
});
test("scope revocation and retirement prevent mutation and stale repaint", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.setAccess(false);
  await f.c.act(A, "approve");
  expect(f.calls.length).toBe(0);
  f.c.setAccess(true);
  f.c.retire();
  await f.c.act(A, "approve");
  expect(f.calls.length).toBe(0);
});
test("concurrent press cannot create a second in-flight decision", async () => {
  const f = makeDecisionsFixture("ready", 5);
  const c = owner(f.port);
  await c.refresh();
  const pending = c.act(A, "approve");
  c.select(B);
  await c.act(B, "approve");
  await pending;
  await wait();
  expect(f.calls.length).toBe(1);
  expect(c.snapshot().selectedId).toBe(B);
});
test("retained rejected blocker is not fabricated away", async () => {
  const item = decisionFixture();
  const f = fixture();
  const c = owner({
    ...f.port,
    read: async () => ({ status: "ready", data: [item] }),
    act: async (request) => {
      item.paper.decision.revision = "v2";
      item.generation = 2;
      item.actions = [];
      item.reason = "Workflow remains blocked.";
      item.paper.decision.approval!.status = "denied";
      return {
        decisionId: A,
        requestId: request.requestId,
        approvalId: item.paper.decision.approval!.approvalId,
        revision: "v2",
        generation: 2,
        decidedAt: 1,
        executed: false,
        outcome: "rejected",
      };
    },
  });
  await c.refresh();
  await c.act(A, "reject");
  await wait();
  expect(c.snapshot().rows.length).toBe(1);
  expect(c.canAct(A, "approve")).toBe(false);
});
test("calendar changes preserve readonly options and validate timezones", async () => {
  const f = fixture("calendar");
  await f.c.refresh();
  f.c.edit(A);
  const doc = f.c.snapshot().draft!.document;
  expect(doc.kind).toBe("calendar");
  if (doc.kind !== "calendar") return;
  expect(documentError({ ...doc, end: doc.start })).toContain("end");
  expect(
    documentError({ ...doc, start: "2026-02-30T12:00:00Z" }),
  ).not.toBeNull();
  expect(
    documentError({ ...doc, start: "2026-10-09T10:00:00" }),
  ).not.toBeNull();
  f.c.change({ ...doc, title: "Pilot kickoff confirmed" });
  await f.c.act(A, "save");
  await wait();
  expect(f.c.snapshot().rows[0]!.options.length).toBe(2);
});
