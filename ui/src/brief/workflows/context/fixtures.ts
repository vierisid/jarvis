import { WorkflowContextController } from "./controller";
import { RUN_SCOPE, makeRunsFixture } from "../runs/fixtures";
import {
  GROUPS,
  type ContextDocument,
  type ContextEntry,
  type ContextGroup,
  type ContextQuery,
  type WorkflowContextPort,
} from "./model";
export type ContextExample =
  | "normal"
  | "missing"
  | "partial"
  | "unavailable"
  | "unsupported"
  | "empty"
  | "long"
  | "slow";
const entry = (
  id: string,
  label: string,
  value: string,
  kind: NonNullable<ContextEntry["source"]>["kind"],
  availability: ContextEntry["availability"] = "available",
): ContextEntry => ({ id, label, value, availability, source: { kind, id } });
export function makeContextFixture(runs = makeRunsFixture()) {
  let mode: ContextExample = "normal",
    reads = 0;
  const port: WorkflowContextPort = {
    async read(scope, q, _signal) {
      reads++;
      const requestedMode = mode;
      if (requestedMode === "slow")
        await new Promise((r) =>
          setTimeout(r, q.basis === "configured" ? 800 : 150),
        );
      if (requestedMode === "empty") return { status: "empty" };
      if (requestedMode === "unsupported" || requestedMode === "unavailable")
        return { status: requestedMode, reason: "Fixture availability" };
      const recorded = q.basis === "recorded",
        run = recorded ? runs.records.get(q.runId) : null;
      if (recorded && !run)
        return { status: "unavailable", reason: "Run not found" };
      if (run?.status === "queued") return { status: "empty" };
      const historical = run?.versionId === "meeting-v2";
      const rows: Record<ContextGroup, ContextEntry[]> = {
        goal: [
          entry(
            historical ? "goal-first-pilots" : "goal-design-partners",
            historical ? "Start three pilots" : "Win 10 design partners",
            historical
              ? "Scope the first pilot together."
              : "Turn promising calls into an agreed pilot.",
            "goal",
          ),
        ],
        memory: [
          entry(
            recorded ? "fact-alex-meeting" : "step-meeting-notes",
            "Meeting notes",
            recorded
              ? "Alex asked to confirm the pilot date before the next call."
              : "Read the notes from the meeting that triggers the workflow.",
            recorded ? "fact" : "step",
          ),
          entry(
            historical ? "fact-old-preferences" : "fact-email-preferences",
            "Email preferences",
            historical
              ? "Earlier email preferences are no longer available."
              : recorded
                ? "Concise emails, with scope and next date stated."
                : "Your tone, sign-off and preferred pilot structure.",
            "fact",
            historical ? "removed" : "available",
          ),
        ],
        bindings: [
          entry(
            "connection-calendar",
            "Google Calendar",
            "Vieri’s calendar",
            "connection",
          ),
          entry(
            "connection-gmail",
            "Gmail",
            "vieri@example.test",
            "connection",
          ),
        ],
        target: [
          entry(
            "device-desktop",
            "Jarvis desktop",
            recorded
              ? "This run was assigned to the paired desktop."
              : "Desktop actions use the paired computer.",
            "device",
          ),
        ],
        rules: [
          entry(
            "rule-email-review",
            "Ask before sending",
            recorded
              ? "The email step requested your approval."
              : "Sending an email requires your approval.",
            "rule",
          ),
          entry(
            "step-draft",
            "Use confirmed details",
            "Flag an unconfirmed date before preparing the follow-up.",
            "step",
          ),
          entry(
            "meeting",
            "Code steps",
            "Not permitted for this workflow.",
            "workflow",
          ),
        ],
      };
      if (requestedMode === "missing") {
        rows.goal[0]!.availability = "missing";
        rows.memory[1]!.availability = "removed";
        rows.bindings[1]!.availability = "stale";
        rows.bindings[1]!.value = "Reconnect before the next run.";
        rows.target[0]!.availability = "missing";
      }
      if (requestedMode === "long") {
        rows.memory[0]!.value =
          "A confirmed preference with an unusually long context value, retained without truncation. ".repeat(
            18,
          );
        rows.bindings[1]!.value =
          "very.long.founder.account.for.design.partners.and.investor.updates@example.test";
        rows.target[0]!.source!.id =
          "device-" + "long-source-identifier-".repeat(8);
      }
      const groups = Object.fromEntries(
        GROUPS.map((g) => [g, { status: "ready", data: rows[g] }]),
      ) as ContextDocument["groups"];
      if (requestedMode === "partial") {
        groups.memory = {
          status: "unavailable",
          reason: "Missing recorded evidence",
        };
        groups.bindings = {
          status: "stale",
          data: rows.bindings,
          reason: "Check connections",
        };
      }
      return {
        status: "ready",
        data: {
          scopeId: scope.scopeId,
          flowId: scope.flowId,
          versionId: run?.versionId ?? scope.versionId,
          basis: q.basis,
          runId: run?.runId ?? null,
          runLabel: run?.label ?? null,
          asOf: 1791356400000,
          groups,
        },
      };
    },
  };
  const controller = new WorkflowContextController(RUN_SCOPE, port);
  return {
    controller,
    port,
    runs,
    setMode(value: ContextExample) {
      mode = value;
    },
    stats: () => ({ reads }),
  };
}
