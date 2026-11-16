import { expect, test } from 'bun:test';
import { createHostTransport, AwarenessOffError } from './http';
import { createDomainPorts } from './domain-ports';

/** #1314: with screen awareness off, prepared opportunities read as "awareness is off", not as a broken read. */
const transport = (status: number, body: unknown) => createHostTransport((async () =>
  Response.json(body, { status })) as unknown as typeof fetch);

test('an awareness-off answer is its own error, and opportunities say so instead of failing', async () => {
  const off = transport(409, { error: 'Screen awareness is off', code: 'AWARENESS_OFF' });
  await expect(off.json('/api/brief/prepared-opportunities')).rejects.toBeInstanceOf(AwarenessOffError);
  const ports = createDomainPorts('scope', off, { setItem: () => {} });
  const read = await ports.opportunities.read();
  expect(read).toEqual({ status: 'unavailable', reason: expect.stringContaining('Screen awareness is off') });
  // Any other conflict is still a failed read.
  await expect(transport(409, { error: 'x' }).json('/api/x')).rejects.not.toBeInstanceOf(AwarenessOffError);
  off.stop(); 
});

test('Today does not ask for a review of a step the founder already accepted', async () => {
  const row = (workStatus: string, supportedActions: string[]) => ({ decisionId: 'work:w', revision: 'r', kind: 'intent', title: 'Send the shortlist', workStatus, supportedActions });
  const read = async (workStatus: string, supportedActions: string[]) => {
    const http = createHostTransport((async (path: string) => Response.json(path.includes('/document')
      ? { decision: row(workStatus, supportedActions), actions: [], state: 'ready', generation: 1, editable: false, document: null }
      : { state: 'ready', data: { items: [row(workStatus, supportedActions)], nextCursor: null } })) as unknown as typeof fetch);
    const result: any = await createDomainPorts('scope', http, { setItem: () => {} }).decisions.read(); http.stop();
    return result.data[0].paper;
  };
  const accepted = await read('ready', ['mark_done', 'not_doing', 'inspect']);
  const proposed = await read('proposed', ['accept_intent', 'reject_intent', 'inspect']);
  expect(proposed).toMatchObject({ description: 'A proposed next step needs your review.', reviewLabel: 'Review decision' });
  expect(accepted.description).not.toContain('needs your review'); expect(accepted.reviewLabel).toBe('Finish step');
  expect(accepted.document.paragraphs[0]).toContain('done');
  // Accepted workflow work is ready too, but Needs you offers it no finish, so Today does not promise one.
  const workflow = await read('ready', ['inspect']);
  expect(workflow.reviewLabel).not.toBe('Finish step'); expect(workflow.document.paragraphs[0]).not.toContain('mark this step done');
});
