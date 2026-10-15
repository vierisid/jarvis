import { AsyncLocalStorage } from 'node:async_hooks';

/** Evidence at the time of the call, not proof of a downstream business effect. */
export type ActionVerification =
  | { status: 'verified'; postcondition: 'page_observed'; pageUrl: string; documentId: string }
  | { status: 'verified'; postcondition: 'window_visible'; pid: number }
  | { status: 'unverified'; reason: 'no_supported_postcondition' | 'page_identity_missing' | 'window_visibility_unknown' };

const observations = new AsyncLocalStorage<{ toolName: string; verification: ActionVerification }>();

/** Each durable effect owns its observation. Nested tools cannot certify their caller. */
export async function collectActionVerification<T>(toolName: string, category: string, execute: () => Promise<T>): Promise<{ result: T; verification?: ActionVerification }> {
  if (category !== 'desktop' && category !== 'browser') return { result: await execute() };
  const observation = { toolName, verification: { status: 'unverified', reason: 'no_supported_postcondition' } as ActionVerification };
  return observations.run(observation, async () => ({ result: await execute(), verification: observation.verification }));
}

/** Called only by trusted adapters while they still hold the structural reply. */
export function recordActionVerification(toolName: string, verification: ActionVerification): void {
  const observation = observations.getStore();
  if (observation?.toolName === toolName) observation.verification = verification;
}

export function observedPage(pageUrl: unknown, documentId: unknown): ActionVerification {
  if (typeof pageUrl === 'string' && pageUrl.length > 0 && pageUrl.length <= 8192
    && typeof documentId === 'string' && documentId.length > 0 && documentId.length <= 4096) {
    return { status: 'verified', postcondition: 'page_observed', pageUrl, documentId };
  }
  return { status: 'unverified', reason: 'page_identity_missing' };
}

export function observedWindow(reply: unknown): ActionVerification {
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) {
    const r = reply as Record<string, unknown>;
    if (r.success === true && r.window_visible === true && Number.isSafeInteger(r.pid) && (r.pid as number) > 0) {
      return { status: 'verified', postcondition: 'window_visible', pid: r.pid as number };
    }
  }
  return { status: 'unverified', reason: 'window_visibility_unknown' };
}

export const hasUiVerificationScope = () => observations.getStore() !== undefined;

/** No page-controlled text in the human receipt label. */
export function verificationSummary(verification: ActionVerification): string {
  return verification.status === 'verified'
    ? `[UI verification: ${verification.postcondition}; downstream business effects unverified]`
    : '[UI verification: unverified; inspect the current state before continuing or repeating the action]';
}
