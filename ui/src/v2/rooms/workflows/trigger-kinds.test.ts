import { describe, expect, test } from "bun:test";
import {
  TRIGGER_KINDS,
  detectTriggerKind,
  makeEmptyStash,
  transitionTriggerKind,
  type TriggerKindStash,
} from "./trigger-kinds";
import type { FlowStepNode } from "./useWorkflowEditor";

/* ----------------------------------------------------------------- helpers */

function empty(name: string): FlowStepNode {
  return { name, type: "EMPTY", displayName: name, settings: {} } as unknown as FlowStepNode;
}

function pieceTrigger(name: string, pieceName: string, triggerName?: string, input: Record<string, unknown> = {}): FlowStepNode {
  const settings: Record<string, unknown> = { pieceName, input };
  if (triggerName) settings.triggerName = triggerName;
  return { name, type: "PIECE_TRIGGER", displayName: name, settings } as unknown as FlowStepNode;
}

/* ----------------------------------------------------------- detectTriggerKind */

describe("detectTriggerKind", () => {
  test("EMPTY trigger -> manual", () => {
    expect(detectTriggerKind(empty("t"))).toBe("manual");
  });

  test("schedule pieceName -> schedule", () => {
    expect(detectTriggerKind(pieceTrigger("t", "schedule"))).toBe("schedule");
  });

  test("webhook pieceName -> webhook", () => {
    expect(detectTriggerKind(pieceTrigger("t", "webhook"))).toBe("webhook");
  });

  test("jarvis-trigger pieceName -> event", () => {
    expect(detectTriggerKind(pieceTrigger("t", "@jarvispieces/piece-jarvis-trigger", "on_event"))).toBe("event");
  });

  test("community pieceName -> other (NOT manual -- otherwise the picker would silently overwrite)", () => {
    expect(detectTriggerKind(pieceTrigger("t", "@activepieces/piece-gmail", "new_email"))).toBe("other");
  });

  test("PIECE_TRIGGER with missing pieceName -> other", () => {
    const step = { name: "t", type: "PIECE_TRIGGER", settings: {} } as unknown as FlowStepNode;
    expect(detectTriggerKind(step)).toBe("other");
  });
});

/* ----------------------------------------------------- transitionTriggerKind */

describe("transitionTriggerKind", () => {
  // Picker-table assertions: anchor the (kind, pieceName, triggerName) mapping
  // so a typo on either entry surfaces in this file.
  test("TRIGGER_KINDS table contains exactly the four canonical kinds in presentation order", () => {
    expect(TRIGGER_KINDS.map((tk) => tk.kind)).toEqual(["manual", "schedule", "webhook", "event"]);
    expect(TRIGGER_KINDS.find((tk) => tk.kind === "event")?.pieceName).toBe("@jarvispieces/piece-jarvis-trigger");
    expect(TRIGGER_KINDS.find((tk) => tk.kind === "event")?.triggerName).toBe("on_event");
  });

  describe("manual <-> kind round-trip restores prior config", () => {
    test("schedule -> manual -> schedule restores the cron", () => {
      const scheduleSettings = { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } };
      const stash0 = makeEmptyStash();
      // schedule -> manual
      const r1 = transitionTriggerKind("schedule", scheduleSettings, "manual", stash0);
      expect(r1.type).toBe("EMPTY");
      expect(r1.settings).toEqual({});
      expect(r1.nextStash.schedule?.input?.cron_expression).toBe("0 9 * * *");
      // manual -> schedule: stash for schedule pops out and is restored.
      const r2 = transitionTriggerKind("manual", r1.settings, "schedule", r1.nextStash);
      expect(r2.type).toBe("PIECE_TRIGGER");
      expect(r2.settings?.pieceName).toBe("schedule");
      expect(r2.settings?.input?.cron_expression).toBe("0 9 * * *");
      // Stash slot for schedule is cleared after restore (consumed).
      expect(r2.nextStash.schedule).toBeUndefined();
    });
  });

  describe("kind -> kind transitions stash the outgoing kind so nothing is lost on a click", () => {
    test("schedule -> webhook stashes the schedule cron; coming back restores it", () => {
      const scheduleSettings = { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } };
      const r1 = transitionTriggerKind("schedule", scheduleSettings, "webhook", makeEmptyStash());
      // Webhook starts fresh.
      expect(r1.settings?.pieceName).toBe("webhook");
      expect(r1.settings?.input).toEqual({});
      // Schedule config is preserved in the stash for a future return trip.
      expect(r1.nextStash.schedule?.input?.cron_expression).toBe("0 9 * * *");
      // schedule -> webhook -> schedule: the schedule cron comes back, NOT a fresh empty input.
      const webhookSettings = r1.settings;
      const r2 = transitionTriggerKind("webhook", webhookSettings, "schedule", r1.nextStash);
      expect(r2.settings?.pieceName).toBe("schedule");
      expect(r2.settings?.input?.cron_expression).toBe("0 9 * * *");
    });

    test("schedule -> manual -> event keeps the schedule recoverable via a future schedule click", () => {
      const scheduleSettings = { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } };
      const r1 = transitionTriggerKind("schedule", scheduleSettings, "manual", makeEmptyStash());
      const r2 = transitionTriggerKind("manual", r1.settings, "event", r1.nextStash);
      // Event starts fresh with the canonical jarvis-trigger pieceName.
      expect(r2.settings?.pieceName).toBe("@jarvispieces/piece-jarvis-trigger");
      expect(r2.settings?.triggerName).toBe("on_event");
      // Schedule stash survives the manual-detour: a later click can still restore the cron.
      expect(r2.nextStash.schedule?.input?.cron_expression).toBe("0 9 * * *");
      const r3 = transitionTriggerKind("event", r2.settings, "schedule", r2.nextStash);
      expect(r3.settings?.input?.cron_expression).toBe("0 9 * * *");
    });

    test("event -> event is a no-op-ish (fresh settings only because stash is empty)", () => {
      const eventSettings = { pieceName: "@jarvispieces/piece-jarvis-trigger", triggerName: "on_event", input: { eventType: "observer.clipboard_changed" } };
      const r = transitionTriggerKind("event", eventSettings, "event", makeEmptyStash());
      // No incoming stash + outgoing same kind = the transition resets to fresh.
      // (This is a slightly weird corner; the picker UI never fires self-transitions
      // since clicking the active button is a no-op in the UI's click handler.)
      expect(r.settings?.pieceName).toBe("@jarvispieces/piece-jarvis-trigger");
      expect(r.settings?.input).toEqual({});
    });
  });

  describe("non-canonical (other) outgoing triggers do NOT pollute the stash", () => {
    test("other -> schedule starts fresh; the community piece's settings are dropped (the user opted in by clicking)", () => {
      const communitySettings = { pieceName: "@activepieces/piece-gmail", triggerName: "new_email", input: { auth: "{{connections.x}}" } };
      const r = transitionTriggerKind("other", communitySettings, "schedule", makeEmptyStash());
      expect(r.settings?.pieceName).toBe("schedule");
      // Stash stays empty for every canonical kind -- we can't safely
      // restore a community-piece trigger by canonical kind.
      expect(r.nextStash.schedule).toBeUndefined();
      expect(r.nextStash.event).toBeUndefined();
    });
  });

  describe("empty / trivial settings are not snapshotted (would silently displace a real prior stash)", () => {
    test("fresh schedule pick that hasn't been configured -> webhook leaves the stash slot untouched", () => {
      // Simulate: user picked Schedule from Manual (fresh settings, no cron yet),
      // then immediately clicked Webhook. The schedule stash slot should NOT
      // store an empty placeholder.
      const prior: TriggerKindStash = { ...makeEmptyStash(), webhook: { pieceName: "webhook", input: { secret: "shh" } } };
      const justPickedSchedule = { pieceName: "schedule", input: {} };
      const r = transitionTriggerKind("schedule", justPickedSchedule, "webhook", prior);
      // Webhook stash gets restored.
      expect(r.settings?.input?.secret).toBe("shh");
      // Schedule's empty placeholder did NOT overwrite anything (it
      // started undefined and stays that way).
      expect(r.nextStash.schedule).toBeUndefined();
    });
  });
});
