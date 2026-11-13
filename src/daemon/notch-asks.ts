/**
 * What the notch's asking (src/notch/asks.ts) is given from the product: the
 * turn store, the model, speech-to-text and memory. Everything the notch
 * touches for an instruction is named in this one file.
 *
 * Nothing here is new behaviour. A typed or spoken instruction becomes the
 * same stored turn a dashboard message becomes, in a conversation of its own
 * called Notch. "Remember that..." becomes one fact through the same writer
 * every other fact goes through.
 */
import type { Database } from 'bun:sqlite';
import type { BriefChatTransport } from '../brief/chat-transport.ts';
import { createSTTProvider } from '../comms/voice.ts';
import type { JarvisConfig } from '../config/types.ts';
import type { LLMManager } from '../llm/manager.ts';
import { runWithOrigin } from '../llm/origin.ts';
import {
  bindScriptedModel, scriptedCalls, scriptedModelBound, scriptedTurns, setScriptedTurns,
} from '../llm/scripted.ts';
import type { NotchTurnDoor } from '../notch/asks.ts';
import type { NotchRealDeps } from '../notch/real.ts';
import { NOTCH_TOLD_SOURCE, createNotchRemember } from '../notch/remember.ts';
import type { NotchScriptDeps } from '../notch/script.ts';
import type { NotchTalkPort } from '../notch/talk.ts';
import { addMessage, getOrCreateConversation } from '../vault/conversations.ts';
import { createEntity, findEntities, getEntity, listEntityNames } from '../vault/entities.ts';
import { createFact, getFact } from '../vault/facts.ts';
import { USER_PROFILE_VAULT_SOURCE } from '../vault/user-profile.ts';
import { matchEntityByName } from './room-action-targets.ts';
import { effectiveSttForBinding, usejarvisVoiceCredentials } from './usejarvis-ai.ts';

/** The channel of the notch's conversation, and the name the dashboard lists it under. */
export const NOTCH_CHANNEL = 'notch';
export const NOTCH_CONVERSATION_LABEL = 'Notch';

export const NOTCH_UNDERSTAND_SYSTEM = [
  'Say in one short sentence what the person is asking for.',
  'Begin with a verb, or with "A question about".',
  'Do not answer it. Do not carry it out. Add nothing they did not say.',
].join(' ');

/**
 * How an approval is put in plain words for the notch. What is asked sees the
 * tool and its exact arguments and nothing else: not the conversation, not
 * what the agent read. So a page that steered the agent cannot also write the
 * sentence the person is asked to say yes to. The exact action is shown under
 * the sentence either way (src/notch/approvals.ts).
 */
export const NOTCH_APPROVAL_WORDS_SYSTEM = [
  'You are shown one action a computer assistant is about to take: the name of a tool and its exact arguments.',
  'Write the question the assistant should ask its owner before doing it.',
  'One short sentence, at most 14 words, in plain words for someone who is not technical.',
  'Say what it does and to what: name the app, file, folder or person.',
  'If it deletes, overwrites, sends, pays, installs or changes a setting, say that plainly.',
  'No tool names, no code, no flags, no long paths. Start with a verb. End with a question mark.',
  'Example: "Look up where Steam is installed?"',
  'Answer with the question only.',
].join(' ');

/** The model's reply as one question, or null when it is not one. */
export function approvalWords(raw: string): string | null {
  const line = raw.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  const plain = line.replace(/^["'`*\s]+|["'`*\s]+$/g, '').replace(/\s+/g, ' ');
  if (!/\p{L}/u.test(plain) || [...plain].length < 6) return null;
  const cut = [...plain].length > 110 ? `${[...plain].slice(0, 109).join('').trimEnd()}…` : plain;
  return /[?…]$/.test(cut) ? cut : `${cut.replace(/[.!]+$/, '')}?`;
}

export interface NotchAskOptions {
  db: Database;
  /** The desktop apps: their recordings arrive as events. */
  sidecars: NotchTalkPort;
  config(): JarvisConfig;
  llm(): LLMManager;
  /** The turn store, once the daemon has built it. */
  transport(): BriefChatTransport | null;
}

/** The notch's conversation: the newest one that is still warm, or a new one, shown as an open chat. */
function notchConversation(transport: BriefChatTransport): string {
  const id = getOrCreateConversation(NOTCH_CHANNEL, { label: NOTCH_CONVERSATION_LABEL }).id;
  // Open, so a dashboard that is up sees the turn as it runs. Too many open
  // chats already is no reason to refuse the instruction.
  try { transport.repository.conversations.setOpen(id, true); } catch { /* it stays in Closed chats */ }
  return id;
}

function turnDoor(transport: BriefChatTransport, db: Database): NotchTurnDoor {
  return {
    ready: () => transport.readiness() === 'ready',
    conversation: () => notchConversation(transport),
    submit: (turn) => { transport.submit(turn); },
    cancel: (turn) => { transport.cancelTurn(turn); },
    onEvent: (listener) => transport.onEvent(listener),
    look(turn) {
      let stored;
      try { stored = transport.repository.get(turn); } catch { return null; }
      const row = db.query<{ content: string }, [string]>('SELECT content FROM conversation_messages WHERE id = ?').get(stored.assistantMessageId);
      return { state: stored.state, text: row?.content ?? '' };
    },
  };
}

/** Whether a model would answer a turn now. The stand-in with nothing scripted does not count. */
export function notchModelReady(llm: LLMManager): boolean {
  if (Object.keys(llm.getTierMap()).length === 0) return false;
  return !(scriptedModelBound(llm) && scriptedTurns().length === 0);
}

export function notchAskDeps(options: NotchAskOptions): NonNullable<NotchRealDeps['asks']> {
  let door: { transport: BriefChatTransport; door: NotchTurnDoor } | null = null;
  const turns = (): NotchTurnDoor | null => {
    const transport = options.transport();
    if (!transport) return null;
    if (door?.transport !== transport) door = { transport, door: turnDoor(transport, options.db) };
    return door.door;
  };
  const small = async (subsystem: string, messages: { role: 'system' | 'user'; content: string }[], maxTokens: number): Promise<string> =>
    // The person's own turn: never held behind background work, and counted as theirs.
    runWithOrigin('user', async () => (await options.llm().chatTier('low', subsystem, messages, { max_tokens: maxTokens, temperature: 0 })).content);

  const write = createNotchRemember({
    ask: (messages) => small('notch_remember', messages, 200),
    entities: () => listEntityNames(),
    match: (entities, name) => matchEntityByName(entities, name),
    owner: () => findEntities({ source: USER_PROFILE_VAULT_SOURCE })[0] ?? null,
    createEntity: (type, name) => createEntity(type, name, undefined, NOTCH_TOLD_SOURCE),
    createFact: (subjectId, predicate, object, evidence) => createFact(subjectId, predicate, object, { ...evidence, confirmed: true }),
    read(factId) {
      const fact = getFact(factId);
      const subject = fact ? getEntity(fact.subject_id) : null;
      return fact && subject ? { subject: subject.name, predicate: fact.predicate, object: fact.object } : null;
    },
  });

  return {
    db: options.db,
    turns,
    modelReady: () => notchModelReady(options.llm()),
    talkPort: options.sidecars,
    stt: () => {
      const config = options.config();
      const binding = effectiveSttForBinding(config);
      return binding ? createSTTProvider(binding, usejarvisVoiceCredentials(config)) : null;
    },
    async remember(what, sentence, askId) {
      const result = await write(what, sentence, askId);
      if (result.ok) {
        // One history: it is in the notch's chat too, where the next turn reads it.
        try {
          const transport = options.transport();
          if (transport) {
            const conversationId = notchConversation(transport);
            addMessage(conversationId, { role: 'user', content: sentence });
            addMessage(conversationId, { role: 'assistant', content: result.said });
          }
        } catch (error) {
          console.warn('[notch] a remembered fact could not be added to the chat:', error instanceof Error ? error.message : error);
        }
      }
      return result;
    },
    async describeApproval(request) {
      const said = await small('notch_approval_words', [
        { role: 'system', content: NOTCH_APPROVAL_WORDS_SYSTEM },
        { role: 'user', content: `Tool: ${request.tool_name}\nArguments: ${request.tool_arguments.slice(0, 2000)}` },
      ], 60);
      return approvalWords(said);
    },
    async understand(text) {
      try {
        const said = (await small('notch_understood', [{ role: 'system', content: NOTCH_UNDERSTAND_SYSTEM }, { role: 'user', content: text }], 80))
          .replace(/\s+/g, ' ').trim();
        return said ? [...said].slice(0, 200).join('') : null;
      } catch {
        return null;
      }
    },
  };
}

/** The dev route's hold on the stand-in model, and its two ways of sending words (src/notch/script.ts). */
export function notchScriptDeps(options: {
  llm(): LLMManager;
  type(text: string): void;
  say(text: string | null): void;
}): NotchScriptDeps {
  return {
    load(turns) {
      setScriptedTurns(turns);
      return bindScriptedModel(options.llm());
    },
    turns: () => scriptedTurns(),
    calls: () => scriptedCalls(),
    bound: () => scriptedModelBound(options.llm()) && scriptedTurns().length > 0,
    type: options.type,
    say: options.say,
  };
}
