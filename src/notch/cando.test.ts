/**
 * The sheet of what the notch can do promises nothing the product does not
 * take: every sentence it quotes is put to the code that reads it.
 */
import { describe, expect, test } from 'bun:test';
import { agentSentence } from './agents.ts';
import { rememberSentence } from './asks.ts';
import { callRequest } from './call.ts';
import { NOTCH_CAN, canDoBlocks, canDoRequest } from './cando.ts';
import { memoryRequest } from './memory.ts';
import { whereQuestion } from './point.ts';
import { putRequest } from './put.ts';
import { chaseRequest, eyeRequest } from './standing.ts';
import { runItRequest, teachDoneWord, watchMeRequest } from './teach.ts';

const TAKES: Record<string, (words: string) => boolean> = {
  where: (words) => whereQuestion(words),
  put: (words) => putRequest(words),
  watch: (words) => watchMeRequest(words),
  done: (words) => teachDoneWord(words),
  run: (words) => runItRequest(words) !== null,
  eye: (words) => eyeRequest(words) !== null,
  chase: (words) => chaseRequest(words) !== null,
  agent: (words) => agentSentence(words) !== null,
  remember: (words) => rememberSentence(words) !== null,
  memory: (words) => memoryRequest(words) !== null,
  call: (words) => callRequest(words),
};

describe('what I can do', () => {
  test('every sentence a row quotes is one the product takes', () => {
    const tried: string[] = [];
    for (const can of NOTCH_CAN) {
      for (const one of can.tries ?? []) {
        tried.push(one.words);
        expect([can.id, one.words, TAKES[one.by]!(one.words)]).toEqual([can.id, one.words, true]);
      }
    }
    expect(tried.length).toBeGreaterThanOrEqual(11);
  });

  test('every sentence a row says to say is one it was tried with', () => {
    // A quoted sentence in a row is an emphasised part between two quote marks.
    for (const can of NOTCH_CAN) {
      const quoted = can.say.filter((part, at) => typeof part === 'object' && 'em' in part && typeof can.say[at - 1] === 'string' && (can.say[at - 1] as string).endsWith('"'))
        .map((part) => (part as { em: string }).em);
      const tries = new Set((can.tries ?? []).map((one) => one.words));
      // "tell me" is a word on a draft, pressed, not a sentence that is said.
      for (const words of quoted) if (can.id !== 'mail') expect([can.id, words, tries.has(words)]).toEqual([can.id, words, true]);
    }
  });

  test('it names the things the owner said were missing, and the ones he did not think of', () => {
    const ids = NOTCH_CAN.map((can) => can.id);
    for (const id of ['file', 'where', 'look', 'put', 'watch', 'twice', 'notice', 'eye', 'chase', 'agent', 'memory', 'mail', 'call', 'quiet', 'home', 'talk', 'yes']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    const blocks = canDoBlocks();
    expect(blocks.filter((block) => block.kind === 'row').length).toBe(NOTCH_CAN.length);
  });

  test('the words that open it', () => {
    expect(canDoRequest('What can you do?')).toBe(true);
    expect(canDoRequest('help')).toBe(true);
    expect(canDoRequest('hey jarvis, what can I ask')).toBe(true);
    expect(canDoRequest('what can you do about the invoice from Northwind')).toBe(false);
    expect(canDoRequest('help me write a reply to Sam')).toBe(false);
  });
});
