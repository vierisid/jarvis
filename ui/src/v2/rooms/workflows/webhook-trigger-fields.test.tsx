import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// #961: the Webhook trigger's optional signing secret has a field, and the
// field says what the secret does and what happens without one.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act;
let createRoot: typeof import('react-dom/client').createRoot;
let editor: typeof import('./WorkflowEditor');
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeAll(async () => {
  ({ act } = await import('react'));
  ({ createRoot } = await import('react-dom/client'));
  editor = await import('./WorkflowEditor');
});
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

test('the secret is entered hidden, shown on request, and the hint names the signature header', async () => {
  const set: string[] = [];
  const { WebhookTriggerFields, WEBHOOK_SECRET_HINT } = editor;
  await act(async () => root.render(<WebhookTriggerFields secret="s3cret" onSetSecret={(v) => set.push(v)} />));
  const input = host.querySelector('input')!;
  expect(input.type).toBe('password');
  expect(input.value).toBe('s3cret');
  expect(host.textContent).toContain('Signing secret (optional)');
  expect(host.textContent).toContain(WEBHOOK_SECRET_HINT);
  expect(WEBHOOK_SECRET_HINT).toMatch(/X-Jarvis-Signature header holding the hex HMAC-SHA256 of the raw request body/);
  expect(WEBHOOK_SECRET_HINT).toMatch(/Without one, anyone who has this workflow's webhook URL can start it/);
  const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show secret')!;
  await act(async () => show.click());
  expect(host.querySelector('input')!.type).toBe('text');
  const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
  await act(async () => { valueSetter.call(host.querySelector('input'), 'n3w'); host.querySelector('input')!.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(set).toEqual(['n3w']);
});

test('with no secret the field is empty and says unsigned requests are accepted', async () => {
  await act(async () => root.render(<editor.WebhookTriggerFields secret={undefined} onSetSecret={() => {}} />));
  const input = host.querySelector('input')!;
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('No secret: unsigned requests are accepted');
});
