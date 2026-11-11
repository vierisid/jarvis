/**
 * #1153: inline HTTP and GraphQL step credentials outside the approval path.
 * Run history, sample data and the version the model reads keep them
 * redacted, and a draft edit can neither reveal one nor send one elsewhere.
 */
import { describe, expect, test } from 'bun:test';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { draftRevision } from '../../actions/tools/workflow-draft-update';
import { credentialEditRefusal, redactFailedStepMessage, redactRunSteps, restoreRedactedCredentials, runAsShown, stepsAsShown, versionAsModelSees } from './step-credentials';

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
  steps = steps.map((x) => structuredClone(x));
  const root: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', settings: {} } as FlowTriggerNode;
  let at = root;
  for (const s of steps) { at.nextAction = s; at = s; }
  return root;
};
const shows = (value: unknown) => SECRETS.filter((secret) => JSON.stringify(value).includes(secret));
/** An edit as the update path makes it: applied to the draft as the model reads it, then the stored credentials put back. */
const edit = (saved: FlowTriggerNode, change: (g: FlowTriggerNode) => void) => {
  const g = versionAsModelSees({ trigger: saved }).trigger as FlowTriggerNode;
  change(g);
  return credentialEditRefusal(saved, g, restoreRedactedCredentials(saved, g));
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

  test('#1153 review: a form-data body a failed request echoes is hidden whole', () => {
    const echoed = JSON.stringify({ response: { status: 401 }, request: { body: { _boundary: 'b', _streams: ['name=\"password\"\r\n\r\n', 'hunter2-SECRET', null] } } });
    expect(redactFailedStepMessage('call', echoed, graph(step('call')))).not.toContain('hunter2-SECRET');
    const out = redactRunSteps({ call: { output: { type: 'PIECE', status: 'SUCCEEDED', input: input(), output: JSON.parse(echoed) } } }, graph(step('call')));
    expect(JSON.stringify(out)).not.toContain('hunter2-SECRET');
  });

  test('#1153 review: a value is a scheme credential only as a scheme and one token, not as prose', () => {
    const g = graph(step('call', { input: { ...input(), body_type: 'json', body: { data: { note: 'Basic plan upgrade', a: 'Key takeaways', b: 'Token expired.', c: 'Basic membership', other: 'SSWS 00abcdefghij' } } } }));
    const seen = JSON.stringify(versionAsModelSees({ trigger: g }));
    for (const prose of ['Basic plan upgrade', 'Key takeaways', 'Token expired.', 'Basic membership']) expect(seen).toContain(prose);
    const tokens = { a: 'Basic dXNlcjpwYXNz', b: 'Bearer abcdefghijklmnopqrstuvwxyzABCDEF', c: 'Token 1234567890123456', d: 'Bearer abc12345' };
    const hidden = JSON.stringify(versionAsModelSees({ trigger: graph(step('call', { input: { ...input(), body_type: 'json', body: { data: tokens } } })) }));
    for (const value of Object.values(tokens)) expect(hidden).not.toContain(value.split(' ')[1]!);
    expect(seen).not.toContain('00abcdefghij');
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
    expect(credentialEditRefusal(saved, g, restoreRedactedCredentials(saved, g))).toMatch(/would store \[redacted\]/);
    (g.nextAction!.settings!.input as Record<string, unknown>).url = 'https://api.example.com/x?api_key=[redacted]';
    const restored = restoreRedactedCredentials(saved, g);
    expect(credentialEditRefusal(saved, g, restored)).toBeNull();
    expect(restored.nextAction!.settings!.input).toEqual({ ...input(), headers: { Authorization: 'Bearer t0ken-in-header', Accept: 'text/plain' } });
  });

  test('changing the piece while keeping the credential fields: refused, since nothing can put them back', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.pieceName = 'jarvis-notify'; g.nextAction!.settings!.actionName = 'notify'; }))
      .toMatch(/would store \[redacted\]/);
  });

  test('changing the action to parse_url would show the URL in its output: refused', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.actionName = 'parse_url'; })).toMatch(/would show a stored credential/);
  });

  test('renaming a form field away from a credential name would show its value: refused', () => {
    expect(edit(saved, (g) => { ((g.nextAction!.settings!.input!.body as { data: Array<Record<string, unknown>> }).data[0]!).fieldName = 'comment'; }))
      .toMatch(/would show a stored credential/);
  });

  test('pointing a step that keeps its credentials at another host: refused; the same host on another path is allowed', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = 'https://attacker.example/x'; })).toMatch(/to another address/);
    // #1153 review: the scheme counts, and a URL filled in at run time may not change at all.
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = 'http://api.example.com/x?api_key=[redacted]'; })).not.toBeNull();
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = '{{trigger.body.callback}}'; })).toMatch(/to another address/);
    const templated = graph(step('call', { input: { ...input(), url: '{{step_1.base}}/me' } }));
    expect(edit(templated, (g) => { g.nextAction!.settings!.input!.url = '{{trigger.body.callback}}'; })).toMatch(/to another address/);
    expect(edit(templated, (g) => { g.nextAction!.settings!.input!.method = 'PUT'; })).toBeNull();
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.url = 'https://api.example.com/other?api_key=[redacted]'; }))
      .toMatch(/would store \[redacted\]/);
    expect(edit(saved, (g) => { g.nextAction!.settings!.input!.method = 'PUT'; })).toBeNull();
  });

  test('#1153 review: text the model writes itself is never judged, so a refusal cannot confirm a guessed credential', () => {
    const two = graph(step('call'), { name: 'note', type: 'PIECE', settings: { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'hi' } } } as FlowTriggerNode);
    for (const guess of ['wrong-guess', 'pa55-in-auth', 'Basic pa55-in-auth']) {
      expect(edit(two, (g) => { g.nextAction!.nextAction!.settings!.input!.message = guess; })).toBeNull();
    }
  });

  test('#1153 review: a step left as saved is not judged, so an existing parse_url step does not block other edits', () => {
    const withParse = graph(step('parse', { actionName: 'parse_url', input: { url: 'https://api.example.com/x?api_key=k3y-in-url' } }), step('call'));
    expect(edit(withParse, (g) => { g.nextAction!.nextAction!.settings!.input!.method = 'PUT'; })).toBeNull();
  });

  test('a hook token in the URL path is kept on a method edit and refused on a path edit; a URL with no hidden part stays editable', () => {
    const hooked = graph(step('call', { input: { method: 'POST', url: 'https://chat.example.com/hooks/Zx8Yw7Vu6Ts5Rq4Po3', headers: {} } }));
    const seen = versionAsModelSees({ trigger: hooked }).trigger as FlowTriggerNode;
    expect(JSON.stringify(seen)).not.toContain('Zx8Yw7Vu6Ts5Rq4Po3');
    const g = structuredClone(seen);
    g.nextAction!.settings!.input!.method = 'PUT';
    const restored = restoreRedactedCredentials(hooked, g);
    expect(credentialEditRefusal(hooked, g, restored)).toBeNull();
    expect(restored.nextAction!.settings!.input!.url).toBe('https://chat.example.com/hooks/Zx8Yw7Vu6Ts5Rq4Po3');
    expect(edit(hooked, (h) => { h.nextAction!.settings!.input!.url = 'https://chat.example.com/hooks/[redacted]/x'; })).toMatch(/would store \[redacted\]/);
    const plain = graph(step('call', { input: { method: 'GET', url: 'https://api.example.com/v1/auth/users/u123abc/roles', headers: {} } }));
    expect(edit(plain, (h) => { h.nextAction!.settings!.input!.url = 'https://api.example.com/v1/auth/users/u123abc/perms'; })).toBeNull();
  });

  test('replacing the step with one that holds none of the credentials is allowed', () => {
    expect(edit(saved, (g) => { g.nextAction!.settings = { pieceName: 'jarvis-notify', actionName: 'notify', input: { message: 'hi' } }; })).toBeNull();
  });
});

test('#1153 review: the model reads neither a webhook secret nor its scheme, which the save rules derive from whether the secret is stored', () => {
  const seen = versionAsModelSees({ trigger: { name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { secret: 'whsec-x', signature_scheme: 'timestamped', other: 1 } } } });
  expect((seen.trigger as FlowTriggerNode).settings!.input).toEqual({ secret: '[redacted]', other: 1 });
});

describe('what a run shows of webhook headers stored before the trigger withheld them', () => {
  const webhookGraph = (...steps: FlowTriggerNode[]): FlowTriggerNode => {
    const root = graph(...steps);
    root.type = 'PIECE_TRIGGER' as FlowTriggerNode['type'];
    root.settings = { pieceName: 'webhook', triggerName: 'catch_webhook', input: {} } as FlowTriggerNode['settings'];
    return root;
  };
  const stored = () => ({
    trigger: { output: { type: 'PIECE_TRIGGER', status: 'SUCCEEDED', input: {}, output: { order: 1, _webhook: { method: 'POST', url: 'https://x/api/webhooks/f', headers: {
      authorization: 'Bearer sk-live-OLDSECRET99', cookie: 'session=COOKIESECRET', 'x-hub-signature-256': 'sha256=SIGSECRET1',
      'x-custom': 'Basic dXNlcjpPTERTRUNSRVQ=', 'content-type': 'application/json', 'x-github-event': 'push', 'idempotency-key': 'idem-1' } } } } },
    // A step that passed the header on, and one that echoed the whole trigger.
    forward: { output: { type: 'PIECE', status: 'SUCCEEDED', input: { note: 'auth was Bearer sk-live-OLDSECRET99' }, output: { echoed: 'sk-live-OLDSECRET99' } } },
    echo: { output: { type: 'PIECE', status: 'SUCCEEDED', input: {}, output: { trigger: { _webhook: { headers: { Cookie: 'session=COOKIESECRET' } } } } } },
  });
  const LEAKS = ['OLDSECRET99', 'COOKIESECRET', 'SIGSECRET1', 'dXNlcjpPTERTRUNSRVQ='];

  test('credential headers are withheld by name and shape wherever the run holds them, others kept, the stored value untouched', () => {
    const steps = stored();
    const before = JSON.stringify(steps);
    const run = { steps, failedStep: { name: 'forward', displayName: 'Forward', errorMessage: 'rejected Bearer sk-live-OLDSECRET99' } };
    const shown = runAsShown(run, webhookGraph(step('forward'), step('echo')));
    const text = JSON.stringify(shown);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
    expect(text).toContain('"content-type":"application/json"');
    expect(text).toContain('"x-github-event":"push"');
    expect(text).toContain('"idempotency-key":"idem-1"');
    expect(text).toContain('"authorization":"[redacted]"');
    expect(shown.failedStep.errorMessage).toBe('rejected [redacted]');
    // Read side only: the caller's (stored) object is not rewritten.
    expect(JSON.stringify(steps)).toBe(before);
    expect(runAsShown(shown, webhookGraph(step('forward'), step('echo')))).toEqual(shown);
  });

  test('sample data copied from such a run is shown the same way, to the model and to the editor', async () => {
    const { versionAsShown } = await import('../api/editor-version');
    const trigger = webhookGraph(step('forward'));
    const sampleData = Object.fromEntries(Object.entries(stored()).map(([name, value]) => [name, value.output]));
    for (const seen of [versionAsModelSees({ trigger, sampleData }), versionAsShown({ trigger, sampleData })]) {
      const text = JSON.stringify(seen.sampleData);
      for (const leak of LEAKS) expect(text).not.toContain(leak);
      expect(text).toContain('"x-github-event":"push"');
    }
  });
});

describe('what a run shows of a generated password', () => {
  const CRYPTO = '@activepieces/piece-crypto';
  const pw = (name: string): FlowTriggerNode => ({ name, type: 'PIECE',
    settings: { pieceName: CRYPTO, actionName: 'generate-password', input: { length: 24, characterSet: 'alphanumeric' } } } as FlowTriggerNode);
  const PASSWORD = 'Xq7RkP2mVz9LtB4nWc8Hs1Jd';

  test('the generator output is withheld, and so is the password where a later step used it; the stored steps keep it', () => {
    const steps = {
      make_pw: { output: { type: 'PIECE', status: 'SUCCEEDED', input: { length: 24, characterSet: 'alphanumeric' }, output: PASSWORD } },
      create_user: { output: { type: 'PIECE', status: 'SUCCEEDED', input: { body: { password: PASSWORD, name: 'Ann' } }, output: { ok: true } } },
    };
    const run = { steps, failedStep: { name: 'create_user', displayName: 'Create', errorMessage: `rejected ${PASSWORD}` } };
    const shown = runAsShown(run, graph(pw('make_pw'), step('create_user')));
    expect(JSON.stringify(shown)).not.toContain(PASSWORD);
    expect((shown.steps.make_pw as { output: { output: unknown } }).output.output).toBe('[redacted]');
    expect(JSON.stringify(shown.steps.create_user)).toContain('"name":"Ann"');
    expect(shown.failedStep.errorMessage).toBe('rejected [redacted]');
    // Stored as generated: the engine and a resumed run read the real value.
    expect(steps.make_pw.output.output).toBe(PASSWORD);
    expect(runAsShown(shown, graph(pw('make_pw'), step('create_user')))).toEqual(shown);
  });

  test('inside a loop and in sample data too; another piece with the same output is shown as it is', () => {
    const loop = { name: 'each', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' }, firstLoopAction: pw('inner_pw') } as unknown as FlowTriggerNode;
    const steps = { each: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', input: {}, output: { iterations: [
      { inner_pw: { type: 'PIECE', status: 'SUCCEEDED', input: {}, output: PASSWORD } }] } },
      other: { type: 'PIECE', status: 'SUCCEEDED', input: {}, output: 'not-a-secret-123456' } };
    const shown = stepsAsShown(steps, graph(loop, step('other'))).steps;
    expect(JSON.stringify(shown)).not.toContain(PASSWORD);
    expect(JSON.stringify(shown)).toContain('not-a-secret-123456');
    const seen = versionAsModelSees({ trigger: graph(pw('make_pw')), sampleData: { make_pw: { type: 'PIECE', status: 'SUCCEEDED', output: PASSWORD } } });
    expect(JSON.stringify(seen)).not.toContain(PASSWORD);
  });
});

describe('what else a run hides of its secrets, and what it leaves alone', () => {
  const hook = (headers: Record<string, string>) => ({ trigger: { type: 'EMPTY', status: 'SUCCEEDED', input: {}, output: { _webhook: { headers } } } });
  const shownText = (steps: Record<string, unknown>) => JSON.stringify(stepsAsShown(steps, graph()).steps);

  test('URL-encoded forms, single cookie values and signatures without their prefix are hidden elsewhere', () => {
    const text = shownText({ ...hook({ authorization: 'Bearer ab&c=d+e/f12', cookie: 'sid=COOKIEVAL123; theme=dark', 'x-hub-signature-256': 'sha256=abcdef0123456789' }),
      later: { type: 'PIECE', status: 'SUCCEEDED', input: { url: `https://x.test/?t=${encodeURIComponent('ab&c=d+e/f12')}`, sid: 'COOKIEVAL123', sig: 'abcdef0123456789' }, output: {} } });
    for (const leak of ['ab%26c%3Dd%2Be%2Ff12', 'COOKIEVAL123', 'abcdef0123456789']) expect(text).not.toContain(leak);
  });

  test('a timestamp, a number and a placeholder value are withheld in the headers but do not blank ordinary text', () => {
    const text = shownText({ ...hook({ 'x-jarvis-timestamp': '1731325000', authorization: 'Bearer undefined', 'x-api-key': '123456789' }),
      later: { type: 'PIECE', status: 'SUCCEEDED', input: { note: 'order 1731325000 placed, value undefined, id 123456789' }, output: {} } });
    expect(text).toContain('order 1731325000 placed, value undefined, id 123456789');
    expect(text).toContain('"x-jarvis-timestamp":"[redacted]"');
  });

  test('thousands of generated passwords in a loop are hidden in one pass', () => {
    const loop = { name: 'each', type: 'LOOP_ON_ITEMS', settings: {}, firstLoopAction: { name: 'pw', type: 'PIECE',
      settings: { pieceName: '@activepieces/piece-crypto', actionName: 'generate-password', input: {} } } } as unknown as FlowTriggerNode;
    const iterations = Array.from({ length: 3000 }, (_, i) => ({ pw: { type: 'PIECE', status: 'SUCCEEDED', input: {}, output: `Pw${i}x7Kq9Lm2Zt` },
      use: { type: 'PIECE', status: 'SUCCEEDED', input: { body: `password Pw${i}x7Kq9Lm2Zt for user ${i}` }, output: {} } }));
    const started = performance.now();
    const shown = JSON.stringify(stepsAsShown({ each: { type: 'LOOP_ON_ITEMS', status: 'SUCCEEDED', input: {}, output: { iterations } } }, graph(loop)).steps);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(shown).not.toMatch(/Pw\d+x7Kq9Lm2Zt/u);
    expect(shown).toContain('password [redacted] for user 2999');
  });
});
