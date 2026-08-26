/**
 * The three tools the background file reader gets, and nothing else.
 *
 * D42's reader is a real persistent sub-agent, spawned and tracked like any
 * other, but it does NOT get the ordinary `read_file` / `list_directory` from
 * `builtin.ts`. Those resolve against the home directory and take an absolute
 * path to anywhere on the disk, which is precisely the thing the founder did
 * not agree to. It gets these instead: the same two verbs, fenced to the one
 * folder they named, plus one way to write down what it learned.
 *
 * The fence is `insideRoot` in founder-files.ts and there is no way round it
 * from in here: the root is captured in the closure when the tools are built,
 * the model never sees it as a parameter, and every path it passes is resolved
 * against that root before anything is opened.
 *
 * There is deliberately no way for this agent to WRITE anything. D43's writes
 * happen in the conversation, through a proposal the founder saw and a commit
 * they answered. A background agent that could write to a founder's disk while
 * they were talking about something else is not a feature anybody asked for.
 */

import type { ToolDefinition } from '../../actions/tools/registry.ts';
import { MAX_READ_FILES, listInside, readInside } from './founder-files.ts';

/** What the reader hands back when it learns something. Mirrors `remember`'s
 *  shape exactly, so the manager can land it through the same code path the
 *  conversation uses and the founder sees one memory ticker, not two. */
export type FoundEntities = {
  entities?: { name?: string; type?: string; role?: string; note?: string }[];
  facts?: { about?: string; detail?: string }[];
};

export function buildReaderTools(opts: {
  folder: string;
  onFound: (found: FoundEntities) => { landed: number; names: string[] };
}): ToolDefinition[] {
  const { folder, onFound } = opts;
  return [
    {
      name: 'list_folder',
      description:
        'List what is in a folder. Paths are relative to the folder you were given; ' +
        'use "." for the top of it. Anything outside it is refused.',
      category: 'file-ops',
      parameters: {
        path: { type: 'string', description: 'Relative path inside the folder. "." for the top.', required: false },
      },
      execute: async (params) => {
        const r = listInside(folder, String(params.path ?? '.'));
        return r.ok ? r.text : `Error: ${r.why}`;
      },
    },
    {
      name: 'read_document',
      description:
        'Read one file. The path is relative to the folder you were given. Binary ' +
        'formats (PDF, Word, Keynote, images) cannot be opened: say so rather than ' +
        'guessing at what is inside them.',
      category: 'file-ops',
      parameters: {
        path: { type: 'string', description: 'Relative path inside the folder.', required: true },
      },
      execute: async (params) => {
        const r = readInside(folder, String(params.path ?? ''));
        return r.ok ? r.text : `Error: ${r.why}`;
      },
    },
    {
      name: 'note_company',
      description:
        'Write down something you have learned about the company from their files. ' +
        'Call this CONTINUOUSLY, as you find each thing, never in one batch at the ' +
        'end: the founder is watching these land while you work. Only what is ' +
        'actually written in the files. Never infer, never fill gaps, never round a ' +
        'number up.',
      category: 'file-ops',
      parameters: {
        entities: {
          type: 'array',
          description:
            'People, clients, competitors, investors, products, projects, tools or ' +
            'places named in the files. Each: {name, type, role, note}. `type` is one ' +
            'of person, project, tool, place, concept, event; `role` is the finer word ' +
            '("client", "co-founder", "competitor").',
          required: false,
        },
        facts: {
          type: 'array',
          description:
            'Concrete things now known about one of those, as {about, detail}. `detail` ' +
            'is one short sentence in the document\'s own terms. Numbers, dates, prices ' +
            'and commitments are the valuable ones.',
          required: false,
        },
      },
      execute: async (params) => {
        const result = onFound(params as FoundEntities);
        return result.landed === 0
          ? 'Nothing new there; it was already known. Carry on reading.'
          : `Noted ${result.landed}: ${result.names.slice(0, 8).join(', ')}. Carry on reading.`;
      },
    },
  ];
}

/** What the reader is asked to do. */
export function readerTask(fileCount: number): string {
  return (
    `Read this founder's own files and work out what their company actually is. ` +
    `You have ${fileCount} file${fileCount === 1 ? '' : 's'} to look at, and you should look at all of ` +
    'them unless they are obviously irrelevant.'
  );
}

/** The context it gets with that task: the fence, the method, and the one rule. */
export function readerContext(opts: { folder: string; shortlist: string[]; about: string }): string {
  const listed = opts.shortlist.slice(0, MAX_READ_FILES);
  return [
    `The folder is ${opts.folder}. It is the only place you can read, and every path you pass to a tool`,
    'is relative to it. You cannot write anything and you should not try.',
    '',
    opts.about ? `What is already known about them, from talking to them: ${opts.about}` : '',
    opts.about ? '' : '',
    'These are the files, newest first:',
    ...listed.map((f) => `- ${f}`),
    '',
    'How to do this:',
    '',
    '1. Start with the ones whose names suggest the company itself: a pitch, a deck, a plan, a README,',
    '   anything about pricing, customers or money. Use `list_folder` if you need to see more.',
    '2. Read them with `read_document`, one at a time.',
    '3. Call `note_company` AS YOU GO, after each file, never in one batch at the end. The founder is',
    '   watching these land on their screen while you work, so a batch at the end is a blank screen',
    '   followed by a dump.',
    '4. What is worth noting: the people and what they do, the clients and competitors by name, the',
    '   products, the actual numbers (revenue, price, runway, headcount, targets), the dates, and the',
    '   things they have committed to. Names and numbers, not adjectives.',
    '',
    'THE ONE RULE: only what is actually written in the files. If a file says a price is under review,',
    'that is the fact, not the old price. If the folder turns out to have nothing about the company in',
    'it, say exactly that and note nothing. An invented finding is worse than an empty one, because it',
    'will be read back to the founder as something you found in their own documents.',
    '',
    'When you have finished, reply with a short paragraph on what this company is, in plain language,',
    'and one line on anything that looked out of date or contradictory. That paragraph is the only',
    'thing anyone reads from you, so make it about their company and not about your process.',
  ].filter((l) => l !== '').join('\n');
}
