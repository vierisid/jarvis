/**
 * Where a standing is made, tied to a turn and handed over (./standing.ts).
 * Each is one place. This file reads the source and fails when a second one
 * appears, so that a new caller is a decision somebody made and not a line
 * nobody noticed.
 */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');
const files = [...new Glob('**/*.ts').scanSync({ cwd: SRC })].filter((file) => !file.includes('node_modules')).sort();
const product = files.filter((file) => !/\.test\.ts$/.test(file) && file !== 'authority/standing-fixture.ts');
const read = (file: string): string => readFileSync(join(SRC, file), 'utf8');
/** The product files, other than the one that defines it, in which `pattern` is found. */
const sites = (pattern: RegExp): string[] => product.filter((file) => file !== 'authority/standing.ts' && pattern.test(read(file)));

describe('one place each', () => {
  test('the source was found', () => {
    expect(product.length).toBeGreaterThan(500);
    expect(product).toContain('notch/asks.ts');
    expect(product).toContain('brief/chat-transport.ts');
  });

  test('a standing is made by the notch\'s asking and nowhere else', () => {
    expect(sites(/\bmintStanding\b/)).toEqual(['notch/asks.ts']);
    // Once in that file beside its import: where an instruction becomes a turn.
    expect(read('notch/asks.ts').match(/\bmintStanding\(/g)).toHaveLength(1);
  });

  test('it is tied to a turn by the turn store and nowhere else', () => {
    expect(sites(/\bgrantStanding\b/)).toEqual(['brief/chat-transport.ts']);
    expect(read('brief/chat-transport.ts').match(/\bgrantStanding\(/g)).toHaveLength(1);
  });

  test('only the notch\'s door hands one to the turn store', () => {
    // Every in-process submit to the turn store. Today there is one caller, and it passes on what the notch gave it.
    const submits = product.filter((file) => /\btransport\.submit\(/.test(read(file)));
    expect(submits).toEqual(['daemon/notch-asks.ts']);
  });

  test('the turn store takes one from its in-process door only: the socket message has no field for it', () => {
    const transport = read('brief/chat-transport.ts');
    const send = transport.slice(transport.indexOf("case 'brief_chat_send'"), transport.indexOf("case 'brief_chat_cancel'"));
    expect(send).toContain("fields(message.payload, ['conversationId', 'turnId', 'requestId', 'text', 'speak', 'attachmentIds'])");
    expect(send).not.toMatch(/standing/i);
    // The socket path schedules a turn with no fourth argument: no standing.
    expect(send).toMatch(/this\.schedule\(accepted\.turn, client,\s*[^;]*chatProgress\.enabled\);/);
  });

  test('nobody reads standing off the way an id is written any more', () => {
    expect(sites(/NOTCH_REQUEST_ID/)).toEqual([]);
    expect(product.filter((file) => /notch-\(typed\|spoken\)/.test(read(file)))).toEqual([]);
    expect(read('authority/app-open.ts')).not.toMatch(/requestId/);
  });

  test('the test fixture that makes a standing is imported by tests only', () => {
    expect(product.filter((file) => /standing-fixture/.test(read(file)))).toEqual([]);
  });
});
