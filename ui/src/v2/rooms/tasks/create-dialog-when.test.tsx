// #1162 (from #1125): a non-empty "when" that does not parse saved an undated
// task or event. The voice path refuses that; the manual dialogs must too.
import { afterAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

async function dialog(kind: 'tasks' | 'calendar', fill: (inputs: HTMLInputElement[], set: (el: HTMLInputElement, v: string) => Promise<void>) => Promise<void>) {
  const React = await import('react'), { createRoot } = await import('react-dom/client');
  const { CreateDialog } = kind === 'tasks' ? await import('./TasksRoom') : await import('../calendar/CalendarRoom');
  const created: unknown[] = [];
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const set = async (el: HTMLInputElement, value: string) => React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await React.act(async () => root.render(<CreateDialog onClose={() => {}} onCreate={async (input: unknown) => { created.push(input); return true; }} />));
  await fill([...host.querySelectorAll('input')], set);
  const create = [...host.querySelectorAll('button')].find(b => b.textContent === 'Create')!;
  const state = { disabled: create.disabled, text: host.textContent ?? '' };
  await React.act(async () => create.click());
  await React.act(async () => root.unmount()); host.remove();
  return { ...state, created };
}

for (const kind of ['tasks', 'calendar'] as const) {
  test(`${kind}: an unparsed "when" blocks Create and says why`, async () => {
    const r = await dialog(kind, async ([what, when], set) => { await set(what!, 'Call the bank'); await set(when!, 'whenever suits'); });
    expect(r.disabled).toBe(true);
    expect(r.created).toEqual([]);
    expect(r.text).toContain("Couldn't read that time.");
  });
  test(`${kind}: a blank "when" still creates an undated item, and a parsed one creates`, async () => {
    const blank = await dialog(kind, async ([what], set) => { await set(what!, 'Call the bank'); });
    expect(blank.created).toHaveLength(1);
    const dated = await dialog(kind, async ([what, when], set) => { await set(what!, 'Call the bank'); await set(when!, 'tomorrow at 3pm'); });
    expect(dated.disabled).toBe(false);
    expect(dated.created).toHaveLength(1);
  });
}
