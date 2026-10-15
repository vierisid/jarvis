import { expect, test } from 'bun:test';
import { composeFlow, type ComposerChatMessage } from '../actions/tools/workflow-composer';
import { sampleCatalog } from '../workflows/runtime/test-fixtures';
import { UNTRUSTED_OPEN, untrustedClose, unsafeUntrustedNoncesForTests } from '../roles/untrusted';
import { attacks } from './fixtures';

const flow = { displayName: 'Review draft', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } };
const request = { name: 'Review draft', description: 'Prepare only a local draft. Do not send or enable it.' };
// The frame starts before data; an attacker-supplied delimiter is never used
// to locate its boundary. JSON samples escape line breaks, so check both forms.
function framed(prompt: string, source: string, payload: string) {
  const opening = prompt.split('\n').find(line => line.startsWith(UNTRUSTED_OPEN + ' ') && line.endsWith(`source="${source}"`))!;
  expect(opening).toBeDefined();
  const nonce = unsafeUntrustedNoncesForTests(opening)[0]!;
  expect(nonce).not.toBe('attacker');
  const start = prompt.indexOf(opening) + opening.length + 1;
  const end = prompt.indexOf(untrustedClose(nonce), start);
  expect(end).toBeGreaterThan(start);
  const body = prompt.slice(start, end);
  expect(body.includes(payload) || body.includes(JSON.stringify(payload).slice(1, -1))).toBe(true);
  expect(prompt.slice(0, start).includes(payload)).toBe(false);
  expect(prompt.slice(end).includes(payload)).toBe(false);
}

for (const attack of attacks) {
  test(`${attack.id}: one-shot catalog and repair data cannot print outside their frames`, async () => {
    const catalog = sampleCatalog();
    catalog.list()[0]!.description = attack.text;
    catalog.list()[0]!.actions.ask!.outputSample = { [attack.text]: 'synthetic' };
    let calls = 0;
    const result = await composeFlow({ pieceRegistry: catalog, llm: { async chat({ prompt, system }) {
      framed(system!, 'installed piece catalog', attack.text);
      framed(prompt, 'workflow composition context', request.description);
      if (++calls === 1) return { text: attack.text };
      framed(prompt, 'workflow composition context', attack.text);
      return { text: JSON.stringify(flow) };
    } } }, request);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test(`${attack.id}: tool discovery and fallback retain framing and the original request`, async () => {
    const catalog = sampleCatalog();
    catalog.list()[0]!.actions.ask!.outputSample = { [attack.text]: 'synthetic' };
    const seen: ComposerChatMessage[][] = [];
    const result = await composeFlow({ pieceRegistry: catalog, llm: {
      async chat() { throw new Error('unexpected fallback'); },
      async chatTools(messages) {
        seen.push(structuredClone(messages));
        if (seen.length === 1) return { content: '', tool_calls: [{ id: 'discovery', name: 'get_piece_details', arguments: { pieceName: 'jarvis-ask' } }] };
        framed(messages.at(-1)!.content, 'workflow discovery', attack.text);
        return { content: '', tool_calls: [{ id: 'submit', name: 'submit_flow', arguments: flow }] };
      },
    } }, request);
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    let fallback = false;
    expect((await composeFlow({ pieceRegistry: catalog, llm: {
      async chatTools() { return { content: attack.text, tool_calls: [] }; },
      async chat({ prompt }) {
        fallback = true;
        framed(prompt, 'workflow composition context', attack.text);
        framed(prompt, 'workflow composition context', request.description);
        return { text: JSON.stringify(flow) };
      },
    } }, request)).ok).toBe(true);
    expect(fallback).toBe(true);
  });
}
