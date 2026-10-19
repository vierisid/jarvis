import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { inspect, runCases } from './browser';
import { requiredCases, VIEWS } from './matrix';
import { hash } from './report';
import type { Row } from './report';

const candidate = { revision: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false };
const testCase = requiredCases().find(c => c.kind === 'keyboard' && c.view === 'welcome' && c.theme === 'light')!;
const primary = { path: 'scene/0', name: 'Set up Jarvis' };
const secondary = { path: 'scene/1', name: "I'll do this later" };
const focused = (control: typeof primary) => ({ ...control, inside: true, visible: true, indicator: true, tag: 'BUTTON' });
const outside = { path: null, name: '', inside: false, visible: true, indicator: false, tag: 'BODY' };
type Focus = ReturnType<typeof focused> | typeof outside;

// Drive the real runner with recorded native-focus sequences. DOM enumeration is
// tested separately below; actual native Tab behavior still needs browser evidence.
async function run(forward: Focus[], reverse: Focus[] = forward, controls = [primary, secondary]) {
  const artifacts = new Map<string, string>();
  const rows: Row[] = [];
  let evaluation = 0, active = outside as Focus;
  const offsets: Record<string, number> = { Tab: 0, 'shift+Tab': 0 };
  const tab = {
    goto: async () => {}, screenshot: async () => new Uint8Array([1]),
    pressKey: async (_: unknown, key: string) => {
      const sequence = key === 'Tab' ? forward : reverse;
      active = sequence[offsets[key]!++ % sequence.length]!;
    },
    playwright: {
      waitForLoadState: async () => {}, locator: () => ({ waitFor: async () => {} }), domSnapshot: async () => 'fixture',
      evaluate: async () => ++evaluation === 1 ? 'loaded' : ({
        revision: candidate.revision, dirty: 'false', caseId: testCase.id,
        view: testCase.view, state: testCase.state, sidebar: testCase.sidebar,
        headings: ['Welcome'], controls: controls.map(c => c.name), keyboardControls: controls,
        keyboardTraversalLimit: controls.length + 2, focus: active,
        theme: testCase.theme, childThemes: [], width: testCase.width, overflow: 0, clipped: [], unnamed: 0,
      }),
    },
  };
  await runCases({ tab, viewport: { set: async () => {} }, baseUrl: 'http://fixture.invalid', cases: [testCase], candidate,
    inventory: { views: ['welcome'], host: false, pebble: false, missing: VIEWS.filter(v => v.name !== 'welcome').map(v => v.id) },
    save: async (path, bytes) => { if (typeof bytes === 'string') artifacts.set(path, bytes); return { path, sha256: hash(bytes) }; },
    onResult: async row => { rows.push(row); },
  });
  return { row: rows[0]!, observation: JSON.parse(artifacts.get(`${testCase.id}.metrics.json`)!) };
}

test('an enabled primary button omitted from Tab order fails the keyboard row', async () => {
  const { row, observation } = await run([focused(secondary), outside]);
  expect(row.outcome).toBe('failed');
  expect(row.reason).toContain('forward traversal missed enabled controls: Set up Jarvis');
  expect(row.reason).toContain('reverse traversal missed enabled controls: Set up Jarvis');
  expect(observation.errors).not.toEqual([]);
});

test('forward coverage cannot hide an unreachable control in reverse traversal', async () => {
  const { row } = await run([focused(primary), focused(secondary), outside], [focused(secondary), outside]);
  expect(row.outcome).toBe('failed');
  expect(row.reason).toContain('reverse traversal missed enabled controls: Set up Jarvis');
  expect(row.reason).not.toContain('forward traversal missed');
});

test('same-name controls must each be visited by element identity', async () => {
  const other = { ...secondary, name: primary.name };
  const { row } = await run([focused(other), outside], undefined, [primary, other]);
  expect(row.outcome).toBe('failed');
  expect(row.reason).toContain('Set up Jarvis (scene/0)');
});

test('complete traversal passes and records both directions with element identity', async () => {
  const { row, observation } = await run([focused(primary), focused(secondary), outside]);
  expect(row.outcome).toBe('passed');
  expect(observation.errors).toEqual([]);
  expect(new Set(observation.keys.map((k: any) => k.direction))).toEqual(new Set(['forward', 'reverse']));
  expect(observation.keys.some((k: any) => k.path === primary.path)).toBe(true);
});

test('visiting every control still fails a focus trap or missing focus indicator', async () => {
  expect((await run([focused(primary), focused(secondary)])).row.outcome).toBe('failed');
  expect((await run([{ ...focused(primary), indicator: false }, focused(secondary), outside])).row.outcome).toBe('failed');
});

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
test('DOM inspection retains negative-tabindex controls and distinguishes duplicate names', async () => {
  document.body.innerHTML = `<button>Outside</button><main data-u11-scene>
    <button tabindex="-1">Continue</button><button>Continue</button>
    <button disabled>Disabled</button>
    <button aria-disabled="true">Unavailable</button><div hidden><button>Hidden</button></div>
    <div inert><button>Inert</button></div><h2 tabindex="-1">Heading</h2>
  </main>`;
  // Happy DOM does not lay out elements. Only geometry is stubbed; selectors,
  // disabled semantics, names, DOM identities and activeElement use the real DOM.
  const originalRects = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
  try {
    const first = document.querySelector<HTMLButtonElement>('main button')!;
    first.focus();
    const metrics = await inspect({ playwright: { evaluate: (fn: () => unknown) => fn() } });
    expect(metrics.keyboardControls.map(c => c.name)).toEqual(['Continue', 'Continue']);
    expect(new Set(metrics.keyboardControls.map(c => c.path)).size).toBe(2);
    expect(metrics.focus?.path).toBe(metrics.keyboardControls[0]!.path);
    expect(metrics.keyboardTraversalLimit).toBeGreaterThan(metrics.controls.length + 2);
  } finally {
    HTMLElement.prototype.getClientRects = originalRects;
    document.body.innerHTML = '';
  }
});
