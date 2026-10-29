import { describe, expect, test } from 'bun:test';
import { prepareSubmission, submissionConfig, validSubmissionEmail } from './form-submission';
const config = { idField: 'id', emailField: 'email' };
test('normalizes strings recursively, lowercases email and retains a case-sensitive ID', () => {
  const input = { id: ' A1 ', email: ' ME@Example.COM ', name: ' Test ', nested: { tags: [' x '] } };
  const out = prepareSubmission(input, config);
  expect(out.data).toEqual({ id: 'A1', email: 'me@example.com', name: 'Test', nested: { tags: ['x'] } });
  expect(input.id).toBe(' A1 ');
  expect(out.key).toBe(prepareSubmission({ ...input, id: 'A1' }, config).key);
  expect(out.key).not.toBe(prepareSubmission({ ...input, id: 'a1' }, config).key);
});
for (const id of [undefined, null, '', '   ', {}, [], 'a'.repeat(257)]) test(`rejects missing/invalid ID ${JSON.stringify(id)?.slice(0,30)}`, () => {
  expect(() => prepareSubmission({ id, email: 'me@example.com' }, config)).toThrow('Submission ID');
});
for (const email of ['', 'wrong', '@example.com', 'a@@example.com', 'a b@example.com', 'a..b@example.com', 'a@-example.com', 'a@example..com', 'a@example.com\nBcc:x@y.com']) test(`rejects invalid email ${email}`, () => {
  expect(validSubmissionEmail(email)).toBe(false);
});
test('supports explicit nested field mapping and numeric zero IDs', () => {
  expect(prepareSubmission({ body: { key: 0, contact: 'ME@EXAMPLE.COM' } }, { idField: 'body.key', emailField: 'body.contact' }).data)
    .toEqual({ body: { key: '0', contact: 'me@example.com' } });
});
test('requires both mappings, rejects unsafe/overlapping paths and leaves ordinary webhooks alone', () => {
  expect(submissionConfig({ secret: 'fixture' })).toBeUndefined();
  expect(submissionConfig({ submission_id_field: 'body.id', submission_email_field: 'body.email' })).toEqual({ idField: 'body.id', emailField: 'body.email' });
  for (const path of ['', '__proto__.id', '_webhook.id', 'body[0]', 'body.email']) {
    expect(() => submissionConfig({ submission_id_field: path, submission_email_field: 'body.email' })).toThrow();
  }
  expect(() => submissionConfig({ submission_id_field: 'id' })).toThrow();
});
test('a rejection never names the configured field paths, so an unsigned caller cannot learn the mapping', async () => {
  const nested = { idField: 'form.id', emailField: 'form.email' };
  for (const payload of [{}, { form: 'flat' }, { form: { email: 'me@example.com' } }, { form: { id: 'a1', email: 'bad' } }]) {
    let message = '';
    try { prepareSubmission(payload, nested); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/^Submission/);
    expect(message).not.toContain('form.');
  }
  const { WebhookManager } = await import('../runner/triggers/webhook');
  const webhooks = new WebhookManager();
  webhooks.register('flow-fixture', undefined, undefined, nested);
  const response = await webhooks.handleRequest('flow-fixture', new Request('http://localhost/api/webhooks/flow-fixture', { method: 'POST', body: '{}' }));
  expect(response.status).toBe(422);
  expect(JSON.stringify(await response.json())).not.toContain('form.');
});
