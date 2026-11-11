/**
 * #1314 follow-up (owner decision 2026-11-11): a screen-derived approval is
 * held while screen awareness is off. The REST list says so on the card, the
 * desktop notification poll does not show it, and turning awareness back on
 * delivers the cards held meanwhile. Core behaviour is in
 * src/authority/approval-provenance.test.ts.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createApiRoutes, type ApiContext } from './api-routes';
import { closeDb, initDatabase } from '../vault/schema';
import { ApprovalManager } from '../authority/approval';
import { AWARENESS_HELD_APPROVAL_MESSAGE, runWithApprovalProvenance } from '../authority/approval-provenance';
import { setScreenCaptureEnabledSource } from '../actions/tools/desktop-guard';

let on = true;
beforeEach(() => { on = true; setScreenCaptureEnabledSource(() => on); initDatabase(':memory:', { quiet: true }); });
afterEach(() => { setScreenCaptureEnabledSource(null); closeDb(); });

test('the pending approvals list says a screen-derived card is held while awareness is off, and only then', async () => {
  const mgr = new ApprovalManager();
  const make = () => mgr.createRequest({ agentId: 'bg', agentName: 'Background', toolName: 'send_email', toolArguments: {},
    actionCategory: 'send_email', urgency: 'normal', reason: 'r', context: '' });
  const screen = runWithApprovalProvenance('screen', make), plain = make();
  const routes = createApiRoutes({ approvalManager: mgr } as unknown as ApiContext) as Record<string, any>;
  const list = async () => {
    const rows = await (await routes['/api/authority/approvals'].GET(new Request('http://x/api/authority/approvals?status=pending'))).json() as Array<{ id: string; held: string | null }>;
    return Object.fromEntries(rows.map(r => [r.id, r.held]));
  };
  expect(await list()).toEqual({ [screen.id]: null, [plain.id]: null });
  on = false;
  expect(await list()).toEqual({ [screen.id]: AWARENESS_HELD_APPROVAL_MESSAGE, [plain.id]: null });
});

test('the daemon skips held cards in the notification poll and delivers held cards when awareness is turned back on', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const poll = index.slice(index.indexOf('for (const req of approvalManager.getPending()) {'), index.indexOf('notifyApproval(req);'));
  expect(poll).toMatch(/if \(notifiedApprovalIds\.has\(req\.id\)\) continue;[\s\S]*if \(approvalHeldByAwareness\(req\)\) continue;/);
  // Skipped before it is marked notified, so it shows once awareness is back on.
  expect(poll.indexOf('approvalHeldByAwareness(req)')).toBeLessThan(poll.indexOf('notifiedApprovalIds.add(req.id)'));
  const applier = index.slice(index.indexOf("settingsReload.registerApplier('awareness'"), index.indexOf("settingsReload.registerApplier('desktop'"));
  expect(applier).toContain("if (cfg.awareness?.enabled === false) closeSwitchedOffWorkflowCards();\n      // Back on: the screen-derived approval cards held while it was off go out now.\n      else void approvalDelivery.resumeHeld((id) => approvalManager.getRequest(id));");
});

// The long-press saves the choice through persistAwarenessChoice; that save is
// what runs the awareness applier (and so resumeHeld) via the section-saved
// listener the daemon installs (settingsReload.sectionChanged). Pinned so the
// long-press keeps resuming held cards without a call of its own.
test('saving the awareness choice notifies the section-saved listener the applier hangs on', async () => {
  const { persistAwarenessChoice, setSectionSavedListener } = await import('./user-settings');
  const saved: string[] = [];
  setSectionSavedListener((section) => saved.push(section));
  try { persistAwarenessChoice(true); } finally { setSectionSavedListener(null); }
  expect(saved).toEqual(['awareness']);
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  expect(index).toContain('setSectionSavedListener((section) => settingsReload?.sectionChanged(section));');
  const press = index.slice(index.indexOf("event.event_type !== 'pebble.blind_toggle'"), index.indexOf("console.log(`[ambient-ui] blind toggle"));
  expect(press).toContain('persistAwarenessChoice(nextEnabled);');
});
