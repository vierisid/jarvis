import { afterEach, expect, test } from "bun:test";
import { OpportunitiesController } from "./controller";
import {
  finishedFixtures,
  fixtureReceipt,
  makeOpportunitiesFixture,
} from "./fixtures";
import {
  approvalBlock,
  matchesReceipt,
  type ActionReceipt,
  type OpportunitiesPort,
  type OpportunityCollection,
} from "./model";
const owners: OpportunitiesController[] = [];
const pause = () => new Promise((r) => setTimeout(r, 18));
const deferred = <T>() => {
  let resolve!: (x: T) => void, reject!: (x: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
function owner(port: OpportunitiesPort) {
  const c = new OpportunitiesController("fixture", "test", port, {
    acknowledge: 1,
    dismiss: 1,
    exit: 1,
    enter: 1,
  });
  c.setAccess(true);
  owners.push(c);
  return c;
}
function fixture() {
  const f = makeOpportunitiesFixture();
  const c = owner(f.port);
  return { ...f, c };
}
function threeProposals(example: "ready" | "registration pending" = "ready") {
  const f = makeOpportunitiesFixture(example);
  const third = structuredClone(f.records[1]!);
  third.proposal.proposalId = "fixture-proposal-2";
  f.records.push(third);
  return { ...f, c: owner(f.port) };
}
afterEach(() => {
  owners.splice(0).forEach((c) => c.retire());
});
test("a definitive refusal can be retried only after a fresh read, unlike uncertainty", async () => {
  const f = makeOpportunitiesFixture("refused"),
    c = owner(f.port);
  await c.refresh();
  await c.act("fixture-proposal-0", "approve");
  expect(c.snapshot().attempts.get("fixture-proposal-0")!.state).toBe(
    "refused",
  );
  expect(c.canAct("fixture-proposal-0", "approve")).toBe(false);
  await c.recover("fixture-proposal-0");
  expect(f.stats().recoveries).toBe(0);
  await c.refresh();
  expect(c.canAct("fixture-proposal-0", "approve")).toBe(true);
  await c.act("fixture-proposal-0", "approve");
  expect(f.calls.length).toBe(2);
  expect(f.calls[0]!.idempotencyKey).not.toBe(f.calls[1]!.idempotencyKey);
});
test("selection survives reorder and refresh, uses IDs rather than indexes", async () => {
  const f = fixture();
  await f.c.refresh();
  f.c.select("fixture-proposal-1");
  f.reorder();
  await f.c.refresh();
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-1");
  expect(f.c.snapshot().rows[0]!.proposal.proposalId).toBe(
    "fixture-proposal-1",
  );
});
test("a new revision replaces list and brief together; missing selection chooses a real remaining row", async () => {
  const f = fixture();
  await f.c.refresh();
  f.records[0]!.proposal.revision = "new";
  await f.c.refresh();
  expect(f.c.snapshot().rows[0]!.proposal.revision).toBe("new");
  f.records.shift();
  await f.c.refresh();
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-1");
});
test("approval acknowledges the same item before settling the next and advances once", async () => {
  const f = fixture();
  await f.c.refresh();
  await f.c.act("fixture-proposal-0", "approve");
  expect(f.c.snapshot().phase).toBe("acknowledge");
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-0");
  expect(f.c.snapshot().message).toContain("Workflow enabled");
  await f.c.act("fixture-proposal-0", "approve");
  await pause();
  expect(f.calls.length).toBe(1);
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-1");
  await f.c.refresh();
  expect(f.c.snapshot().rows.length).toBe(1);
});
test("dismissal has a distinct receipt and leaves no saved/dismissed destination", async () => {
  const f = fixture();
  await f.c.refresh();
  await f.c.act("fixture-proposal-0", "dismiss");
  expect(f.c.snapshot().message).toContain("No workflow enabled");
  await pause();
  await f.c.act("fixture-proposal-1", "dismiss");
  await pause();
  expect(f.c.snapshot().rows).toEqual([]);
  expect(f.c.snapshot().selectedId).toBeNull();
});
test.each(["approve", "dismiss"] as const)(
  "R1: refresh during %s acknowledgement retains the slot and advances to the original successor",
  async (decision) => {
    const f = threeProposals();
    await f.c.refresh();
    await f.c.act("fixture-proposal-0", decision);
    await f.c.refresh();
    expect(f.c.snapshot().rows.map((x) => x.proposal.proposalId)).toEqual([
      "fixture-proposal-0",
      "fixture-proposal-1",
      "fixture-proposal-2",
    ]);
    await pause();
    expect(f.c.snapshot().selectedId).toBe("fixture-proposal-1");
    expect(f.calls.length).toBe(1);
  },
);
test("R1: pending registration keeps its slot through reorder and recovers the original next identity", async () => {
  const f = threeProposals("registration pending");
  await f.c.refresh();
  await f.c.act("fixture-proposal-0", "approve");
  f.reorder();
  await f.c.refresh();
  expect(f.c.snapshot().rows.map((x) => x.proposal.proposalId)).toEqual([
    "fixture-proposal-0",
    "fixture-proposal-2",
    "fixture-proposal-1",
  ]);
  f.receipts.get("fixture-proposal-0")!.registration.state = "registered";
  await f.c.recover("fixture-proposal-0");
  await pause();
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-1");
  expect(f.calls.length).toBe(1);
});
test("R1: a vanished successor is skipped and a newer user selection wins", async () => {
  const f = threeProposals("registration pending");
  await f.c.refresh();
  await f.c.act("fixture-proposal-0", "approve");
  f.records.splice(1, 1);
  await f.c.refresh();
  f.receipts.get("fixture-proposal-0")!.registration.state = "registered";
  await f.c.recover("fixture-proposal-0");
  await pause();
  expect(f.c.snapshot().selectedId).toBe("fixture-proposal-2");
  const other = threeProposals("registration pending");
  await other.c.refresh();
  await other.c.act("fixture-proposal-0", "approve");
  await other.c.refresh();
  other.c.select("fixture-proposal-2");
  other.receipts.get("fixture-proposal-0")!.registration.state = "registered";
  await other.c.recover("fixture-proposal-0");
  await pause();
  expect(other.c.snapshot().selectedId).toBe("fixture-proposal-2");
});
test("duplicate intent is locked synchronously, including opposite actions", async () => {
  const f = makeOpportunitiesFixture("ready", 20),
    c = owner(f.port);
  await c.refresh();
  const p = c.act("fixture-proposal-0", "approve");
  void c.act("fixture-proposal-0", "dismiss");
  void c.act("fixture-proposal-0", "approve");
  await p;
  expect(f.calls.length).toBe(1);
  expect(f.calls[0]!.revision).toBe("revision-1");
});
test("pending registration is approval saved, not enabled; refresh retains it for recovery", async () => {
  const f = makeOpportunitiesFixture("registration pending"),
    c = owner(f.port);
  await c.refresh();
  await c.act("fixture-proposal-0", "approve");
  await pause();
  await c.refresh();
  expect(c.snapshot().selectedId).toBe("fixture-proposal-0");
  expect(c.snapshot().rows.length).toBe(2);
  expect(c.snapshot().phase).toBe("rest");
  expect(c.canAct("fixture-proposal-0", "approve")).toBe(false);
  f.receipts.get("fixture-proposal-0")!.registration.state = "registered";
  await c.recover("fixture-proposal-0");
  await pause();
  expect(c.snapshot().rows.length).toBe(1);
  expect(f.calls.length).toBe(1);
});
test.each(["blocked", "pending"] as const)(
  "%s registration and later paused workflow are never a successful enable",
  async (registration) => {
    const f = fixture();
    const c = owner({
      ...f.port,
      act: async (r) => ({
        ...fixtureReceipt(r, f.records[0]!),
        registration: { state: registration, message: null },
        currentActivation: "paused",
      }),
    });
    await c.refresh();
    await c.act("fixture-proposal-0", "approve");
    await pause();
    expect(c.snapshot().rows.length).toBe(2);
    expect(
      c.snapshot().attempts.get("fixture-proposal-0")!.receipt!
        .currentActivation,
    ).toBe("paused");
  },
);
test("lost response keeps the original identity locked; recovery is read-only", async () => {
  const f = makeOpportunitiesFixture("lost response"),
    c = owner(f.port);
  await c.refresh();
  await c.act("fixture-proposal-0", "approve");
  await c.refresh();
  expect(c.snapshot().attempts.get("fixture-proposal-0")!.state).toBe(
    "unknown",
  );
  expect(
    c
      .snapshot()
      .rows.some((x) => x.proposal.proposalId === "fixture-proposal-0"),
  ).toBe(true);
  await c.act("fixture-proposal-0", "dismiss");
  await c.recover("fixture-proposal-0");
  await pause();
  expect(f.calls.length).toBe(1);
  expect(f.stats().recoveries).toBe(1);
  expect(c.snapshot().rows.length).toBe(1);
});
test("null recovery leaves unknown locked and does not resend", async () => {
  const f = fixture(),
    c = owner({
      ...f.port,
      act: async () => {
        throw Error();
      },
      recover: async () => null,
    });
  await c.refresh();
  await c.act("fixture-proposal-0", "approve");
  await c.recover("fixture-proposal-0");
  expect(c.canAct("fixture-proposal-0", "dismiss")).toBe(false);
  expect(c.snapshot().rows.length).toBe(2);
});
test("older and mismatched recovery receipts cannot replace an acknowledged result", async () => {
  const f = fixture();
  let next: ActionReceipt | null = null;
  const c = owner({
    ...f.port,
    act: async (r) => {
      next = {
        ...fixtureReceipt(r, f.records[0]!),
        registration: { state: "pending", message: null },
        updatedAt: 300,
      };
      return next;
    },
    recover: async () => next,
  });
  await c.refresh();
  await c.act("fixture-proposal-0", "approve");
  next = {
    ...next!,
    updatedAt: 100,
    registration: { state: "registered", message: null },
  };
  await c.recover("fixture-proposal-0");
  await pause();
  expect(c.snapshot().rows.length).toBe(2);
  expect(
    c.snapshot().attempts.get("fixture-proposal-0")!.receipt!.updatedAt,
  ).toBe(300);
  next = { ...next!, revision: "wrong", updatedAt: 400 };
  await c.recover("fixture-proposal-0");
  expect(
    c.snapshot().attempts.get("fixture-proposal-0")!.receipt!.revision,
  ).toBe("revision-1");
});
test("a decision response cannot steal a newer user selection", async () => {
  const f = makeOpportunitiesFixture("ready", 10),
    c = owner(f.port);
  await c.refresh();
  const p = c.act("fixture-proposal-0", "approve");
  c.select("fixture-proposal-1");
  await p;
  await pause();
  expect(c.snapshot().selectedId).toBe("fixture-proposal-1");
  expect(c.snapshot().phase).toBe("rest");
});
test("out-of-order refresh and retired owners ignore late responses", async () => {
  const a = deferred<OpportunityCollection>(),
    b = deferred<OpportunityCollection>();
  const f = fixture();
  let n = 0;
  const c = owner({
    ...f.port,
    read: () => (++n === 1 ? a.promise : b.promise),
  });
  const first = c.refresh(),
    second = c.refresh();
  b.resolve({ status: "ready", data: [f.records[1]!] });
  await second;
  a.resolve({ status: "ready", data: f.records });
  await first;
  expect(c.snapshot().rows.length).toBe(1);
  const reply = deferred<ActionReceipt>(),
    d = owner({ ...f.port, act: () => reply.promise });
  await d.refresh();
  const pending = d.act("fixture-proposal-0", "approve");
  const snapshot = d.snapshot();
  d.retire();
  reply.resolve(
    fixtureReceipt(
      snapshot.attempts.get("fixture-proposal-0")!.request,
      f.records[0]!,
    ),
  );
  await pending;
  expect(d.snapshot()).toBe(snapshot);
});
test.each(["stale", "unavailable", "unsupported", "loading", "empty"] as const)(
  "%s remains a distinct read state with no actions",
  async (example) => {
    const f = makeOpportunitiesFixture(example),
      c = owner(f.port);
    await c.refresh();
    expect(c.snapshot().read.status).toBe(example);
    expect(c.canAct("fixture-proposal-0", "approve")).toBe(false);
  },
);
test("read failure preserves visible data as stale, and access revocation prevents dispatch", async () => {
  const f = fixture();
  let fail = false;
  const c = owner({
    ...f.port,
    read: () => {
      if (fail) throw Error();
      return f.port.read();
    },
  });
  await c.refresh();
  fail = true;
  await c.refresh();
  expect(c.snapshot().read.status).toBe("stale");
  expect(c.snapshot().rows.length).toBe(2);
  c.setAccess(false);
  await c.act("fixture-proposal-0", "approve");
  expect(f.calls.length).toBe(0);
});
test("read-only capability permits browsing but no decisions", async () => {
  const f = fixture();
  f.c.setAccess(true, false);
  await f.c.refresh();
  await f.c.act("fixture-proposal-0", "dismiss");
  expect(f.calls).toEqual([]);
  expect(f.c.snapshot().rows.length).toBe(2);
});
test("revoking access during refresh cannot strand the restored room in refreshing", async () => {
  const f = fixture(),
    read = deferred<OpportunityCollection>();
  let slow = false;
  const c = owner({
    ...f.port,
    read: () => (slow ? read.promise : f.port.read()),
  });
  await c.refresh();
  slow = true;
  const pending = c.refresh();
  c.setAccess(false);
  expect(c.snapshot().refreshing).toBe(false);
  read.resolve({ status: "empty" });
  await pending;
  c.setAccess(true);
  slow = false;
  await c.refresh();
  expect(c.snapshot().rows.length).toBe(2);
  expect(c.snapshot().refreshing).toBe(false);
});
test("legacy draft-ready, blocked binding and canApprove=false never become ready", () => {
  const item = finishedFixtures()[0]!;
  expect(approvalBlock(item)).toBeNull();
  item.proposal.workflow!.versionState = "DRAFT";
  expect(approvalBlock(item)).not.toBeNull();
  item.proposal.workflow!.versionState = "LOCKED";
  item.canApprove = false;
  expect(approvalBlock(item)).not.toBeNull();
  item.canApprove = true;
  item.proposal.bindings[0]!.availability = "unavailable";
  expect(approvalBlock(item)).not.toBeNull();
});
test.each([
  "proposalId",
  "revision",
  "decision",
  "workflow",
  "receiptId",
] as const)("receipt guard rejects mismatched %s", (key) => {
  const item = finishedFixtures()[0]!,
    request = {
      proposalId: item.proposal.proposalId,
      revision: item.proposal.revision,
      decision: "approve" as const,
      idempotencyKey: "key",
    };
  const receipt = fixtureReceipt(request, item);
  const wrong = {
    ...receipt,
    [key]:
      key === "workflow"
        ? { ...receipt.workflow, versionId: "wrong" }
        : key === "receiptId"
          ? ""
          : "wrong",
  };
  expect(matchesReceipt(request, item, wrong as ActionReceipt)).toBe(false);
});
