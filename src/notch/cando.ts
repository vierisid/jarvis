/**
 * What I can do: everything the notch does, on one sheet.
 *
 * The owner, 17 November 2026, after day one first ran: "there is a lot of
 * functionalities that are not shown. For example, dropping a file into it
 * or asking where something is and how do I do certain things. All of that
 * should be put in, and I'm pretty sure I'm missing some."
 *
 * Day one teaches the ones that are a movement of the hands by having the
 * person do them once (./dayone.ts). This sheet is the rest, and all of them
 * together: one row for each thing, with the words that start it. Day one
 * ends on it, the settings lead to it, and "what can you do" opens it.
 *
 * A row may quote a sentence to say. Every such sentence is one the product
 * really takes: ./cando.test.ts puts each of them to the code that reads it.
 * A row for something that is not built does not belong here.
 */
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { readAs, routeByIntents, type NotchIntent } from './intents.ts';

const em = (text: string): NotchPart => ({ em: text });
const talk: NotchPart = { key: 'talk' };

export interface NotchCan {
  id: string;
  /** What it is, in a word or two. */
  lead: string;
  say: NotchPart[];
  /** The sentences the row quotes, each with the part of the product that takes it. */
  tries?: { words: string; by: 'where' | 'put' | 'watch' | 'done' | 'run' | 'eye' | 'chase' | 'agent' | 'remember' | 'memory' | 'call' | 'pick' | 'yes' }[];
}

/** Everything, in the order a person meets it. */
export const NOTCH_CAN: readonly NotchCan[] = [
  { id: 'talk', lead: 'Talk', say: ['Hold ', talk, ' and say what you need. Let go when you are done.'] },
  { id: 'yes', lead: 'Yes, and not now', say: ['Tap ', { key: 'yes' }, ' for yes, ', { key: 'esc' }, ' for not now. Esc twice stops everything until you wake me.'] },
  {
    id: 'line', lead: 'Answer by voice',
    say: ['With a line up, hold ', talk, ' and answer it: "', em('Friday at ten works'), '" picks a time, "', em('go ahead'), '" is a yes.'],
    tries: [{ words: 'Friday at ten works', by: 'pick' }, { words: 'go ahead', by: 'yes' }],
  },
  { id: 'look', lead: 'Look at this', say: ['Keep ', talk, ' held down, then click and drag a circle round a thing. Say what you want with it, or say nothing.'] },
  {
    id: 'where', lead: 'Where is, how do I',
    say: ['Ask "', em('where is the export button'), '" or "', em('how do I add a column'), '". I point at it, one step at a time.'],
    tries: [{ words: 'where is the export button', by: 'where' }, { words: 'how do I add a column', by: 'where' }],
  },
  { id: 'file', lead: 'A file', say: ['Drag any file onto me. I open my mouth for it. Then ask about it.'] },
  {
    id: 'put', lead: 'Put it there',
    say: ['After you showed me a thing, hold ', talk, ', click where it goes and say "', em('put it here'), '".'],
    tries: [{ words: 'put it here', by: 'put' }],
  },
  {
    id: 'watch', lead: 'Watch me',
    say: ['Say "', em('watch me'), '", do a job once, say "', em('done'), '". Then "', em('run it'), '" does it for you.'],
    tries: [{ words: 'watch me', by: 'watch' }, { words: 'done', by: 'done' }, { words: 'run it', by: 'run' }],
  },
  { id: 'twice', lead: 'Twice by hand', say: ['Do the same thing twice and I offer to go on from there.'] },
  { id: 'notice', lead: 'In your apps', say: ['When your hands rest I look at the window you are in. If one thing there waits for you, I offer to do it. Settings switches that off.'] },
  {
    id: 'eye', lead: 'Keep an eye',
    say: ['"', em('Tell me when Sam replies'), '". I tell you the moment it happens.'],
    tries: [{ words: 'Tell me when Sam replies', by: 'eye' }],
  },
  {
    id: 'chase', lead: 'Until it is done',
    say: ['"', em("Get Sam's answer by Friday"), '". I ask again until it is in.'],
    tries: [{ words: "Get Sam's answer by Friday", by: 'chase' }],
  },
  {
    id: 'agent', lead: 'An agent',
    say: ['"', em('Every Monday at 9, send Sam the numbers'), '". It gets a name, and asks before it acts.'],
    tries: [{ words: 'Every Monday at 9, send Sam the numbers', by: 'agent' }],
  },
  {
    id: 'memory', lead: 'Memory',
    say: ['"', em('Remember that Anna prefers calls'), '". Later: "', em('what do you know about Anna'), '".'],
    tries: [{ words: 'Remember that Anna prefers calls', by: 'remember' }, { words: 'what do you know about Anna', by: 'memory' }],
  },
  { id: 'mail', lead: 'Mail', say: ['I draft replies to people who wait for you, and bring them. "', em('tell me'), '" on a draft changes what it says.'] },
  {
    id: 'call', lead: 'A call',
    say: ['On a call I ask whether to listen. Say yes and I write it down, and afterwards say what came out of it. Later: "', em('show my last call'), '".'],
    tries: [{ words: 'show my last call', by: 'call' }],
  },
  { id: 'quiet', lead: 'Quiet', say: ['Home has "Quiet for an hour". Nothing comes up while it is on, and on a call I hold everything else.'] },
  { id: 'home', lead: 'Home', say: ['Tap ', { key: 'yes' }, ' with nothing on me: what waits, what I did today, Memory, Connections, Settings.'] },
];

/** The sheet's blocks: one row for each thing. */
export function canDoBlocks(): NotchBlock[] {
  return [
    ...NOTCH_CAN.map((can): NotchBlock => ({ kind: 'row', lead: can.lead, say: can.say })),
    { kind: 'note', say: ['Say "what can you do" to see this again. "Day one" starts the first steps again.'] },
  ];
}

/** "What can you do", "help", "what do you do". */
export function canDoRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:so |and |ok |okay |hey |jarvis,? )*(?:what (?:can|do) you do|what are you (?:able to do|for)|what can i (?:do|ask|say)(?: here| to you)?|help|show me what you can do|how do you work|how does this work)$/.test(said);
}

export interface NotchCanDo {
  route(text: string): { did: string; run(): void } | null;
  /** Its words, as intents of the one table (./intents.ts). `route` is the first of them that takes a sentence. */
  intents(): readonly NotchIntent[];
  /** The sheet. With `yes`, it has that word as its way on (day one ends on it). Comes back when it is closed. */
  open(stage: NotchStage, more?: { yes?: string }): Promise<void>;
}

export function attachNotchCanDo(deps: { inbox: NotchInbox }): NotchCanDo {
  async function open(stage: NotchStage, more: { yes?: string } = {}): Promise<void> {
    const id = stage.id();
    stage.put({ id, kind: 'sheet', say: ['What I can do'], blocks: canDoBlocks(), mood: 'look', ...(more.yes ? { yes: more.yes, stay: true, no: 'close' } : {}) });
    await stage.answer(id, ['yes', 'no']);
  }
  const intents: NotchIntent[] = [{
    id: 'cando.open', feature: 'canDo', says: 'show what the notch can do', band: 'open', act: 'none', first: 'acts',
    examples: ['what can you do', 'help', 'how does this work'],
    read: readAs('what can you do'),
    match(text) {
      return canDoRequest(text) ? { did: 'Show what the notch can do.', run: () => { deps.inbox.present('can-do', (stage) => open(stage)); } } : null;
    },
  }];
  return {
    route: (text) => routeByIntents(intents, text),
    intents: () => intents,
    open,
  };
}

/** Everything it does, on one sheet, as a feature of the notch (./feature.ts). */
export const notchCanDoFeature: NotchFeatureDef<'canDo'> = {
  id: 'canDo',
  make: (ctx) => ({ api: attachNotchCanDo({ inbox: ctx.inbox }) }),
};
