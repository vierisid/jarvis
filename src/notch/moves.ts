/**
 * How I move: every movement the notch has, playable by hand.
 *
 * The prototype kept a library beside its demo: 36 animations in four groups
 * (the lip, the body, along the edge, being born), 22 eye looks and 9 eye
 * movements. The owner, 17 November 2026: "one of the things that will give a
 * lot of reusability to Jarvis will be all of this animation. I'm talking
 * like, you know, popping out animation, eyes animation, the line."
 *
 * In the product each of them has a real moment (docs/notch/README.md lists
 * which). This file is the library itself, on the real notch: a sheet with
 * one button for each, opened from the settings or by saying "show me how
 * you move". A button plays its movement the way the prototype's button did,
 * with the same caption and timing, and then the sheet is back.
 *
 * Nothing here is real: the captions are captions. Nothing is read, sent or
 * changed by playing one, and names in them are made up.
 */
import { NOTCH_BIRTHS, type NotchBlock, type NotchBirth, type NotchLine, type NotchMood, type NotchPart } from './protocol.ts';
import type { NotchInbox } from './inbox.ts';
import type { NotchStage } from './stage.ts';
import type { NotchAct } from './surface.ts';

const em = (text: string): NotchPart => ({ em: text });

export const NOTCH_MOVE_GROUPS = ['The lip', 'The body', 'Along the edge', 'Being born', 'Eye looks', 'Eye movements'] as const;
export type NotchMoveGroup = (typeof NOTCH_MOVE_GROUPS)[number];

export interface NotchMove {
  id: string;
  group: NotchMoveGroup;
  /** What its button says. */
  label: string;
  /** Plays it. Comes back when it is over. */
  play(stage: NotchStage): Promise<void>;
}

/** A caption with a look, and a movement half a second into it (the prototype's `cap2`). */
const captioned = (say: string, mood: NotchMood, after?: NotchAct) => async (stage: NotchStage): Promise<void> => {
  const said = stage.say([say], 3400, { mood });
  if (after) stage.wait(520).then(() => stage.surface.act(after), () => {});
  await said;
};

/** From rest: the notch goes back to its eyes, and then moves (the prototype's `idle`). */
const fromRest = (act: NotchAct, ms: number) => async (stage: NotchStage): Promise<void> => {
  stage.surface.rest();
  await stage.wait(260);
  stage.surface.act(act);
  await stage.wait(ms);
};

/** A line that comes in along the edge, though it was asked for: here the coming in is the point. */
const arriving = (parts: NotchPart[], ms: number, extras: Partial<Pick<NotchLine, 'mood' | 'mark' | 'who' | 'arrive'>>) => async (stage: NotchStage): Promise<void> => {
  stage.surface.rest();
  await stage.wait(260);
  await stage.say(parts, ms, extras);
};

const born = (kind: NotchBirth) => async (stage: NotchStage): Promise<void> => {
  stage.surface.rest();
  await stage.wait(450);
  stage.surface.act({ birth: kind });
  await stage.wait(2400);
};

/** It talks: the words come as they would be heard, and the lip follows them. */
async function talks(stage: NotchStage): Promise<void> {
  const words = 'Every Monday send Sam the numbers'.split(' ');
  const id = stage.id();
  stage.put({ id, kind: 'listen', say: [], heard: '' });
  for (let n = 1; n <= words.length; n++) {
    await stage.wait(210);
    stage.surface.update(id, { heard: words.slice(0, n).join(' ') });
  }
  await stage.wait(500);
  stage.surface.update(id, { over: true });
  await stage.wait(900);
}

const LOOKS: [NotchMood, string][] = [
  ['idle', 'Idle, follows you'], ['look', 'Looking at its line'], ['listen', 'Listening'], ['read', 'Reading'], ['write', 'Writing'], ['think', 'Thinking'],
  ['recall', 'Remembering'], ['search', 'Searching'], ['work', 'Working'], ['happy', 'Pleased'], ['proud', 'Proud'], ['urgent', 'Urgent'], ['careful', 'Careful'],
  ['curious', 'Curious'], ['confused', 'Confused'], ['worried', 'Worried'], ['sorry', 'Sorry'], ['surprised', 'Surprised'], ['sleepy', 'Sleepy'], ['closed', 'Asleep'],
  ['focus', 'Do not disturb'], ['away', 'Looking away'],
];

const GESTURES: ['blink' | 'wink' | 'nodg' | 'shake' | 'hop' | 'pop' | 'peek-l' | 'wake' | 'doze', string][] = [
  ['blink', 'Blink'], ['wink', 'Wink'], ['nodg', 'Nod'], ['shake', 'Shake'], ['hop', 'Hop'], ['pop', 'Startle'], ['peek-l', 'Peek'], ['wake', 'Wake up'], ['doze', 'Doze off'],
];

const BIRTH_LABELS: Record<NotchBirth, string> = { run: 'Runs in', meet: 'Two meet', trace: 'Traced', bead: 'From a bead', eye: 'Opens like an eye', gather: 'The edge gathers' };

/** The whole library, in the prototype's order. */
export const NOTCH_MOVES: readonly NotchMove[] = [
  { id: 'lip-talks', group: 'The lip', label: 'Talks', play: talks },
  { id: 'lip-smiles', group: 'The lip', label: 'Smiles', play: captioned('Pleased.', 'happy') },
  { id: 'lip-grins', group: 'The lip', label: 'Grins', play: captioned('Proud of that one.', 'proud') },
  { id: 'lip-frets', group: 'The lip', label: 'Frets', play: captioned('Worried.', 'worried') },
  { id: 'lip-smirks', group: 'The lip', label: 'Smirks', play: captioned('Curious.', 'curious') },
  { id: 'lip-laughs', group: 'The lip', label: 'Laughs', play: captioned('Ha.', 'happy', { lip: 'laugh' }) },
  { id: 'lip-gasps', group: 'The lip', label: 'Gasps', play: captioned('Oh.', 'surprised') },
  { id: 'lip-zips', group: 'The lip', label: 'Zips', play: captioned('I will stay quiet.', 'look', { lip: 'zip' }) },
  { id: 'lip-yawns', group: 'The lip', label: 'Yawns', play: captioned('Morning.', 'sleepy', { lip: 'yawn' }) },
  { id: 'lip-thinks', group: 'The lip', label: 'Thinks', play: captioned('Thinking it over.', 'think') },
  { id: 'lip-works', group: 'The lip', label: 'Works', play: captioned('Working on it.', 'work') },
  { id: 'lip-reaches', group: 'The lip', label: 'Reaches', play: captioned('Look at this.', 'look', { lip: 'reach', aim: .22 }) },
  { id: 'lip-ripples', group: 'The lip', label: 'Ripples', play: captioned('Something landed.', 'look', { lip: 'ripple' }) },
  { id: 'lip-shivers', group: 'The lip', label: 'Shivers', play: captioned('That went wrong.', 'look', { lip: 'shiver' }) },

  { id: 'body-nods', group: 'The body', label: 'Nods', play: captioned('Yes.', 'look', { body: 'nod' }) },
  { id: 'body-shakes', group: 'The body', label: 'Shakes', play: captioned('Not now.', 'look', { gesture: 'shake' }) },
  { id: 'body-pops', group: 'The body', label: 'Pops', play: captioned('What?', 'look', { gesture: 'pop' }) },
  { id: 'body-shrugs', group: 'The body', label: 'Shrugs', play: captioned('Not sure.', 'confused') },
  { id: 'body-ducks', group: 'The body', label: 'Ducks', play: fromRest({ body: 'duck' }, 2600) },
  { id: 'body-stretches', group: 'The body', label: 'Stretches', play: captioned('Awake.', 'look', { gesture: 'wake' }) },
  { id: 'body-hops', group: 'The body', label: 'Hops twice', play: captioned('Done and done.', 'happy', { body: 'hops' }) },
  { id: 'body-breathes', group: 'The body', label: 'Breathes', play: captioned('Asleep.', 'closed') },

  { id: 'edge-arrives', group: 'Along the edge', label: 'Arrives', play: arriving(['In Gmail: something for you.'], 2400, { arrive: 'left' }) },
  { id: 'edge-urgent', group: 'Along the edge', label: 'Arrives, urgent', play: arriving(['In Stripe: this cannot wait.'], 2600, { mood: 'urgent', arrive: 'urgent' }) },
  { id: 'edge-hops', group: 'Along the edge', label: 'Hops in', play: arriving([em('Nora'), ' is done.'], 2400, { mark: 'check', who: 'Nora', arrive: 'hop' }) },
  { id: 'edge-pair', group: 'Along the edge', label: 'Two at once', play: arriving(['Two things: Gmail and Stripe.'], 2600, { arrive: 'pair' }) },
  {
    id: 'edge-carries', group: 'Along the edge', label: 'Carries across',
    play: async (stage) => {
      stage.surface.rest();
      await stage.wait(260);
      // In from one side, and out again to the other, through Jarvis.
      const said = stage.say(['From Gmail into Slack.'], 2400, { mood: 'work', arrive: 'left' });
      stage.wait(960).then(() => stage.surface.act({ edge: 'depart', side: 'right' }), () => {});
      await said;
    },
  },
  {
    id: 'edge-buds', group: 'Along the edge', label: 'An agent buds off',
    play: async (stage) => {
      const said = stage.say(['Meet ', em('Tony'), '.'], 2800, { mood: 'proud', mark: 'check' });
      stage.wait(500).then(() => stage.surface.act({ edge: 'bud' }), () => {});
      await said;
    },
  },
  {
    id: 'edge-departs', group: 'Along the edge', label: 'Departs',
    play: async (stage) => {
      const said = stage.say(['Sent.'], 2200, { mood: 'happy', mark: 'check' });
      stage.surface.act({ edge: 'depart' });
      await said;
    },
  },
  {
    id: 'edge-queues', group: 'Along the edge', label: 'Queues up',
    play: async (stage) => {
      stage.surface.rest();
      await stage.wait(260);
      for (const many of [1, 2, 3]) { stage.surface.act({ park: many }); await stage.wait(540); }
      await stage.wait(2200);
      stage.surface.act({ park: 0 });
      await stage.wait(900);
    },
  },

  ...NOTCH_BIRTHS.map((kind): NotchMove => ({ id: `birth-${kind}`, group: 'Being born', label: BIRTH_LABELS[kind], play: born(kind) })),

  ...LOOKS.map(([mood, label]): NotchMove => ({ id: `look-${mood}`, group: 'Eye looks', label, play: async (stage) => { await stage.say([`${label}.`], 3000, { mood }); } })),

  ...GESTURES.map(([gesture, label]): NotchMove => ({
    id: `move-${gesture}`, group: 'Eye movements', label,
    play: async (stage) => {
      stage.surface.rest();
      await stage.wait(200);
      // It wakes from sleep: its eyes are closed first.
      if (gesture === 'wake') { stage.surface.act({ mood: 'closed' }); await stage.wait(700); }
      stage.surface.act({ gesture });
      await stage.wait(gesture === 'wake' ? 2600 : gesture === 'doze' ? 2400 : 1100);
    },
  })),
];

/** "Show me how you move", "your animations", "how do you move". */
export function movesRequest(text: string): boolean {
  const said = text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  return /^(?:show me |see |open |play )?(?:how (?:do )?you move|how i move|your (?:moves|movements|animations)|(?:the |all (?:the |your )?)?(?:animations|movements))$/.test(said)
    || /^show me (?:your |the )?(?:moves|movements|animations)$/.test(said);
}

export interface NotchMovesDeps {
  inbox: NotchInbox;
  /** The face the notch has at rest: it is given back after each movement, whatever the movement did to it. */
  resting(): NotchMood;
  log?: (line: string) => void;
}

export interface NotchMoves {
  route(text: string): { did: string; run(): void } | null;
  /** The library, as a sheet. Comes back when it is closed. */
  open(stage: NotchStage): Promise<void>;
}

/** The library's sheet: a heading and its buttons, group after group. */
export function movesBlocks(): NotchBlock[] {
  const blocks: NotchBlock[] = [];
  for (const group of NOTCH_MOVE_GROUPS) {
    const moves = NOTCH_MOVES.filter((move) => move.group === group);
    blocks.push({ kind: 'note', say: [em(group), `, ${moves.length}`] });
    blocks.push({ kind: 'buttons', buttons: moves.map((move) => ({ id: move.id, label: move.label })) });
  }
  blocks.push({ kind: 'note', say: ['Each one has a real moment too. Here they are only shown: nothing is read, sent or changed.'] });
  return blocks;
}

export function attachNotchMoves(deps: NotchMovesDeps): NotchMoves {
  const log = deps.log ?? ((line: string) => console.log(line));

  async function open(stage: NotchStage): Promise<void> {
    for (;;) {
      const answer = await stage.sheet(['How I move'], movesBlocks(), { mood: 'look' });
      if (answer.act !== 'button') return;
      const move = NOTCH_MOVES.find((one) => one.id === answer.button);
      if (!move) continue;
      log(`[notch] a movement was played by hand: ${move.id}`);
      try {
        await move.play(stage);
      } finally {
        // Whatever it did to the face, the face it has at rest is given back.
        if (!stage.ended()) { stage.surface.rest(); stage.surface.act({ mood: deps.resting() }); }
      }
    }
  }

  return {
    route(text) {
      return movesRequest(text) ? { did: 'Show how the notch moves.', run: () => { deps.inbox.present('moves', (stage) => open(stage)); } } : null;
    },
    open,
  };
}
