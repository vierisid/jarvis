/**
 * #1153: inline HTTP and GraphQL step credentials outside the approval path.
 * Run history, sample data and the version the model reads keep them
 * redacted, and a draft edit can neither reveal one nor send one elsewhere.
 */
import { describe, expect, test } from 'bun:test';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { draftRevision } from '../../actions/tools/workflow-draft-update';
import { credentialEditRefusal, redactFailedStepMessage, redactRunSteps, restoreRedactedCredentials, versionAsModelSees } from './step-credentials';

const HTTP = '@activepieces/piece-http';
const GRAPHQL = '@activepieces/piece-graphql';
const SECRETS = ['k3y-in-url', 't0ken-in-header', 'pa55-in-auth', 'f0rm-secret'];

const input = () => ({
  method: 'POST', url: 'https://api.example.com/x?api_key=k3y-in-url',
  headers: { Authorization: 'Bearer t0ken-in-header', Accept: 'application/json' },
  authType: 'BASIC', authFields: { username: 'me', password: 'pa55-in-auth' },
  body_type: 'form_data', body: { data: [{ fieldName: 'client_secret', textFieldValue: 'f0rm-secret' }, { fieldName: 'note', textFieldValue: 'hi' }] },
});
const step = (name: string, extra: Record<string, unknown> = {}): FlowTriggerNode => ({ name, type: 'PIECE',
  settings: { pieceName: HTTP, actionName: 'send_request', input: input(), ...extra } } as FlowTriggerNode);
const graph = (...steps: FlowTriggerNode[]): FlowTriggerNode => {
  const root: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', settings: {} } as FlowTriggerNode;
  let at = root;
  for (const s of steps) { at.nextAction = s; at = s; }
  return root;
};
const shows = (value: unknown) => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));
/** A JSON-patch edit: applied to the saved draft, so what it leaves untouched keeps its stored value. */
const edit = (saved: FlowTriggerNode, change: (g: FlowTriggerNode) => void) => {
  const g = structuredClone(saved);
  change(g);
  return credentialEditRefusal(saved, restoreRedactedCredentials(saved, g));
};

describe('what the model reads', () => {
  test('inputs, sample data and sample inputs are redacted; a router branch and GraphQL variables too', () => {
    const gql = { name: 'gql', type: 'PIECE', settings: { pieceName: GRAPHQL, actionName: 'send_request',
      input: { url: 'https://api.example.com/graphql', headers: {}, variables: { password: 'pa55-in-auth' } } } } as FlowTriggerNode;
    const router = { name: 'route', type: 'ROUTER', settings: {}, children: [step('branch'), gql] } as unknown as FlowTriggerNode;
    const version = { trigger: graph(router), sampleData: { branch: { type: 'PIECE', status: 'SUCCEEDED', input: input(), output: {} } },
      sampleInput: { branch: input() } };
    const seen = versionAsModelSees(version);
    expect(shows(seen)).toEqual([]);
    // Redacted, not dropped, and a second pass changes nothing.
    expect(JSON.stringify(seen)).toContain('api_key=[redacted]');
    expect(versionAsModelSees(seen)).toEqual(seen);
  });

  test('a recorded step the graph no longer names is redacted by its shape', () => {
    const recorded = { call_old: { output: { type: 'PIECE', status: 'SUCCEEDED', input: input(), output: {} } } };
    expect(shows(redactRunSteps(recorded, graph(step('call_new'))))).toEqual([]);
    expect(shows(versionAsModelSees({ trigger: graph(step('call_new')), sampleData: { call_old: recorded.call_old.output } }))).toEqual([]);
  });

  test('a failed request echoes the body it sent: redacted in the output, the step error and the run failure', () => {
    const echoed = JSON.stringify({ response: { status: 401, body: 'no' }, request: { body: { username: 'me', password: 'pa55-in-auth' } } });
    const recorded = { call: { output: { type: 'PIECE', status: 'FAILED', input: input(), errorMessage: echoed,
      output: { response: { status: 401 }, request: { body: { password: 'pa55-in-auth' } } } } } };
    const out = redactRunSteps(recorded, graph(step('call')));
    expect(shows(out)).toEqual([]);
    expect(redactRunSteps(out, graph(step('call')))).toEqual(out);
    expect(redactFailedStepMessage('call', echoed, graph(step('call')))).not.toContain('pa55-in-auth');
    expect(redactFailedStepMessage('call', 'username=me&password=pa55-in-auth', graph(step('call')))).not.toContain('pa55-in-auth');
  });

  test('a credential deep in a body, or carrying its scheme under any name, is redacted', () => {
    let deep: Record<string, unknown> = { password: 'pa55-in-auth' };
    for (let i = 0; i < 8; i++) deep = { level: deep };
    const g = graph(step('call', { input: { ...input(), body_type: 'json', body: { data: deep }, headers: { 'X-Custom': 'Bearer t0ken-in-header' } } }));
    expect(shows(versionAsModelSees({ trigger: g }))).toEqual([]);
  });

  test('the draft revision is not a hash over the stored credentials', () => {
    const base = { id: 'v', flowId: 'f', trigger: graph(step('call')) } as never;
    const changed = { id: 'v', flowId: 'f', trigger: graph(step('call', { input: { ...input(), authFields: { username: 'me', password: 'other' } } })) } as never;
    expect(draftRevision(changed)).toBe(draftRevision(base));
    // Anything the model can see still changes it.
    const visible = { id: 'v', flowId: 'f', trigger: graph(step('call', { input: { ...input(), method: 'PUT' } })) } as never;
    expect(draftRevision(visible)).not.toBe(draftRevision(base));
  });
});

describe('a draft edit (credentialEditRefusal after restore)', () => {
  const saved = graph(step('call'));
  test('writing back the redacted view, changed elsewhere, keeps the credentials and is allowed', () => {
    const g = versionAsModelSees({ trigger: saved }).trigger as FlowTriggerNode;
    (g.nextAction!.settings!.input!.headers as Record<string, string>).Accept = 'text/plain';
    (g.nextAction!.settings!.input as Record<string, unknown>).url = 'https://api.example.com/y?api_key=[redacted]';
    // A changed URL holding the marker is refused; the same URL is restored.
    expect(credentialEditRefusal(saved, restoreRedactedCredentials(saved, g))).toMatch(/would store \[redacted\]/);
    (g.nextAction!.settings!.input as Record<string, unknown>).url = 'https://api.example.com/x?api_key=[redacted]';
    const restored = restoreRedactedCredentials(saved, g);
    expect(credentialEditRefusal(saved, restored)).toBeNull();
    expect(restored.nextAction!.settings!.input).toEqual({ ...input(), headers: { Authorization: 'Bearer t0ken-in-header', Accept: 'text/plain' } });
  });

  test('changing the piece would show the stored input: refused', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.pieceName = 'jarvis-notify'; g.nextAction!.settings!.actionName = 'notify'; }))
      .toMatch(/would show a stored credential/);
  });

  test('changing the action to parse_url would show the URL in its output: refused', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.actionName = 'parse_url'; })).toMatch(/would show a stored credential/);
  });

  test('renaming a form field away from a credential name would show its value: refused', () => {
    expect(edit(saved, (g) => { ((g.nextAction!.settings!.input!.body as { data: Array<Record<string, unknown>> }).data[0]!).fieldName = 'comment'; }))
      .toMatch(/would show a stored credential/);
  });

  test('pointing a step that keeps its credentials at another host: refused; the same host on another path is allowed', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = 'https://attacker.example/x'; })).toMatch(/to another host/);
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = 'https://api.example.com/other?api_key=[redacted]'; }))
      .toMatch(/would store \[redacted\]/);
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.method = 'PUT'; })).toBeNull();
  });

  test('replacing the step with one that holds none of the credentials is allowed', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings = { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'hi' } }; })).toBeNull();
  });
});

test('#1153 review: the model reads neither a webhook secret nor its scheme, which the save rules derive from whether the secret is stored', () => {
  const seen = versionAsModelSees({ trigger: { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { secret: 'whsec-x', signature_scheme: 'timestamped', other: 1 } } } });
  expect((seen.trigger as FlowTriggerNode).settings!.input).toEqual({ secret: '[redacted]', other: 1 });
});
