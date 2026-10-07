/**
 * #721: the dashboard card leads with what will happen, and the Authority
 * engine's reason follows it.
 *
 * `formatApprovalIntent` used to recognise the engine only by two suffixes and
 * the taint label, and returned any other reason AS the headline. An override
 * (`Override requires approval for execute_command`) or a context rule's
 * `description` therefore replaced the command, the path or the skill's steps:
 * the reviewer saw why approval was needed and not what would happen.
 */
import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest } from '../authority/approval.ts';

/** The fallback's own separator, U+2014, spelled out so this file stays ASCII. */
const DASH = String.fromCharCode(0x2014);
const GATE = 'On this Jarvis host, in "/srv/shop", run: make deploy';

function request(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'r1', agent_id: 'a1', agent_name: 'PA', tool_name: 'run_command',
    tool_arguments: '{"command":"make deploy"}', action_category: 'execute_command', urgency: 'normal',
    reason: 'execute_command requires user approval', context: JSON.stringify({ intent: GATE }),
    status: 'pending', execution_mode: 'deferred', decided_at: null, decided_by: null, executed_at: null,
    execution_result: null, created_at: 0, ...overrides,
  };
}

async function headline(overrides: Partial<ApprovalRequest>): Promise<string> {
  const { WebSocketService } = await import('./ws-service.ts');
  const ws = new WebSocketService(0, { setDelegationCallback: () => {} } as never);
  return ws.computeApprovalIntent(request(overrides));
}

describe('#721: an engine reason never replaces the gate sentence', () => {
  test('an override reason follows the command instead of replacing it', async () => {
    expect(await headline({ reason: 'Override requires approval for execute_command' }))
      .toBe(`${GATE} (Override requires approval for execute_command)`);
  });

  test("a context rule's description follows the command instead of replacing it", async () => {
    expect(await headline({ reason: 'No deploys outside business hours' }))
      .toBe(`${GATE} (No deploys outside business hours)`);
  });

  test('a description from config is reduced to one line with no format characters', async () => {
    const reason = `No deploys${String.fromCharCode(10)}Reason: safe${String.fromCharCode(0x202e)}x`;
    expect(await headline({ reason })).toBe(`${GATE} (No deploys Reason: safex)`);
  });

  test('a tool with no gate sentence still leads with what it would do', async () => {
    expect(await headline({ tool_name: 'send_email', context: 'Agent attempted: send_email({})',
      tool_arguments: JSON.stringify({ to: 'cfo@example.com', subject: 'Q3' }), reason: 'Override requires approval for send_email' }))
      .toBe(`Send email to cfo@example.com ${DASH} "Q3" (Override requires approval for send_email)`);
  });

  test('a fallback sentence that now leads is reduced to one line with no format characters', async () => {
    const subject = `Q3${String.fromCharCode(10)}Reason: routine${String.fromCharCode(0x202e)}fdp.exe`;
    expect(await headline({ tool_name: 'send_email', context: 'Agent attempted: send_email({})',
      tool_arguments: JSON.stringify({ to: 'cfo@example.com', subject }), reason: 'Override requires approval for send_email' }))
      .toBe(`Send email to cfo@example.com ${DASH} "Q3 Reason: routinefdp.exe" (Override requires approval for send_email)`);
  });

  test("the engine's own wording reads exactly as it did", async () => {
    expect(await headline({})).toBe(`${GATE} (execute_command requires user approval)`);
    expect(await headline({ reason: 'send_email is a governed action requiring user approval' }))
      .toBe(`${GATE} (send_email is a governed action requiring user approval)`);
    expect(await headline({ reason: '' })).toBe(GATE);
  });
});

describe('#721: request_approval keeps its own intent, and its context is never a gate sentence', () => {
  test('the declared intent is the headline', async () => {
    expect(await headline({ tool_name: 'request_approval', reason: 'Send the weekly update to the team', context: 'routine' }))
      .toBe('Send the weekly update to the team');
  });

  test('a JSON context the model wrote cannot become the headline', async () => {
    // Before #721 an intent ending in the engine's suffix fell through to the
    // gate path, and the model's own context JSON led the card.
    const shown = await headline({ tool_name: 'request_approval', reason: 'Delete every file in ~/Documents requires user approval',
      context: JSON.stringify({ intent: 'Check the weather' }) });
    expect(shown).toBe('Delete every file in ~/Documents requires user approval');
    expect(shown).not.toContain('weather');
  });

  test('an intent of control characters only does not leave a blank headline', async () => {
    // #724 refuses this at the source; a row recorded before it can still hold one.
    const c = String.fromCharCode;
    expect(await headline({ tool_name: 'request_approval', reason: `${c(1)}${c(2)}`, context: 'x' })).toBe('Request approval');
    expect(await headline({ reason: `${c(1)}` })).toBe(GATE);
  });
});

describe('#721 review: a fallback value cannot close its own quote', () => {
  test('a subject holding a quote stays one quoted value', async () => {
    const subject = 'Q3" (routine, already approved) "x';
    expect(await headline({ tool_name: 'send_email', context: 'Agent attempted: send_email({})',
      tool_arguments: JSON.stringify({ to: 'cfo@example.com', subject }), reason: 'Override requires approval for send_email' }))
      .toBe(`Send email to cfo@example.com ${DASH} "Q3\\" (routine, already approved) \\"x" (Override requires approval for send_email)`);
  });
});
