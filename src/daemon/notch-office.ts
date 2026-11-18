/**
 * What the notch's back office (pass 12) needs of the product: its memory
 * and its own Forget, the keys of the machine a sheet is open on, what makes
 * out speech, and what is connected.
 *
 * Nothing in src/notch reaches for these itself (src/notch/real.ts). Nothing
 * here keeps anything: each is read from the product when it is asked for.
 */
import type { Database } from 'bun:sqlite';
import { MemoryForget } from '../brief/memory-forget.ts';
import { createSTTProvider } from '../comms/voice.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { NotchMemoryFact } from '../notch/memory.ts';
import type { NotchConnection, NotchKeyPairs, NotchPrefsDeps, NotchSettingsPage } from '../notch/prefs.ts';
import type { NotchRealDeps } from '../notch/real.ts';
import { getEntity } from '../vault/entities.ts';
import { findFacts } from '../vault/facts.ts';
import { effectiveSttForBinding, usejarvisVoiceCredentials } from './usejarvis-ai.ts';

/** The most facts that are read for one sheet. The sheet shows fewer, and says how many more there are. */
const MEMORY_MOST = 400;

/**
 * The facts that are remembered now, newest first, each with who it is about
 * and where it came from. With `about`, only the facts about that one: by
 * their whole name or their first, as the sheet asks.
 *
 * The limit is laid on after the choosing. It used to be laid on first: of
 * more than 400 facts only some 400 were ever looked at, in the store's
 * order and not the newest, and asked about someone whose facts were not
 * among them the sheet said "I know nothing about Sam yet".
 */
export function notchMemoryFacts(about?: string): NotchMemoryFact[] {
  const names = new Map<string, string>();
  const nameOf = (id: string): string => {
    if (!names.has(id)) names.set(id, getEntity(id)?.name ?? '');
    return names.get(id) ?? '';
  };
  const wanted = about?.trim().toLowerCase() ?? '';
  const listed: NotchMemoryFact[] = [];
  for (const fact of findFacts({}).sort((a, b) => b.created_at - a.created_at)) {
    const name = nameOf(fact.subject_id) || 'Something';
    if (wanted) {
      const low = name.trim().toLowerCase();
      if (low !== wanted && low.split(' ')[0] !== wanted) continue;
    }
    listed.push({
      id: fact.id,
      about: name,
      text: `${fact.predicate} ${fact.object}`.replace(/\s+/g, ' ').trim(),
      // What was read of a file says so: "llm extraction" would tell the owner nothing.
      source: fact.evidence.some((evidence) => evidence.source_ref?.startsWith('notch:files:')) ? 'a file I opened' : fact.evidence[0]?.source ?? fact.source ?? '',
    });
    if (listed.length >= MEMORY_MOST) break;
  }
  return listed;
}

/**
 * Forgets one fact through the product's own Forget: the fact and its
 * evidence are removed, a receipt is kept, and the same thing is not learned
 * again from the same place. True when it is gone, by this or by an earlier
 * forgetting.
 *
 * The product's Forget is behind a switch for the dashboard. The notch's is
 * behind the notch's own switch and nothing else: the person pressed Forget
 * on that row and then said again that they meant it.
 */
export function notchForgetFact(db: Database, id: string): boolean {
  const forget = new MemoryForget(db, () => true);
  const state = forget.get(id);
  if (state.state === 'forgotten') return true;
  const done = forget.forget(id, { requestId: `notch-${crypto.randomUUID()}`, expectedRevision: state.revision, confirmed: true });
  return done.state === 'forgotten';
}

const KEYS: ReadonlySet<string> = new Set(['ctrl', 'alt', 'meta', 'shift']);

/** The pairs as a desktop app answered them, checked. Null when the answer is not that. */
export function notchKeyPairs(answer: unknown): NotchKeyPairs | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const raw = answer as Record<string, unknown>;
  const pair = (value: unknown): [string, string] | null =>
    (Array.isArray(value) && value.length === 2 && value.every((key) => typeof key === 'string' && KEYS.has(key)) && value[0] !== value[1] ? [value[0] as string, value[1] as string] : null);
  const talk = pair(raw.talk), yes = pair(raw.yes);
  return talk && yes ? { talk, yes, mac: raw.mac === true } : null;
}

/** Why a desktop app would not take a pair, in a sentence for the person. */
export function notchKeysRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/same two keys/i.test(message)) return 'Talk and yes cannot be the same two keys.';
  if (/could not be saved/i.test(message)) return 'This computer could not save them.';
  if (/two different keys|two keys joined/i.test(message)) return 'A pair is two different keys.';
  return 'This computer did not take them.';
}

const VOICE_NAMES: Record<string, string> = { openai: 'OpenAI', groq: 'Groq', local: 'a model on this computer', sarvam: 'Sarvam', usejarvis: 'Jarvis AI' };

/** What makes out speech now. Null when nothing is set up that could. */
export function notchVoice(config: JarvisConfig): { by: string; language: string } | null {
  const binding = effectiveSttForBinding(config);
  if (!binding) return null;
  let works = false;
  try { works = createSTTProvider(binding, usejarvisVoiceCredentials(config)) !== null; } catch { works = false; }
  if (!works) return null;
  const code = (binding.provider === 'sarvam' ? binding.sarvam?.language : binding.language) ?? '';
  let language = 'any language';
  if (code) {
    try { language = new Intl.DisplayNames(['en'], { type: 'language' }).of(code.split('-')[0]!) ?? code; } catch { language = code; }
  }
  return { by: VOICE_NAMES[binding.provider] ?? binding.provider, language };
}

export interface NotchOfficeOptions {
  db: Database;
  config(): JarvisConfig;
  sidecars: {
    dispatchRPC(sidecarId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
    getConnectedSidecars(): { id: string }[];
  };
  /** Whether Google's own connection is there, and whether it needs the person to sign in again. */
  google(): { isAuthenticated(): boolean; reconnectRequired(): string | null } | null;
  /** Whether Jarvis's own browser read the mailbox at its last look: true, false, or null when it has not looked yet. */
  mailRead(): boolean | null;
  /** Shows Jarvis's own browser at Gmail, where the person signs in. */
  openMail(): Promise<void>;
  /** Opens the dashboard at one of its settings pages. */
  openPage(sidecarId: string | null, page: NotchSettingsPage): void;
}

export function notchOfficeDeps(options: NotchOfficeOptions): NonNullable<NotchRealDeps['office']> {
  /** The machine a sheet is open on, or the only one there is. */
  const machine = (sidecarId: string | null): string | null => {
    if (sidecarId) return sidecarId;
    const all = options.sidecars.getConnectedSidecars();
    return all.length === 1 ? all[0]!.id : null;
  };
  const keys: NonNullable<NotchPrefsDeps['keys']> = {
    async read(sidecarId) {
      const id = machine(sidecarId);
      if (!id) return null;
      // A desktop app from before this does not know the question: then the keys are in its own settings window.
      try { return notchKeyPairs(await options.sidecars.dispatchRPC(id, 'notch.keys', {})); } catch { return null; }
    },
    async change(sidecarId, change) {
      const id = machine(sidecarId);
      if (!id) return { why: 'I cannot tell which computer to change them on.' };
      try {
        return notchKeyPairs(await options.sidecars.dispatchRPC(id, 'notch.keys', { ...change })) ?? { why: 'This computer did not take them.' };
      } catch (error) {
        return { why: notchKeysRefusal(error) };
      }
    },
  };
  return {
    memory: { list: (about) => notchMemoryFacts(about), forget: (id) => notchForgetFact(options.db, id) },
    keys,
    voice: () => notchVoice(options.config()),
    connections(): NotchConnection[] {
      const google = options.google();
      const read = options.mailRead();
      const signedIn = google?.isAuthenticated() === true && !google.reconnectRequired();
      const again = google?.isAuthenticated() === true && !!google.reconnectRequired();
      return [
        {
          id: 'gmail', name: 'Gmail', state: read === true ? 'on' : read === false ? 'again' : 'off',
          how: read === true ? 'I read it in my own browser, signed in as you.' : read === false ? 'My own browser is not signed in to Gmail.' : 'I have not looked at your mail yet.',
        },
        {
          id: 'calendar', name: 'Calendar', state: signedIn || read === true ? 'on' : again ? 'again' : 'off',
          how: signedIn ? 'Through Google\'s own connection.' : read === true ? 'I read it in my own browser, signed in as you.' : again ? 'Google wants you to sign in again.' : 'Sign in to Google in my browser, and I can read it.',
        },
      ];
    },
    async connect(id, sidecarId) {
      // Google's own connection is set up in the dashboard. Everything else Jarvis reads in its own browser.
      const google = options.google();
      if (id === 'calendar' && google?.isAuthenticated() === true && google.reconnectRequired()) { options.openPage(sidecarId, 'integrations'); return; }
      await options.openMail();
    },
    openPage: options.openPage,
  };
}
