import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Users said Jarvis feels like n8n: the workflow page spoke developer. These cover
// the plain wording of the schedule, the step labels and the notify step's panel.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act;
let React: typeof import('react');
let createRoot: typeof import('react-dom/client').createRoot;
let mod: typeof import('./WorkflowEditor');
let ScheduleEditor: typeof import('./ScheduleEditor').ScheduleEditor;
let ReactFlowProvider: typeof import('@xyflow/react').ReactFlowProvider;
let Env: typeof import('./WorkflowEditorEnvironment').WorkflowEditorEnvironment;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  React = await import('react');
  ({ act } = React);
  ({ createRoot } = await import('react-dom/client'));
  mod = await import('./WorkflowEditor');
  ({ ScheduleEditor } = await import('./ScheduleEditor'));
  ({ ReactFlowProvider } = await import('@xyflow/react'));
  ({ WorkflowEditorEnvironment: Env } = await import('./WorkflowEditorEnvironment'));
});
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

function setValue(el: Element, value: string) {
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
}
const change = async (el: Element, value: string, event = 'change') =>
  act(async () => { setValue(el, value); el.dispatchEvent(new Event(event, { bubbles: true })); });

/** Holds the input the way the editor does (picking a zone marks it chosen, as tree.ts withStepInput), and records every field write. */
function ScheduleHarness({ initial, chosen: initialChosen, writes }: { initial: Record<string, unknown>; chosen?: string; writes: Array<[string, unknown]> }) {
  const [input, setInput] = React.useState(initial);
  const [chosen, setChosen] = React.useState(initialChosen);
  return <ScheduleEditor input={input} chosenTimezone={chosen} onSetInput={(k, v) => {
    writes.push([k, v]);
    setInput((cur) => ({ ...cur, [k]: v }));
    if (k === 'timezone') setChosen(typeof v === 'string' && v ? v : undefined);
  }} />;
}
const select = (label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;

test('"Fridays at 8:30 in Rome" writes the schedule piece fields: cron_expression and timezone', async () => {
  const writes: Array<[string, unknown]> = [];
  await act(async () => root.render(<ScheduleHarness initial={{ cron_expression: '0 9 * * *' }} writes={writes} />));
  expect(host.textContent).toContain('Every day at 9:00');

  await change(select('Repeats'), 'days');
  // Specific days starts from one day; swap it for Friday.
  const day = (name: string) => [...host.querySelectorAll('.wf-schedule__day')].find((l) => l.textContent === name)!.querySelector('input')!;
  await act(async () => day('Fri').click());
  await act(async () => day('Mon').click());
  await change(host.querySelector('input[type="time"]')!, '08:30');
  await change(select('Timezone'), 'Europe/Rome');

  expect(writes.at(-2)).toEqual(['cron_expression', '30 8 * * 5']);
  expect(writes.at(-1)).toEqual(['timezone', 'Europe/Rome']);
  expect(select('Timezone').value).toBe('Europe/Rome');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Every Friday at 8:30');
  // Every write goes to a field the schedule piece already has.
  expect(new Set(writes.map(([k]) => k))).toEqual(new Set(['cron_expression', 'timezone']));
});

test('weekdays, and a custom expression keeps its text box instead of being rewritten', async () => {
  const writes: Array<[string, unknown]> = [];
  await act(async () => root.render(<ScheduleHarness initial={{ cron_expression: '0 17 LW * *' }} writes={writes} />));
  // An expression the simple editor cannot express opens as Custom and shows the raw text.
  expect(select('Repeats').value).toBe('custom');
  expect((host.querySelector('input[aria-label="Cron expression"]') as HTMLInputElement).value).toBe('0 17 LW * *');
  expect(writes).toEqual([]);
  await change(select('Repeats'), 'weekdays');
  expect(writes).toEqual([['cron_expression', '0 9 * * 1-5']]);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Every weekday at 9:00');
});

test('a stored zone nobody picked reads as the Jarvis default, which is where it runs', async () => {
  const writes: Array<[string, unknown]> = [];
  await act(async () => root.render(<ScheduleHarness initial={{ cron_expression: '0 9 * * *', timezone: 'UTC' }} writes={writes} />));
  expect(select('Timezone').value).toBe('');
  expect(host.textContent).toContain('UTC is saved but nobody picked it, so this runs in the Jarvis default.');
  await change(select('Timezone'), 'UTC');
  expect(writes).toEqual([['timezone', 'UTC']]);
  expect(select('Timezone').value).toBe('UTC');
  expect(host.textContent).not.toContain('nobody picked it');
});

test('a day-name expression the scheduler refuses opens as Custom, not as a schedule', async () => {
  const writes: Array<[string, unknown]> = [];
  await act(async () => root.render(<ScheduleHarness initial={{ cron_expression: '0 9 * * MON-FRI' }} writes={writes} />));
  expect(select('Repeats').value).toBe('custom');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('This expression has no plain-English form.');
});

const catalog = [{
  name: '@jarvispieces/piece-jarvis-notify', displayName: 'Jarvis Notify', description: '', triggers: [],
  actions: [{ name: 'notify', displayName: 'Send a Jarvis notification', description: '', inputSchema: { fields: [
    { name: 'meetingGuard', label: 'Meeting freshness guard', type: 'json', required: false },
    { name: 'idempotencyKey', label: 'Notification identity', type: 'string', required: false },
    { name: 'message', label: 'Message', type: 'long_text', required: true },
    { name: 'channels', label: 'Channels', type: 'multi_enum', required: false, options: [{ value: 'auto', label: 'Auto' }, { value: 'dashboard', label: 'Dashboard' }] },
    { name: 'priority', label: 'Priority', type: 'enum', required: false, options: [{ value: 'normal', label: 'Normal' }] },
  ] } }],
}];
const noop = () => {};
const panelProps = (step: any, extra: Record<string, unknown> = {}) => ({
  workspace: true, step, isTriggerStep: step.type === 'PIECE_TRIGGER', hasNextAction: false, isTopLevel: true, catalog, connections: [],
  sampleData: undefined, sampleInput: undefined, isLocked: false,
  onSetTriggerKind: noop, onSetErrorHandling: noop, onSetSourceCode: noop, onSetInput: noop, onUseStandardClickUpFields: noop,
  onAddInputKey: noop, onRemoveInputKey: noop, onSetDisplayName: noop, onAddStepAfter: noop, onDelete: noop, onSetLoopItems: noop,
  onAddStepToLoopBody: noop, onSetRouterExecutionType: noop, onAddRouterBranch: noop, onRemoveRouterBranch: noop,
  onAddStepToBranch: noop, onSetBranchConditions: noop, onSetSampleData: async () => ({ ok: true, message: '' }),
  onSetSampleInput: async () => ({ ok: true, message: '' }), onTestFromHere: async () => ({ ok: true, message: '' }), ...extra,
});
const renderPanel = async (step: any) => {
  globalThis.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
  await act(async () => root.render(
    <Env.Provider value={{ request: globalThis.fetch as any, portalHost: null, workspace: true }}>
      <mod.PropertiesPanel {...(panelProps(step) as any)} />
    </Env.Provider>));
};
const notifyStep = {
  name: 'step_1', type: 'PIECE', displayName: 'Tell me',
  settings: { pieceName: '@jarvispieces/piece-jarvis-notify', actionName: 'notify', input: { message: 'Done', channels: ['dashboard'], meetingGuard: { a: 1 } } },
};

test('the notify step opens on the message and channels, with the advanced fields collapsed under Advanced', async () => {
  await renderPanel(notifyStep);
  const labels = [...host.querySelectorAll('.wf-props__field-label')].map((l) => l.textContent!.replace(/\s*\*$/, ''));
  expect(labels.indexOf('Message')).toBeGreaterThanOrEqual(0);
  expect(labels.indexOf('Message')).toBeLessThan(labels.indexOf('Channels'));
  const advanced = host.querySelector('details.wf-props__advanced-fields') as HTMLDetailsElement;
  expect(advanced.open).toBe(false);
  expect(advanced.querySelector('summary')?.textContent).toBe('Advanced (1 set)');
  expect(advanced.textContent).toContain('Meeting freshness guard');
  expect(advanced.textContent).toContain('Notification identity');
  // Neither advanced field is among the fields outside the Advanced group.
  const outside = [...host.querySelectorAll('.wf-props__field-label')].filter((l) => !advanced.contains(l)).map((l) => l.textContent);
  expect(outside.join(' ')).not.toMatch(/freshness|identity/i);
  expect(host.textContent).not.toContain('Piece trigger');
});

test('a schedule trigger panel says Trigger, shows the schedule in words and keeps daylight-saving under Advanced', async () => {
  await renderPanel({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: '30 8 * * 5', timezone: 'Europe/Rome' }, chosenTimezone: 'Europe/Rome' } });
  expect(host.textContent).toContain('Every Friday at 8:30');
  expect(host.textContent).toContain('Trigger');
  expect(host.textContent).not.toContain('Piece trigger');
  expect(host.textContent).not.toContain('Schedule (cron)');
  expect((host.querySelector('details.wf-props__advanced-fields') as HTMLDetailsElement).open).toBe(false);
});

const nodeData = (step: any) => ({
  step, selected: false, catalog, depth: 0, branchName: null, isOrphan: false, targetIsFree: false, outConnected: false,
  loopBodyConnected: false, branchConnected: {}, runStatus: null, runError: null, runDuration: null,
});
const renderNode = async (step: any, workspace = true) => act(async () => root.render(
  <Env.Provider value={{ request: (async () => new Response('{}')) as any, portalHost: null, workspace }}>
    <ReactFlowProvider><mod.StepNode {...({ data: nodeData(step), id: 'n' } as any)} /></ReactFlowProvider>
  </Env.Provider>));

test('a plain step no longer carries the "Programmed" label, and its piece shows without scope or Piece jargon', async () => {
  await renderNode({ name: 'step_1', type: 'PIECE', settings: { pieceName: '@activepieces/piece-not-installed', actionName: 'x' } });
  expect(host.textContent).not.toContain('Programmed');
  expect(host.textContent).not.toContain('@activepieces');
  expect(host.textContent).not.toContain('piece-');
  expect(host.textContent).toContain('not installed');
  // A step that is AI judgment still says so.
  await renderNode({ name: 'step_2', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-agent', actionName: 'ask' } });
  expect(host.textContent).toContain('AI judgment');
});

test('the schedule trigger card shows the schedule in words, not "Schedule · Cron Expression"', async () => {
  await renderNode({ name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', triggerName: 'cron_expression', input: { cron_expression: '0 9 * * 1-5' } } });
  expect(host.querySelector('.wf-node__body')?.textContent).toBe('Every weekday at 9:00');
});
