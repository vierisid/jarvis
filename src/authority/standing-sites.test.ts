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

const ROOT = join(import.meta.dir, '..', '..');
/** Everything the brain is made of: its source, and the program that starts it. Named from the repository's root. */
const files = ['src', 'bin'].flatMap((folder) => [...new Glob('**/*.{ts,tsx,js,mjs,cjs}').scanSync({ cwd: join(ROOT, folder) })]
  .filter((file) => !file.includes('node_modules')).map((file) => `${folder}/${file}`)).sort();
const FIXTURE = 'src/authority/standing-fixture.ts';
const STANDING = 'src/authority/standing.ts';
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);
const product = files.filter((file) => !isTest(file) && file !== FIXTURE);
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
/** The product files, other than the one that defines it, in which `pattern` is found. */
const sites = (pattern: RegExp): string[] => product.filter((file) => file !== STANDING && pattern.test(read(file)));
/**
 * A path in quotes that ends in the standing module, however it is reached:
 * import, export from, import(), require. From another folder it is named
 * through `authority/`; beside it, as `./standing`. (notch/standing.ts is
 * another thing: what the person told the notch to do from now on.)
 */
const FROM_ELSEWHERE = /['"`][^'"`\n]*authority\/standing(\.ts|\.js)?['"`]/;
const FROM_BESIDE = /['"`]\.\/standing(\.ts|\.js)?['"`]/;
const namesStanding = (file: string, text: string): boolean => FROM_ELSEWHERE.test(text) || (file.startsWith('src/authority/') && FROM_BESIDE.test(text));
const NAMES_FIXTURE = /standing-fixture/;

describe('one place each', () => {
  test('the source was found', () => {
    expect(product.length).toBeGreaterThan(500);
    expect(product).toContain('src/notch/asks.ts');
    expect(product).toContain('src/brief/chat-transport.ts');
    expect(product).toContain('bin/jarvis.ts');
    expect(product).toContain(STANDING);
  });

  test('a standing is made by the notch\'s asking and nowhere else', () => {
    expect(sites(/\bmintStanding\b/)).toEqual(['src/notch/asks.ts']);
    // Once in that file beside its import: where an instruction becomes a turn.
    expect(read('src/notch/asks.ts').match(/\bmintStanding\(/g)).toHaveLength(1);
  });

  test('it is tied to a turn by the turn store and nowhere else', () => {
    expect(sites(/\bgrantStanding\b/)).toEqual(['src/brief/chat-transport.ts']);
    expect(sites(/\brevokeStanding\b/)).toEqual(['src/brief/chat-transport.ts']);
    expect(read('src/brief/chat-transport.ts').match(/\bgrantStanding\(/g)).toHaveLength(1);
  });

  test('only the notch\'s door hands one to the turn store', () => {
    // Every in-process submit to the turn store. Today there is one caller, and it passes on what the notch gave it.
    const submits = product.filter((file) => /\btransport\.submit\(/.test(read(file)));
    expect(submits).toEqual(['src/daemon/notch-asks.ts']);
  });

  test('the turn store takes one from its in-process door only: the socket message has no field for it', () => {
    const transport = read('src/brief/chat-transport.ts');
    const send = transport.slice(transport.indexOf("case 'brief_chat_send'"), transport.indexOf("case 'brief_chat_cancel'"));
    expect(send).toContain("fields(message.payload, ['conversationId', 'turnId', 'requestId', 'text', 'speak', 'attachmentIds'])");
    expect(send).not.toMatch(/standing/i);
    // The socket path schedules a turn with no fourth argument: no standing.
    expect(send).toMatch(/this\.schedule\(accepted\.turn, client,\s*[^;]*chatProgress\.enabled\);/);
  });

  test('nobody reads standing off the way an id is written any more', () => {
    expect(sites(/NOTCH_REQUEST_ID/)).toEqual([]);
    expect(product.filter((file) => /notch-\(typed\|spoken\)/.test(read(file)))).toEqual([]);
    expect(read('src/authority/app-open.ts')).not.toMatch(/requestId/);
  });

  test('the standing module is named by five files of the product and no other', () => {
    // Who can reach the object at all. A sixth file here is a new reader or a new maker: say which, and why.
    expect(product.filter((file) => file !== STANDING && namesStanding(file, read(file)))).toEqual([
      'src/authority/app-open.ts',
      'src/brief/chat-transport.ts',
      'src/daemon/agent-service.ts',
      'src/daemon/notch-asks.ts',
      'src/notch/asks.ts',
    ]);
    // Not re-exported from anywhere, so that naming another module cannot reach it.
    expect(sites(/export\s+(\*|\{[^}]*\})\s+from\s+['"][^'"]*\/standing(\.ts)?['"]/)).toEqual([]);
    // And the pattern does find a file that names it another way.
    for (const [file, line] of [
      ['src/x/y.ts', "await import('../authority/standing.ts')"], ['src/authority/z.ts', 'require("./standing")'],
      ['src/x/y/z.ts', "from '../../authority/standing'"], ['src/authority/z.ts', "from `./standing.js`"], ['bin/jarvis.ts', "from '../src/authority/standing.ts'"],
    ] as const) {
      expect([line, namesStanding(file, line)]).toEqual([line, true]);
    }
    for (const [file, line] of [
      ['src/authority/z.ts', "from './standing-fixture.ts'"], ['src/notch/real.ts', "from './standing.ts'"], ['src/x/y.ts', "from '../notch/standing.ts'"],
      ['src/x/y.ts', "'a long standing'"],
    ] as const) {
      expect([line, namesStanding(file, line)]).toEqual([line, false]);
    }
  });

  test('what a turn\'s words cover is read off its standing in one place, and what it has read is said by the two tool loops', () => {
    // The standing with its words leaves app-open.ts by one function, and one file asks it.
    expect(sites(/\bownersTurn\b/)).toEqual(['src/authority/app-open.ts', 'src/authority/owner-word.ts']);
    // Who says what a turn has read: the main agent's loop and a helper's. A third would be a new way to call a turn clean.
    expect(product.filter((file) => file !== 'src/authority/owner-word.ts' && /\bwithOutsideContent\b/.test(read(file)))).toEqual([
      'src/agents/orchestrator.ts',
      'src/agents/sub-agent-runner.ts',
    ]);
    // And the three places a call is decided all ask the one function.
    expect(product.filter((file) => file !== 'src/authority/owner-word.ts' && /\bownerWord\(/.test(read(file)))).toEqual([
      'src/actions/tools/approval-tool.ts',
      'src/agents/orchestrator.ts',
      'src/agents/sub-agent-runner.ts',
    ]);
    // Nobody decides it by the bare question "did the owner ask?" any more, but the app open, which is not asked about either way.
    expect(product.filter((file) => /\bownerAskedOnNotch\(\)/.test(read(file)))).toEqual(['src/authority/app-open.ts']);
  });

  test('the test fixture that makes a standing is named by tests only, and by exactly these', () => {
    expect(product.filter((file) => NAMES_FIXTURE.test(read(file)))).toEqual([]);
    expect(namesStanding(FIXTURE, read(FIXTURE))).toBe(true);
    expect(files.filter((file) => isTest(file) && file !== 'src/authority/standing-sites.test.ts' && NAMES_FIXTURE.test(read(file)))).toEqual([
      'src/agents/app-open-gating.test.ts',
      'src/agents/owner-word-boundary-gating.test.ts',
      'src/authority/app-open.test.ts',
      'src/authority/owner-word-boundary.test.ts',
      'src/authority/owner-word-surfaces.test.ts',
      'src/authority/owner-word.test.ts',
      'src/daemon/notch-asks.test.ts',
      'src/daemon/pebble-dialogue.test.ts',
    ]);
  });
});
