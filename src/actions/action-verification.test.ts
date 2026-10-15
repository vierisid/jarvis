import { expect, test } from 'bun:test';
import { collectActionVerification, recordActionVerification, observedPage, observedWindow } from './action-verification';

test('concurrent and nested UI calls cannot borrow another effect’s evidence', async () => {
  const [page, click] = await Promise.all([
    collectActionVerification('browser_snapshot', 'browser', async () => {
      await Bun.sleep(5);
      recordActionVerification('browser_snapshot', observedPage('https://example.test/', 'doc-1'));
      return 'page';
    }),
    collectActionVerification('browser_click', 'browser', async () => {
      recordActionVerification('browser_snapshot', observedPage('https://example.test/', 'doc-2'));
      await collectActionVerification('desktop_launch_app', 'desktop', async () => {
        recordActionVerification('desktop_launch_app', observedWindow({ success: true, window_visible: true, pid: 9 }));
      });
      return 'Clicked';
    }),
  ]);
  expect(page.verification).toMatchObject({ status: 'verified', documentId: 'doc-1' });
  expect(click.verification).toEqual({ status: 'unverified', reason: 'no_supported_postcondition' });
});

test('process start and malformed window claims do not certify visibility', () => {
  for (const reply of [null, 'success', { success: true, pid: 1 }, { success: true, pid: 1, window_visible: null },
    { success: true, pid: '1', window_visible: true }, { success: false, pid: 1, window_visible: true },
    { success: true, pid: 0, window_visible: true }]) {
    expect(observedWindow(reply).status).toBe('unverified');
  }
});
