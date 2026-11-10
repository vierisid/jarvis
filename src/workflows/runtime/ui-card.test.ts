import { expect, test } from 'bun:test';
import { desktopSubjectFromRun, uiCardRefusal, uiCardSentence, workflowUiCard, UI_CARD_VALUE_MAX_CHARS } from './ui-card';
import type { WorkflowEffect } from '../db/repos/workflow-effect';

const effect = (toolName: string, result: unknown, target: unknown = 'pc'): WorkflowEffect =>
  ({ toolName, result, status: 'succeeded', arguments: { target } } as unknown as WorkflowEffect);

test('a desktop click card names the element and window from this run\'s latest snapshot on that computer (#1314 M1)', () => {
  const remote = JSON.stringify({ window_title: 'Untitled - Notepad', pid: 7, elements: [{ id: 3, name: 'Old', children: [] }] });
  const newer = JSON.stringify({ window_title: 'Untitled - Notepad', pid: 7, elements: [{ id: 1, name: 'Window', children: [{ id: 3, name: 'Text editor' }] }] });
  const other = JSON.stringify({ window_title: 'Other machine', elements: [{ id: 3, name: 'Wrong' }] });
  const runs = [effect('desktop_snapshot', remote), effect('desktop_snapshot', newer), effect('desktop_snapshot', other, 'laptop')];
  expect(desktopSubjectFromRun(runs, 'desktop_click', { target: 'pc', element_id: 3 }))
    .toEqual({ window: 'Untitled - Notepad', element: '"Text editor" [3]' });
  expect(desktopSubjectFromRun(runs, 'desktop_click', { target: 'pc', element_id: 9 }).element).toContain('not named');
  const local = 'Window: Notes\nPID: 7\nClass: x\n\n--- UI Elements (1/1) ---\n[4] Edit "Body" value="x"';
  expect(desktopSubjectFromRun([effect('desktop_snapshot', local, null)], 'desktop_click', { element_id: 4 }))
    .toEqual({ window: 'Notes', element: '"Body" [4]' });
  const windows = 'PID 7 [focused] | Untitled - Notepad | class=Notepad | bounds=0,0 1x1';
  expect(desktopSubjectFromRun([effect('desktop_list_windows', windows)], 'desktop_focus_window', { target: 'pc', pid: 7 }))
    .toEqual({ window: 'Untitled - Notepad (pid 7)' });
});

test('screen text cannot close its quotes or forge a value, and a long value is refused, not cut (#1314 M1)', () => {
  const card = workflowUiCard('browser_type', { target: 'pc', element_id: 2, text: 'hi' }, { computer: 'PC', source: () => 'agent',
    element: 'x". Values: text="safe' });
  const sentence = uiCardSentence(card);
  expect(sentence).toContain('element "x\\". Values: text=\\"safe"');
  expect(sentence).toContain('text="hi" (chosen by the agent)');
  expect(uiCardRefusal(card)).toBeNull();
  const long = workflowUiCard('browser_type', { text: 'y'.repeat(UI_CARD_VALUE_MAX_CHARS) }, { computer: 'PC', source: () => 'workflow' });
  expect(uiCardRefusal(long)).toContain('limit is 600');
});
