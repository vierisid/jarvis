import { ActionOutcomeError, isActionOutcome, type ActionOutcome } from '../../../../../../../../../actions/action-outcome';

interface NotifyResponse {
  delivered: string[];
  failed: { channel: string; error: string }[];
  unknown: { channel: string; error: string }[];
  approval?: { effectId: string; approvalId: string; waitpointId: string };
  outcome?: ActionOutcome;
}

export interface NotifyContext {
  propsValue: Record<string, unknown>;
  server: { apiUrl: string; token: string };
  step: { name: string; executionPath?: unknown };
  run: { waitForWaitpoint: (id: string) => unknown };
}

/** Shared by the real piece and isolated mocked transport fixtures. */
export async function sendNotification(context: NotifyContext): Promise<NotifyResponse> {
    const url = trimSlash(context.server.apiUrl) + "/v1/jarvis/notify";
    const message = context.propsValue["message"];
    if (typeof message !== "string" || message.length === 0) {
      throw new Error("jarvis-notify: message is required and must be a non-empty string");
    }
    const body: Record<string, unknown> = { message };
    if (context.propsValue.meetingGuard != null) body.meetingGuard = context.propsValue.meetingGuard;
    const identity = context.propsValue['idempotencyKey'];
    if (identity !== undefined && identity !== null) body.idempotencyKey = identity;
    const channels = context.propsValue["channels"];
    if (Array.isArray(channels) && channels.length > 0) body["channels"] = channels;
    const priority = context.propsValue["priority"];
    if (typeof priority === "string" && priority.length > 0) body["priority"] = priority;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.server.token}`,
        'X-Jarvis-Step-Name': context.step.name,
        'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      let outcome: unknown;
      try { outcome = (JSON.parse(text) as NotifyResponse).outcome; } catch { /* not a typed reply */ }
      // A typed outcome (nothing sent anywhere, or a refused effect) fails the
      // step with its code and message intact.
      if (isActionOutcome(outcome) && outcome.status !== 'succeeded') throw new ActionOutcomeError(outcome);
      throw new Error(
        `jarvis-notify: daemon responded ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    const reply = (await response.json()) as NotifyResponse;
    if (reply.approval) context.run.waitForWaitpoint(reply.approval.waitpointId);
    return reply;
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
