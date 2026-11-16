import { describe, expect, test } from 'bun:test';
import { AGENT_RUNGS, applyAgentRung, isAgentRung } from './agent-rung';

const let_go = { allowed: true, requiresApproval: false, reason: 'allowed at level 10' };
const asks = { allowed: true, requiresApproval: true, reason: 'send_email is governed' };
const refused = { allowed: false, requiresApproval: false, reason: 'delete_data needs level 9' };

describe("an agent's rung", () => {
  test('a workflow that is not one of the notch\'s agents is judged as it always was', () => {
    for (const decision of [let_go, asks, refused]) {
      expect(applyAgentRung(decision, null, ['send_email'])).toBe(decision);
      expect(applyAgentRung(decision, undefined, ['send_email'])).toBe(decision);
    }
  });

  test('a refusal is never turned into a yes, on any rung', () => {
    for (const rung of AGENT_RUNGS) expect(applyAgentRung(refused, rung, ['write_data'])).toBe(refused);
  });

  test('asks first: every step that acts asks, and reading does not', () => {
    for (const category of ['write_data', 'send_email', 'send_message', 'execute_command', 'make_payment', 'control_app'] as const) {
      expect(applyAgentRung(let_go, 'asks first', [category])).toMatchObject({ allowed: true, requiresApproval: true, reason: 'allowed at level 10; this agent asks first' });
    }
    // A notice to the owner alone is a read: it tells, it does not act.
    expect(applyAgentRung(let_go, 'asks first', ['read_data'])).toBe(let_go);
    // Something that reads and writes, acts.
    expect(applyAgentRung(let_go, 'asks first', ['read_data', 'write_data']).requiresApproval).toBe(true);
    // What already asks, asks.
    expect(applyAgentRung(asks, 'asks first', ['send_email'])).toBe(asks);
  });

  test('tells you after, and acts alone: a write, a mail or a message that would only have asked goes without asking', () => {
    for (const rung of ['tells you after', 'acts alone'] as const) {
      for (const category of ['write_data', 'send_email', 'send_message'] as const) {
        const got = applyAgentRung(asks, rung, [category]);
        expect(got).toMatchObject({ allowed: true, requiresApproval: false });
        expect(got.reason).toContain(`the owner lets this agent do that without asking (${rung})`);
      }
      // What would have gone anyway still goes, unchanged.
      expect(applyAgentRung(let_go, rung, ['write_data'])).toBe(let_go);
    }
  });

  test('money and deleting always ask, and so does everything a rung has no say over', () => {
    for (const rung of ['tells you after', 'acts alone'] as const) {
      for (const category of ['make_payment', 'delete_data', 'execute_command', 'install_software', 'modify_settings', 'control_app', 'access_browser', 'spawn_agent', 'terminate_agent'] as const) {
        expect(applyAgentRung(asks, rung, [category])).toBe(asks);
      }
      // One category a rung may not let go is enough: a step that mails and pays, asks.
      expect(applyAgentRung(asks, rung, ['send_email', 'make_payment'])).toBe(asks);
      // And a step that says nothing of what it reaches is not let go on faith.
      expect(applyAgentRung(asks, rung, [])).toBe(asks);
    }
  });

  test('a rung is one of three words', () => {
    expect([...AGENT_RUNGS]).toEqual(['asks first', 'tells you after', 'acts alone']);
    expect(isAgentRung('acts alone')).toBe(true);
    for (const not of ['', 'always', 'ASKS FIRST', null, 3]) expect(isAgentRung(not)).toBe(false);
  });
});
