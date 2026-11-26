/**
 * What I remember, with forget.
 *
 * The prototype's Memory: every fact as one row, where it came from in small
 * words beside it, and a Forget on each. The row stays where it was, struck
 * through, until the sheet is closed, so what was forgotten can be seen to
 * be gone and nothing jumps under the pointer.
 *
 * One difference from the prototype, on purpose: there a press on Forget
 * forgot. Here the press turns the row into "Forget for good" and "Keep",
 * and the second press forgets. A forgotten fact cannot be brought back, the
 * product's own Forget asks that it was meant (src/brief/memory-forget.ts),
 * and on the notch a delete is one of the two things that may ask.
 *
 * Nothing is kept here. The rows are the product's own memory, read each
 * time the sheet is drawn, and forgetting is the product's own Forget
 * (src/brief/memory-forget.ts): the fact and its evidence are removed, and
 * the same thing is not learned again from the same place.
 *
 * A fact is text that was learned from somewhere: a mail, a page, a
 * conversation. Here it is shown to its owner and goes nowhere else.
 */
import type { NotchBlock, NotchPart } from './protocol.ts';
import type { NotchFeatureDef } from './feature.ts';
import type { NotchInbox } from './inbox.ts';
import { mailToneFacts } from './mail/notch.ts';
import type { NotchStage } from './stage.ts';

const em = (text: string): NotchPart => ({ em: text });
const cut = (text: string, most: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...flat].length > most ? `${[...flat].slice(0, most - 1).join('')}…` : flat;
};

/** How many facts one sheet shows. The rest are in the dashboard. */
export const NOTCH_MEMORY_ROWS = 30;

export interface NotchMemoryFact {
  id: string;
  /** Who or what it is about. */
  about: string;
  /** The rest of the sentence: "prefers calls". */
  text: string;
  /** Where it came from, as the product recorded it. */
  source: string;
}

export interface NotchMemoryDeps {
  inbox: NotchInbox;
  /** Every fact that is remembered now, newest first. */
  /** The facts, newest first. With `about`, those about that one: asked of the whole memory, not of its newest part. */
  list(about?: string): NotchMemoryFact[];
  /** Forgets one, for good. False when it could not be forgotten: then it is still there. */
  forget(id: string): boolean | Promise<boolean>;
  log?: (line: string) => void;
}

export interface NotchMemory {
  route(text: string): { did: string; run(): void } | null;
  /** The sheet. With `about`, only what is known about that one. Comes back when it is closed. */
  open(stage: NotchStage, about?: string | null): Promise<void>;
  /** How many facts are remembered. */
  count(): number;
}

/**
 * "What do you remember", "what do you know about Sam", "show my memory".
 * Null when the words are not that. `about` is the name asked about, if any.
 */
export function memoryRequest(text: string): { about: string | null } | null {
  const said = text.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  if (/^(?:show (?:me )?)?(?:my |your |the )?memory$/i.test(said)) return { about: null };
  if (/^what do you (?:remember|know)(?: about me)?$/i.test(said)) return { about: null };
  const about = /^what do you (?:remember|know) about (.{1,60})$/i.exec(said);
  return about ? { about: about[1]!.trim() } : null;
}

/** Where a fact came from, in the few words there is room for. */
export function memorySource(source: string): string {
  const flat = cut(source, 40).toLowerCase();
  if (!flat) return '';
  if (flat === 'user_profile') return 'from your profile';
  return cut(flat.replace(/[_-]+/g, ' '), 26);
}

export function attachNotchMemory(deps: NotchMemoryDeps): NotchMemory {
  const log = deps.log ?? ((line: string) => console.log(line));

  const facts = (about?: string): NotchMemoryFact[] => {
    try { return about ? deps.list(about) : deps.list(); } catch (error) {
      log(`[notch] memory could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  async function open(stage: NotchStage, about: string | null = null): Promise<void> {
    const all = facts();
    const wanted = about?.trim().toLowerCase() ?? '';
    // Asked about someone nothing is known of: everything is shown, and that is said.
    // Asked of the whole memory: the list above is its newest part only.
    const known = wanted ? facts(about ?? undefined).filter((fact) => fact.about.trim().toLowerCase() === wanted || fact.about.trim().toLowerCase().split(' ')[0] === wanted) : [];
    const shown = (known.length ? known : all).slice(0, NOTCH_MEMORY_ROWS);
    const more = (known.length ? known : all).length - shown.length;
    const gone = new Set<string>();
    const failed = new Set<string>();
    /** The one row that has been asked to be forgotten and waits to hear that it was meant. */
    let sure: string | null = null;
    const blocks = (): NotchBlock[] => [
      ...(wanted && !known.length ? [{ kind: 'note' as const, say: ['I know nothing about ', em(cut(about ?? '', 40)), ' yet. This is everything.'] satisfies NotchPart[] }] : []),
      ...(shown.length ? shown.map((fact): NotchBlock => (gone.has(fact.id)
        ? { kind: 'row', id: fact.id, lead: cut(fact.about, 40), say: [cut(fact.text, 160)], small: 'forgotten', gone: true }
        : sure === fact.id
          ? { kind: 'row', id: fact.id, lead: cut(fact.about, 40), say: [cut(fact.text, 160)], buttons: [{ id: 'sure', label: 'Forget for good' }, { id: 'keep', label: 'Keep', quiet: true }] }
          : {
            kind: 'row', id: fact.id, lead: cut(fact.about, 40), say: [cut(fact.text, 160)], small: failed.has(fact.id) ? 'still here' : memorySource(fact.source),
            buttons: [{ id: 'forget', label: 'Forget', quiet: true }],
          })) : [{ kind: 'row' as const, say: ['Nothing yet.'] satisfies NotchPart[] }]),
      ...(more > 0 ? [{ kind: 'note' as const, say: [`And ${more} more, in the dashboard.`] satisfies NotchPart[] }] : []),
      { kind: 'note', say: ['Say "remember that Sam prefers calls" and it lands here.'] },
    ];
    const id = stage.id();
    stage.put({
      id, kind: 'sheet', mood: 'recall', blocks: blocks(),
      say: known.length ? ['What I know about ', em(cut(known[0]!.about, 40))] : ['What I remember'],
    });
    for (;;) {
      const answer = await stage.answer(id, ['no', 'button']);
      if (answer.act !== 'button') return;
      const fact = shown.find((one) => one.id === answer.row);
      if (!fact || gone.has(fact.id)) continue;
      // The first press asks; "Keep" takes the asking back; only "Forget for good" on that same row forgets.
      if (answer.button === 'forget') { sure = fact.id; stage.surface.update(id, { blocks: blocks() }); continue; }
      if (answer.button === 'keep') { sure = null; stage.surface.update(id, { blocks: blocks() }); continue; }
      if (answer.button !== 'sure' || sure !== fact.id) continue;
      sure = null;
      let forgotten = false;
      try { forgotten = (await deps.forget(fact.id)) === true; } catch (error) {
        log(`[notch] a fact could not be forgotten: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (forgotten) { gone.add(fact.id); failed.delete(fact.id); log('[notch] a fact was forgotten from the notch'); }
      else failed.add(fact.id);
      // In place: the row is struck through where it stands.
      stage.surface.update(id, { blocks: blocks() });
      if (!forgotten) stage.surface.act({ gesture: 'shake' });
    }
  }

  return {
    route(text) {
      const asked = memoryRequest(text);
      return asked ? { did: 'Show what is remembered.', run: () => { deps.inbox.present('memory', (stage) => open(stage, asked.about)); } } : null;
    },
    open,
    count: () => facts().length,
  };
}

/**
 * What is remembered, as a feature of the notch (./feature.ts), with its
 * quiet link at the foot of Home. Absent on a brain that was not given its
 * memory.
 *
 * How a person is always written to ("Always use a short tone with Marco?")
 * is something that was learned: it stands here with everything else that is
 * remembered, and is forgotten here. The mail layer is asked for when the
 * sheet is opened, so it does not matter that it is made after this.
 */
export function notchMemoryFeature(given: Pick<NotchMemoryDeps, 'list' | 'forget'> | undefined): NotchFeatureDef<'memory'> {
  return {
    id: 'memory',
    wants: ['mail'],
    make(ctx) {
      if (!given) return null;
      const api = attachNotchMemory({
        inbox: ctx.inbox, log: ctx.log,
        list: (about) => [...mailToneFacts(ctx.use('mail')?.store.tones() ?? [], about), ...given.list(about)],
        forget: (id) => (id.startsWith('tone:') ? (ctx.use('mail')?.store.forgetTone(id.slice('tone:'.length)) ?? false) : given.forget(id)),
      });
      return {
        api,
        homeLinks: () => [{ id: 'memory', label: 'Memory', quiet: true }],
        press: async (stage, link) => {
          if (link !== 'memory') return null;
          await api.open(stage);
          return 'stay';
        },
      };
    },
  };
}
