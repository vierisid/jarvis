import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalToast, type ApprovalToast } from './approval-delivery.ts';
import type { ApprovalRequest } from './approval.ts';

/**
 * #808. The macOS sidecar takes a notification's buttons from a category
 * registered per kind, not from the payload's `actions`, and a kind with no
 * category shows no buttons. #791 added the `approval_review` kind and no
 * category for it. This reads the categories out of `sidecar/notify_darwin.go`
 * and checks them against what the brain sends, so the two cannot drift again.
 *
 * Parsed from source because the file only compiles on macOS; CI's
 * `sidecar-build-darwin` job is what compiles it.
 */
// Comment lines dropped first, so a commented-out declaration does not count
// as registered (#808 review).
const source = readFileSync(join(import.meta.dir, '../../sidecar/notify_darwin.go'), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '');

/** Each declared action's identifier and options, keyed by variable name. */
function darwinActions(): Map<string, { id: string; options: string }> {
  const actions = new Map<string, { id: string; options: string }>();
  for (const m of source.matchAll(/UNNotificationAction\*\s+(\w+)\s*=\s*\[UNNotificationAction actionWithIdentifier:@"([^"]+)"\s+title:@"[^"]*"\s+options:(\w+)\]/g)) {
    // A name declared twice does not compile, and this box cannot compile it.
    if (actions.has(m[1]!)) throw new Error(`action ${m[1]} is declared twice`);
    actions.set(m[1]!, { id: m[2]!, options: m[3]! });
  }
  return actions;
}

/** Each registered category's actions, in order, keyed by kind. */
function darwinCategoryActions(): Map<string, Array<{ id: string; options: string }>> {
  const actions = darwinActions();
  const categories = new Map<string, { kind: string; actions: Array<{ id: string; options: string }> }>();
  for (const m of source.matchAll(/UNNotificationCategory\*\s+(\w+)\s*=\s*\[UNNotificationCategory categoryWithIdentifier:@"([^"]+)" actions:@\[([^\]]*)\]/g)) {
    if (categories.has(m[1]!)) throw new Error(`category ${m[1]} is declared twice`);
    const list = m[3]!.split(',').map((v) => v.trim()).filter(Boolean).map((v) => {
      const action = actions.get(v);
      if (!action) throw new Error(`category ${m[2]} names undeclared action ${v}`);
      return action;
    });
    categories.set(m[1]!, { kind: m[2]!, actions: list });
  }
  // Only what is actually registered counts.
  const set = /setNotificationCategories:\[NSSet setWithObjects:([^\]]*?),\s*nil\]\]/.exec(source);
  if (!set) throw new Error('no setNotificationCategories call found');
  const registered = new Map<string, Array<{ id: string; options: string }>>();
  for (const v of set[1]!.split(',').map((s) => s.trim())) {
    const c = categories.get(v);
    if (!c) throw new Error(`setNotificationCategories names undeclared category ${v}`);
    if (registered.has(c.kind)) throw new Error(`kind ${c.kind} is registered twice`);
    registered.set(c.kind, c.actions);
  }
  return registered;
}

/** Each registered category's action identifiers, in order, keyed by kind. */
function darwinCategories(): Map<string, string[]> {
  return new Map([...darwinCategoryActions()].map(([kind, actions]) => [kind, actions.map((a) => a.id)]));
}

function request(reason: string): ApprovalRequest {
  return {
    id: '3f2a9b1c-4d5e-4f60-8a7b-9c0d1e2f3a4b', agent_id: 'a', agent_name: 'PA',
    tool_name: 'request_approval', tool_arguments: '{}', action_category: 'send_email',
    urgency: 'normal', reason, context: '', status: 'pending', execution_mode: 'deferred',
    decided_at: null, decided_by: null, executed_at: null, execution_result: null, created_at: 0,
  } as ApprovalRequest;
}

describe('#808: every toast kind the brain sends has a macOS category', () => {
  test('the parser finds the categories it should', () => {
    // Guards the test itself: a parse that found nothing would pass the rest.
    expect(darwinCategories().get('approval')).toEqual(['deny', 'approve']);
  });

  test.each<[string, ApprovalRequest, ApprovalToast['kind']]>([
    ['approvable', request('Send the weekly update'), 'approval'],
    ['review-only (too long)', request(`Send the quarterly numbers to ${'everyone@example.com, '.repeat(10)}`), 'approval_review'],
    ['review-only (look-alike)', request('Pay 500 EUR to pаypal.com'), 'approval_review'],
  ])('an approval toast, %s, gets exactly the buttons its payload lists', (_label, req, kind) => {
    const toast = approvalToast(req);
    expect(toast.kind).toBe(kind);
    expect(darwinCategories().get(toast.kind)).toEqual(toast.actions.map((a) => a.id));
  });

  test('review-only is Open Jarvis, brought to the front, and Dismiss', () => {
    expect(darwinCategoryActions().get('approval_review')).toEqual([
      { id: 'review', options: 'UNNotificationActionOptionForeground' },
      { id: 'dismiss', options: 'UNNotificationActionOptionNone' },
    ]);
  });

  test('the other kinds the brain raises are registered too', () => {
    const kinds = darwinCategories();
    for (const kind of ['done', 'sidecar', 'update', 'usage']) expect(kinds.has(kind)).toBe(true);
  });
});
