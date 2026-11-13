import { describe, expect, test } from 'bun:test';
import { notchApprovalWhere, notchPlaceSentence, type NotchWhereDeps } from './notch-where.ts';

const request = (tool: string, args: unknown) => ({ tool_name: tool, tool_arguments: JSON.stringify(args) });

function machine(reply: unknown, picture: { width: number; height: number } | null = { width: 1280, height: 720 }) {
  const asked: { target: string; params: Record<string, unknown> }[] = [];
  const deps: NotchWhereDeps = {
    target: (explicit) => (typeof explicit === 'string' ? explicit : 'desk-pc'),
    picture: () => picture,
    ask: async (target, params) => { asked.push({ target, params }); return reply; },
  };
  return { deps, asked };
}

describe('where on the screen an approval would land', () => {
  test('a click on an element is named by the element and its window', async () => {
    const { deps, asked } = machine({ element_role: 'Button', element_name: 'Send', window_title: 'Inbox - Outlook', process_name: 'olk' });
    expect(await notchApprovalWhere(request('desktop_click', { element_id: 12 }), deps)).toBe('Button "Send" in "Inbox - Outlook" (olk)');
    expect(asked).toEqual([{ target: 'desk-pc', params: { element_id: 12 } }]);
  });

  test('a click at a place asks what is at that place, as a fraction of the picture it was read off', async () => {
    const { deps, asked } = machine({ element_role: 'Hyperlink', element_name: 'Buy now', window_title: 'Store', process_name: 'steamwebhelper' });
    expect(await notchApprovalWhere(request('desktop_pointer', { x: 640, y: 360, target: 'other-pc' }), deps))
      .toBe('Hyperlink "Buy now" in "Store" (steamwebhelper)');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.target).toBe('other-pc');
    expect(asked[0]!.params.fx).toBeCloseTo(640.5 / 1280, 6);
    expect(asked[0]!.params.fy).toBeCloseTo(360.5 / 720, 6);
  });

  test('typed text and keys with no element go to the window in front, and it is named as that', async () => {
    const { deps, asked } = machine({ window_title: 'Checkout - Google Chrome', process_name: 'chrome' });
    expect(await notchApprovalWhere(request('desktop_press_keys', { keys: 'enter' }), deps))
      .toBe('the window in front, "Checkout - Google Chrome" (chrome)');
    expect(await notchApprovalWhere(request('desktop_type', { text: 'hello' }), deps))
      .toBe('the window in front, "Checkout - Google Chrome" (chrome)');
    expect(asked.map((ask) => ask.params)).toEqual([{}, {}]);
  });

  test('nothing is asked for a tool that does not act on the screen, or when there is nothing to ask about', async () => {
    const { deps, asked } = machine({ window_title: 'x' });
    expect(await notchApprovalWhere(request('run_command', { command: 'dir' }), deps)).toBeNull();
    expect(await notchApprovalWhere(request('desktop_click', {}), deps)).toBeNull();
    expect(await notchApprovalWhere({ tool_name: 'desktop_type', tool_arguments: 'not json' }, deps)).toBeNull();
    expect(await notchApprovalWhere({ tool_name: 'desktop_type', tool_arguments: '[1]' }, deps)).toBeNull();
    // A place that cannot be worked out (no picture, or outside it) is not asked about.
    expect(await notchApprovalWhere(request('desktop_pointer', { x: 5000, y: 10 }), deps)).toBeNull();
    expect(await notchApprovalWhere(request('desktop_pointer', { x: 10, y: 10 }), machine({}, null).deps)).toBeNull();
    expect(asked).toEqual([]);
    const none: NotchWhereDeps = { ...deps, target: () => null };
    expect(await notchApprovalWhere(request('desktop_type', { text: 'a' }), none)).toBeNull();
  });

  test('what the machine said is one short line, whatever it said', () => {
    expect(notchPlaceSentence({ element_role: 'Edit', element_name: '', window_title: 'Untitled - Notepad', process_name: 'notepad' }, false))
      .toBe('Edit with no name in "Untitled - Notepad" (notepad)');
    expect(notchPlaceSentence({ window_title: '', process_name: 'steam' }, false)).toBe('a window of steam');
    expect(notchPlaceSentence({ window_title: '', process_name: 'steam' }, true)).toBe('the window in front (steam)');
    expect(notchPlaceSentence({ element_role: 'Image', element_name: 'Play', process_name: 'steam' }, false)).toBe('Image "Play" in a window of steam');
    expect(notchPlaceSentence({ own: true, window_title: 'Jarvis' }, false)).toBe("one of Jarvis's own windows");
    expect(notchPlaceSentence({}, true)).toBeNull();
    expect(notchPlaceSentence(null, true)).toBeNull();
    expect(notchPlaceSentence('Send', true)).toBeNull();
    // Line breaks and length are the screen's to choose, not the sheet's.
    const long = notchPlaceSentence({ element_role: 'Button', element_name: `Pay\n\n${'x'.repeat(300)}`, window_title: 'W' }, false)!;
    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThan(140);
  });
});
