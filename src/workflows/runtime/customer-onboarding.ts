/** Independent resource creation with persistent, per-customer branch outcomes. */
import { digest } from './effect-context';

export const ONBOARDING_PIECE = '@jarvispieces/piece-jarvis-onboarding';
export const ONBOARDING_ACTION = 'create_resources';
export const ONBOARDING_ACCOUNTS = { clickupConnection: '@activepieces/piece-clickup', driveConnection: '@activepieces/piece-google-drive' } as const;
export const ONBOARDING_REQUIRED = ['clickupConnection', 'driveConnection', 'clickupListId', 'driveParentId', 'customerIdPath', 'customerNamePath'] as const;
export type OnboardingSetup = Record<typeof ONBOARDING_REQUIRED[number], string>;
export type ResourceBranch = 'clickup' | 'drive';
export type ResourceOutcome = { status: 'succeeded' | 'failed' | 'unknown'; id?: string; url?: string; detail: string };
export type ResourceState = ResourceOutcome | { status: 'dispatching' };
export interface OnboardingStore {
  check(): void;
  read(branch: ResourceBranch): ResourceState | undefined;
  save(branch: ResourceBranch, result: ResourceState): void;
}
export type ResourceCreate = (branch: ResourceBranch, dispatching: () => void) => Promise<ResourceOutcome>;
const pathPattern = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;
export function onboardingSetup(input: Record<string, unknown>): OnboardingSetup {
  const setup = {} as OnboardingSetup;
  for (const field of ONBOARDING_REQUIRED) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw Error(`Setup required: ${field}`);
    setup[field] = value.trim();
  }
  for (const field of ['customerIdPath', 'customerNamePath'] as const) {
    if (!pathPattern.test(setup[field]) || setup[field].split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) throw Error(`Invalid customer mapping: ${field}`);
  }
  for (const field of ['clickupConnection', 'driveConnection'] as const) if (!/^[\w:-]+$/.test(setup[field])) throw Error('Select a saved account reference');
  if (!/^\d+$/.test(setup.clickupListId) || !/^[\w-]+$/.test(setup.driveParentId)) throw Error('Select the actual ClickUp list and Drive parent folder');
  return setup;
}
export function onboardingCustomer(setup: OnboardingSetup, payload: unknown): { id: string; name: string } {
  const read = (path: string): unknown => {
    let value = payload;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, part);
      if (!descriptor || !('value' in descriptor)) return undefined;
      value = descriptor.value;
    }
    return value;
  };
  let id = read(setup.customerIdPath);
  if (Number.isSafeInteger(id)) id = String(id);
  const name = read(setup.customerNamePath);
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f]/.test(id + name)) throw Error('Customer requires a stable ID and a nonempty name');
  return { id: id.trim(), name: name.trim() };
}

/** No fail-fast Promise.all: each provider failure becomes a recorded outcome.
 * Store/ownership failures propagate only after both branches have settled. */
export async function onboardCustomer(store: OnboardingStore, create: ResourceCreate, identity: string) {
  const branches = ['clickup', 'drive'] as const;
  const settled = await Promise.allSettled(branches.map(async branch => {
    store.check();
    const prior = store.read(branch);
    if (prior?.status === 'succeeded' || prior?.status === 'unknown') return prior;
    if (prior?.status === 'dispatching') {
      const outcome: ResourceOutcome = { status: 'unknown', detail: 'Interrupted dispatch requires review; creation was not repeated.' };
      store.save(branch, outcome);
      return outcome;
    }
    let started = false;
    let outcome: ResourceOutcome;
    try {
      outcome = await create(branch, () => { store.check(); store.save(branch, { status: 'dispatching' }); started = true; });
      if (!['succeeded', 'failed', 'unknown'].includes(outcome.status)) throw Error('Invalid provider outcome');
    } catch {
      outcome = { status: started ? 'unknown' : 'failed', detail: started ? 'Unconfirmed write requires review; creation will not be repeated.' : 'Account or pre-dispatch check failed; no write was attempted.' };
    }
    store.save(branch, outcome);
    return outcome;
  }));
  const error = settled.find(r => r.status === 'rejected');
  if (error?.status === 'rejected') throw error.reason;
  const outcomes = Object.fromEntries(branches.map((b, i) => [b, (settled[i] as PromiseFulfilledResult<ResourceOutcome>).value])) as Record<ResourceBranch, ResourceOutcome>;
  const summary = 'Customer onboarding outcomes\n' + branches.map(branch => {
    const r = outcomes[branch];
    return `${branch === 'clickup' ? 'ClickUp task' : 'Drive folder'}: ${r.status}. ${r.url ?? r.detail}`;
  }).join('\n');
  return { outcomes, summary, notificationKey: `onboarding:${digest([identity, outcomes])}` };
}

/** Fixed create-only endpoints. No provider SDK automatic retry, redirects, or search-before-create.
 * https://developer.clickup.com/reference/createtask
 * https://developers.google.com/workspace/drive/api/guides/folder
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create
 */
export function onboardingTransport(setup: OnboardingSetup, customer: { id: string; name: string }, token: (branch: ResourceBranch) => Promise<string>, checkpoint: () => void, fetchImpl: typeof fetch = fetch): ResourceCreate {
  return async (branch, dispatching) => {
    const credential = await token(branch);
    checkpoint();
    const url = branch === 'clickup' ? `https://api.clickup.com/api/v2/list/${setup.clickupListId}/task` : 'https://www.googleapis.com/drive/v3/files?fields=id,mimeType,parents&supportsAllDrives=true';
    const body = branch === 'clickup' ? { name: `Onboard ${customer.name}`, description: `Customer reference: ${customer.id}`, check_required_custom_fields: true, notify_all: false }
      : { name: customer.name, mimeType: 'application/vnd.google-apps.folder', parents: [setup.driveParentId] };
    dispatching();
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000), headers: { Authorization: branch === 'clickup' ? credential : `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { return { status: 'unknown', detail: 'Write response unavailable; review required before any further creation.' }; }
    if (!response.ok) {
      // Only explicit request/auth/not-found rejections are safe to retry on a new run.
      const rejected = [400, 401, 403, 404, 422].includes(response.status);
      await response.body?.cancel();
      return { status: rejected ? 'failed' : 'unknown', detail: `Provider HTTP ${response.status}. ${rejected ? 'Request rejected; retry may attempt this branch again.' : 'Outcome uncertain; automatic creation is blocked.'}` };
    }
    try {
      const text = await response.text();
      if (text.length > 1_000_000) throw Error('Oversized response');
      const result = JSON.parse(text);
      if (typeof result.id !== 'string' || !/^[\w-]{1,256}$/.test(result.id)) throw Error('Missing resource identity');
      if (branch === 'drive' && (result.mimeType !== 'application/vnd.google-apps.folder' || !Array.isArray(result.parents) || !result.parents.includes(setup.driveParentId))) throw Error('Folder destination not confirmed');
      return { status: 'succeeded', id: result.id, url: branch === 'clickup' ? `https://app.clickup.com/t/${result.id}` : `https://drive.google.com/drive/folders/${result.id}`, detail: 'Resource created; durable receipt reused on subsequent runs.' };
    } catch { return { status: 'unknown', detail: 'Creation returned an unverifiable result; automatic creation is blocked.' }; }
  };
}
