import { beforeAll, afterAll, beforeEach, afterEach, test, expect } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Root } from 'react-dom/client';
let React: typeof import('react'), createRoot: typeof import('react-dom/client').createRoot;
let useStatus: typeof import('./EmergencyStatus').useEmergencyStatus, Banner: typeof import('./EmergencyStatus').EmergencyStatusBanner;
let root: Root, host: HTMLDivElement, status: unknown, methods: string[], reads: number;
let navigation: () => Promise<{ state: string }>, opened: number;
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import('react'); ({ createRoot } = await import('react-dom/client'));
  ({ useEmergencyStatus: useStatus, EmergencyStatusBanner: Banner } = await import('./EmergencyStatus')); });
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  status = { enabled: true, emergency_state: 'paused', config: { emergency_state: 'normal' } }; methods = []; reads = 0; opened = 0;
  navigation = async () => ({ state: 'opened' }); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

const http: any = { json: async (path: string, init?: RequestInit) => {
  methods.push(init?.method ?? 'GET'); expect(path).toBe('/api/authority/status'); reads++;
  if (status instanceof Error) throw status; return status; } };
function App({ revision = 0 }: { revision?: number }) {
  const state = useStatus(http, revision);
  return <Banner state={state} open={() => { opened++; return navigation(); }} />;
}
/** Let React and pending reads settle until `done` holds. */
async function until(done: () => boolean) {
  for (let i = 0; i < 100; i++) { if (done()) return; await React.act(async () => { await new Promise(r => setTimeout(r, 0)); }); }
  throw new Error('condition not reached');
}
async function readAgain(trigger: () => void) {
  const before = reads; await React.act(async () => trigger()); await until(() => reads > before);
  // One more turn so the read's result is committed.
  await React.act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const render = (revision = 0) => readAgain(() => root.render(<App revision={revision} />));
const focus = () => readAgain(() => window.dispatchEvent(new Event('focus')));
const text = () => host.textContent ?? '';

test('a global pause shows after a reload', async () => {
  await render(); await until(() => text().includes('Jarvis is paused globally'));
  expect(text()).toContain('save input and approval responses');
  // Rendered outside BriefHost: it carries the Brief tokens itself, and not the Needs-you banner's class.
  expect(host.querySelector('aside')!.className).toBe('brief-root brief-emergency-banner');
  await React.act(async () => root.unmount()); root = createRoot(host);
  await render(); await until(() => text().includes('paused globally'));
});

test('opening Emergency controls only reads, never resumes', async () => {
  await render(); await until(() => !!host.querySelector('button'));
  await React.act(async () => host.querySelector('button')!.click());
  expect(opened).toBe(1);
  expect(methods.every(method => method === 'GET')).toBe(true);
  expect(text()).not.toContain('could not be opened');
});

test('a navigation that cannot open says so, and a cancelled one does not', async () => {
  await render(); await until(() => !!host.querySelector('button'));
  navigation = async () => ({ state: 'cancelled' });
  await React.act(async () => host.querySelector('button')!.click());
  expect(text()).not.toContain('could not be opened');
  navigation = async () => ({ state: 'unavailable' });
  await React.act(async () => host.querySelector('button')!.click());
  await until(() => text().includes('Emergency controls could not be opened. Try again.'));
  navigation = async () => ({ state: 'opened' });
  await React.act(async () => host.querySelector('button')!.click());
  await until(() => !text().includes('could not be opened'));
  navigation = async () => { throw new Error('host gone'); };
  await React.act(async () => host.querySelector('button')!.click());
  await until(() => text().includes('could not be opened'));
});

test('focus reads the current state', async () => {
  await render(); await until(() => text().includes('paused globally'));
  status = { enabled: true, emergency_state: 'normal', config: { emergency_state: 'paused' } };
  await focus(); await until(() => host.querySelector('aside') === null);
});

test('the daemon emergency broadcast re-reads the status at once', async () => {
  await render(); await until(() => text().includes('paused globally'));
  status = { enabled: true, emergency_state: 'killed' };
  await readAgain(() => root.render(<App revision={1} />));
  await until(() => text().includes('emergency stop is active'));
  expect(text()).toContain('will not restart automatically');
});

test('one failed read keeps the last known state; two in a row show unavailable', async () => {
  await render(); await until(() => text().includes('paused globally'));
  status = new Error('offline');
  await focus();
  expect(text()).toContain('paused globally');
  expect(text()).not.toContain('unavailable');
  await focus(); await until(() => text().includes('Emergency status is unavailable'));
  // A good read resets the count: one later failure keeps it again.
  status = { enabled: true, emergency_state: 'killed' };
  await focus(); await until(() => text().includes('emergency stop is active'));
  status = new Error('offline');
  await focus();
  expect(text()).toContain('emergency stop is active');
});

test('a failed first read shows unavailable, never normal', async () => {
  status = new Error('offline');
  await render(); await until(() => text().includes('Emergency status is unavailable'));
  expect(host.querySelector('aside')?.getAttribute('data-state')).toBe('unavailable');
});

test('an unexpected state counts as a failed read', async () => {
  status = { enabled: true, emergency_state: 'unexpected' };
  await render(); await until(() => text().includes('Emergency status is unavailable'));
  status = { enabled: true, emergency_state: 'paused' };
  await focus(); await until(() => text().includes('paused globally'));
  status = { enabled: true, emergency_state: 'unexpected' };
  await focus();
  expect(text()).toContain('paused globally');
});

test('a read slower than the triggers still commits, then reads once more', async () => {
  await render(); await until(() => text().includes('paused globally'));
  const slow: Array<() => void> = []; const json = http.json;
  http.json = async (path: string, init?: RequestInit) => { await new Promise<void>(r => slow.push(r)); return json(path, init); };
  try {
    status = { enabled: true, emergency_state: 'killed' };
    const before = reads;
    for (let i = 0; i < 3; i++) await React.act(async () => window.dispatchEvent(new Event('focus')));
    await until(() => slow.length === 1);
    // Further triggers while it is in flight do not start or supersede it.
    expect(slow.length).toBe(1);
    await React.act(async () => slow.shift()!());
    await until(() => text().includes('emergency stop is active'));
    // The queued trigger runs once after it.
    await until(() => slow.length === 1);
    await React.act(async () => slow.shift()!());
    await until(() => reads === before + 2);
  } finally { http.json = json; }
});

test('a daemon without Authority wired shows nothing', async () => {
  status = { enabled: false };
  await render();
  expect(host.querySelector('aside')).toBeNull();
});

test('workspace notices are inside the themed navigation content, not behind its fixed shell', async () => {
  const { BriefHost } = await import('../entry/DashboardEntry');
  const rooms:any={today:{title:'Today',Body:()=> <h1>Today content</h1>}};
  await React.act(async()=>{root.render(<BriefHost route={{room:'today',selection:{}}} rooms={rooms} notice={<Banner state="paused" open={()=>{opened++;}}/>}/>);});
  const banner=host.querySelector('[aria-label="Emergency controls status"]')!;
  expect(banner.closest('.brief-root')).not.toBeNull();
  expect(banner.closest('main')).not.toBeNull();expect(host.textContent).toContain('Today content');
});
