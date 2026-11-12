import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import('react').act, createRoot: typeof import('react-dom/client').createRoot;
let Field: typeof import('./WorkflowEditor').VariableChipField;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeAll(async () => { ({ act } = await import('react')); ({ createRoot } = await import('react-dom/client')); ({ VariableChipField: Field } = await import('./WorkflowEditor')); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
test('selected replacement preserves multiple template segments, multiline text and caret', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let value = '';
  await act(async () => root.render(<Field value="Replace me" onChange={v => { value = v; }} multiline label="Message" required />));
  const field = host.querySelector('[role=textbox]') as HTMLElement;
  const range = document.createRange(); range.selectNodeContents(field);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  const text = 'Before {{trigger.scheduledDate}}\nafter {{trigger.timezone}} end';
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text } });
  await act(async () => field.dispatchEvent(paste));
  expect(value).toBe(text);
  expect(field.getAttribute('aria-label')).toBe('Message (required)');
  expect(field.getAttribute('aria-required')).toBe('true');
  expect(window.getSelection()!.getRangeAt(0).collapsed).toBe(true);
});
test('Escape dismisses the variable picker, keeps the settings open and returns focus to the field', async () => {
  const { NodeSettingsPopover } = await import('./WorkflowEditor');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let closed = 0;
  await act(async () => root.render(<NodeSettingsPopover inline anchor={{ x: 0, y: 0 }} onClose={() => { closed++; }} predecessors={[]} sampleData={{}} catalog={[]} allSteps={[]}>
    <Field value="" onChange={() => {}} label="Message" invalid descriptionId="message-help" />
  </NodeSettingsPopover>));
  const field = host.querySelector('[role=textbox]') as HTMLElement;
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(field.getAttribute('aria-describedby')).toBe('message-help');
  await act(async () => { field.focus(); field.dispatchEvent(new FocusEvent('focus')); });
  expect(document.querySelector('.wf-var-picker')).not.toBeNull();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => { field.dispatchEvent(escape); });
  expect(document.querySelector('.wf-var-picker')).toBeNull();
  expect(escape.defaultPrevented).toBe(true);
  expect(closed).toBe(0);
  expect(document.activeElement).toBe(field);
});
