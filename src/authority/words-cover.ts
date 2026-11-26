/**
 * What the owner's words asked for.
 *
 * Decided by the owner on 26 November 2026 (owner-word.ts): once a turn they
 * typed or spoke has read something they did not write, an act that reaches
 * out or runs code is asked about again, unless their own sentence asked for
 * that kind of act. There are four kinds (`OwnerAct`, below): a send,
 * a command, an install, a change of settings. This file says which of them a
 * sentence asked for. It is asked once, where the turn is made
 * (notch/asks.ts), and the answer goes with the turn's standing.
 *
 * Three things can say it, in this order:
 *
 *   1. a fixed intent took the sentence (notch/intents.ts): its `act` says.
 *      An intent whose act is `answer` is a yes to a line that was up, and
 *      covers what that line was about, which the caller hands in (`line`);
 *   2. a reading of the sentence by the notch's own classifier
 *      (notch/intent-read.ts, point 3 of the review): the act it returns for
 *      a sentence the fixed words missed. THE SEAM: that classifier is not on
 *      this branch yet, so nobody passes `read` today. When it is, its answer
 *      takes the place of the reader below, and the reader stays as what is
 *      used when the classifier could not answer in time;
 *   3. the reader below, which is deliberately small: verb families in
 *      English and Italian, matched on the sentence with no model.
 *
 * The reader fails closed. A sentence it cannot place asks for nothing, and
 * then the act is asked about: one question more, never one fewer. It reads
 * the bare and the infinitive form of a verb ("send", "to send", "invia",
 * "inviare"), not what is told about ("the mail Anna sent", "sending"). A
 * verb after a "don't", a "without" or a "non" is not asked for. A sentence
 * that begins as a question ("how do I install node?") asks for an answer
 * and for nothing else; "can you ..." and "puoi ..." are requests. To draft,
 * prepare or write a reply is not to send it.
 *
 * What it gets wrong, in both directions, is pinned row by row in
 * words-cover.test.ts.
 */
import type { NotchIntentAct } from '../notch/intents.ts';

/**
 * The kinds of act that reach out or run code. In a turn that has read
 * outside content these, and only these, are asked about again when the
 * owner's own words did not ask for them (owner-word.ts).
 */
export type OwnerAct = 'send' | 'command' | 'install' | 'settings';

export const OWNER_ACTS: readonly OwnerAct[] = ['send', 'command', 'install', 'settings'];

/** Lower case, accents and curly quotes folded, one space between words. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019\u02bc`]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Where a verb can stand as something to do: at the start, after a comma or a full stop, or after a word that leads to one. */
const LEADS = 'and|then|please|to|you|i|we|also|now|just|e|poi|quindi|ed';
const START = String.raw`(?:^|[,.;:!?]\s*|\b(?:${LEADS})\s+)`;
const LEAD = new RegExp(String.raw`^(?:[,.;:!?]\s*|(?:${LEADS})\s+)`);

/** Endings of an Italian verb in -are that tell somebody to do it, or name the doing ("invia", "inviagli", "inviare", "inviarlo"). */
const ARE = String.raw`(?:a|i|are|ami|agli|ale|alo|ala|ali|amelo|aglielo|aglieli|arlo|arla|arli|argli|arle|armi|iamo|ate|ino|erai)`;
/** The same for -ere and -ire. */
const ERE = String.raw`(?:i|a|ere|ire|imi|igli|ile|ilo|ila|ili|erlo|erla|ergli|erle|irlo|irla|irgli|iamo|ete|ite|ano|ero|iro)`;

type Family = { act: OwnerAct; also?: OwnerAct; pattern: RegExp; not?: RegExp; after?: RegExp; ask?: true };

/**
 * `not`: the words just before the match that make it something else ("the
 * reply", "look forward"). `after`: the words just after it that do ("run
 * through", "tell me"). `ask`: a form that only the assistant's own question
 * has ("Lo invio?"), never an instruction.
 */
const FAMILIES: readonly Family[] = [
  // A send, in English.
  { act: 'send', pattern: /\b(?:re-?send|send|cc|bcc)\b/g },
  { act: 'send', pattern: /\bforward\b/g, not: /\b(?:move|moving|go|going|look|looking|fast|step|scroll|skip|bring|going|straight)\s+$/ },
  { act: 'send', pattern: /\b(?:reply|respond)\b/g, not: /(?:\b(?:the|a|an|this|that|his|her|their|its|my|your|every|each|no|last|latest|first)|'s)\s+$/ },
  { act: 'send', pattern: new RegExp(`${START}(?:e-?mail|mail|message|text|dm|ping|whatsapp|telegram|slack)\\b`, 'g'),
    after: /^\s+(?:from|about|that|which|who|is|was|are|were|says|said|thread|chain|file|box|client|app|address|attachment|draft|signature|i|in|on|with|and|or|field|editor|size|color|colour|(?:the\s+|a\s+|my\s+)?(?:server|host|ip|router|gateway|localhost|machine|site|\d))\b|^\s*$/ },
  { act: 'send', pattern: /\b(?:notify|invite|tweet|publish)\b/g },
  { act: 'send', pattern: /\btell\b/g, after: /^\s+(?:me|us|myself|if|whether|what|which|how|why|when|where|apart|the\s+difference)\b|^\s*$/ },
  { act: 'send', pattern: /\blet\s+(?!me\b|us\b)[\w'.@-]+(?:\s+[\w'.@-]+){0,2}\s+know\b/g },
  { act: 'send', pattern: /\bshare\b[^.!?]{0,80}\bwith\b/g },
  { act: 'send', pattern: /\bpost\s+(?:[\w'-]+\s+){0,4}(?:to|on|in)\s/g },
  { act: 'send', pattern: /\bwrite\s+(?:back\s+)?to\b/g, after: /^\s+(?:(?:a|the|this|that|my)\s+)?(?:file|disk|notepad|clipboard|log|page|document|doc|sheet|table|database|db|[\w-]+\.\w{1,5})\b/ },
  { act: 'send', pattern: /\banswer\s+(?:him|her|them|back|(?:the|this|that|his|her|their)\s+(?:e-?mail|mail|message)|[\w.-]+'s\s+(?:e-?mail|mail|message))\b/g },
  { act: 'send', pattern: /\bget\s+back\s+to\b/g },
  // A send, in Italian.
  { act: 'send', pattern: new RegExp(String.raw`\b(?:invi|mand|inoltr|avvis|notific|pubblic)${ARE}\b`, 'g'), not: /\b(?:la|una|le|della|delle|di|pagina|versione)\s+$/,
    after: /^\s+(?:avanti|indietro|via|giu|su)\b/ },
  { act: 'send', pattern: new RegExp(String.raw`\b(?:rispond|condivid|avvert|spedisc)${ERE}\b`, 'g') },
  { act: 'send', pattern: /\bspedi(?:re|rlo|rla|rgli|amo|te)\b/g },
  { act: 'send', pattern: /\bscriv(?:i|ere|imi)\s+(?:a|ad|al|allo|alla|ai|agli|alle)\s|\bscriv(?:igli|ile|ergli|erle)\b/g, after: /^(?:un|una|il|lo|la)?\s*(?:file|foglio|documento|blocco|notepad)\b/ },
  { act: 'send', pattern: /\bdi'?\s+(?:a|ad|al|allo|alla|ai|agli|alle)\s|\b(?:dillo|dilla|digli|dille|dirgli|dirle|diglielo)\b/g },
  { act: 'send', pattern: /\bfa(?:i|gli|lle|tegli|rgli|re)?\s+sapere\b/g, after: /^\s*$/ },
  { act: 'send', ask: true, pattern: /\b(?:invio|mando|inoltro|avviso|notifico|pubblico|rispondo|condivido|spedisco|scrivo)\b/g },

  // A command, in English.
  { act: 'command', pattern: /\b(?:re-?run|run|execute|exec)\b/g, not: /\b(?:a|the|this|that|test|last|dry|trial|practice|morning|evening|long|short|first|next)\s+$/,
    after: /^\s+(?:(?:me|us|it|this|that)\s+)?(?:through|by\s+me|past|into|out\s+of|low|late|over\s+(?:it|this|that)\s+with)\b/ },
  { act: 'command', pattern: /\b(?:in|from|on|via|using|with|into|open|use)\s+(?:(?:the|a|my)\s+)?(?:terminal|shell|command\s+line|command\s+prompt|powershell|bash|zsh|cmd|console)\b/g },
  { act: 'command', pattern: new RegExp(`${START}(?:git|npm|npx|bun|bunx|pnpm|yarn|pip|pip3|docker|cargo|brew|apt|apt-get|winget|choco|kubectl|ssh|curl|wget|sudo)\\s+\\S`, 'g') },
  { act: 'command', pattern: /\b(?:compile|recompile|rebuild|deploy|redeploy)\b/g, not: /\b(?:the|a|last|latest|failed)\s+$/ },
  { act: 'command', pattern: /\bbuild\s+(?:(?:the|this|my|that)\s+)?(?:project|app|repo|code|image|container|package|binary|site|it)\b/g },
  { act: 'command', pattern: /\bcommit\s+(?:(?:the|this|my|these|all)\s+)?(?:changes?|code|files?|fix|it)\b/g },
  { act: 'command', pattern: /\bpush\s+(?:(?:the|this|my|it)\s+)?(?:changes?|branch|code|commits?|to\s+(?:origin|github|gitlab|main|master|prod\w*|staging))\b/g },
  { act: 'command', pattern: /\b(?:restart|start|stop|kill)\s+(?:(?:the|this|my|that)\s+)?(?:[\w-]+\s+)?(?:server|service|daemon|process|container)\b/g },
  // A command, in Italian.
  { act: 'command', pattern: /\besegu(?:i|ire|ilo|ila|ili|irlo|irla|irli|iamo|ite)\b/g },
  { act: 'command', pattern: /\b(?:lanci|avvi|riavvi|ferm)(?:a|are|alo|ala|arlo|arla|i)\s+(?:(?:il|lo|la|i|gli|le|un|uno|una|questo|questa)\s+)?(?:comando|script|test|build|server|servizio|processo|compilazione|container)\b/g },
  { act: 'command', pattern: /\b(?:nel|dal|sul|col|con\s+il|apri\s+il|usa\s+il)\s+(?:terminale|prompt|shell)\b|\b(?:da|a|dalla)\s+riga\s+di\s+comando\b/g },
  { act: 'command', pattern: /\b(?:ri)?compil(?:a|are|alo|ala|i)\s+(?:(?:il|lo|la|l'|questo|questa)\s*)?(?:progetto|codice|programma|sorgente|sorgenti|app|applicazione)\b/g },
  { act: 'command', pattern: /\bfa(?:i|llo|lla|re)?\s+(?:girare|partire)\s+(?:(?:il|lo|la|i|gli|le|un|uno|una|questo|questa)\s+)?(?:comando|script|test|build|server|servizio|processo|container)\b/g },
  { act: 'command', pattern: /\b(?:committa|committare|pusha|pushare|deploya|deployare)\b/g },
  { act: 'command', ask: true, pattern: /\b(?:eseguo|lancio|avvio|riavvio)\b/g },

  // An install, in both.
  { act: 'install', pattern: /\b(?:install|re-?install|uninstall|upgrade)\b/g, not: /\b(?:the|a|an|this|that|clean|fresh|last|failed)\s+$/ },
  { act: 'install', also: 'command', pattern: /\b(?:npm|pnpm|yarn|bun|pip|pip3|brew|apt|apt-get|winget|choco|cargo|gem|dnf|pacman)\s+(?:i|install|add)\b/g },
  { act: 'install', pattern: /\badd\s+(?:(?:the|this|that|a|an)\s+)?(?:[\w.@/-]+\s+)?(?:extension|plugin|plug-in|add-on|addon|package|dependency|library|module)\b/g },
  { act: 'install', pattern: /\b(?:re|dis)?install(?:a|are|ami|alo|ala|ali|arlo|arla|arli|i|iamo|ate)\b/g },
  { act: 'install', pattern: /\baggiung(?:i|ere)\s+(?:(?:il|la|lo|l'|un|una|questo|questa)\s*)?(?:[\w.@/-]+\s+)?(?:estensione|plugin|pacchetto|dipendenza|libreria|modulo)\b/g },
  { act: 'install', ask: true, pattern: /\b(?:re|dis)?installo\b/g },

  // A change of settings, in English.
  { act: 'settings', pattern: /\b(?:enable|disable|toggle|mute|unmute|configure|reconfigure)\b/g },
  { act: 'settings', pattern: /\b(?:turn|switch)\s+(?:(?:it|this|that|the|my)\s+)?(?:[\w-]+\s+){0,3}(?:on|off)\b|\b(?:turn|switch)\s+(?:on|off)\b/g },
  { act: 'settings', pattern: /\b(?:change|set|update|adjust|reset|raise|lower)\s+(?:(?:the|my|this|that|its)\s+)?(?:[\w-]+\s+){0,3}(?:settings?|preferences?|defaults?|options?|wallpaper|resolution|volume|brightness|theme|language|time\s*zone|password|mode|permissions?)\b/g },
  { act: 'settings', pattern: /\bmake\s+(?:(?:the|my|this|that)\s+)?[\w-]+(?:\s+[\w-]+){0,2}\s+(?:the|my)\s+default\b/g },
  // And in Italian.
  { act: 'settings', pattern: new RegExp(String.raw`\b(?:attiv|disattiv|abilit|disabilit|impost|configur|silenzi)${ARE}\b`, 'g'), not: /\b(?:la|una|le|della|delle)\s+$/ },
  { act: 'settings', pattern: /\b(?:cambi|modific|regol|alz|abbass)(?:a|are|alo|ala|ami|i)\s+(?:(?:il|lo|la|le|i|gli|l'|questo|questa|mio|mia)\s*){0,2}(?:[\w-]+\s+){0,2}(?:impostazion[ei]|preferenz[ae]|predefinit[oa]|opzion[ei]|sfondo|risoluzione|volume|luminosita|tema|lingua|fuso|password|modalita|permess[oi])\b/g },
  { act: 'settings', pattern: /\b(?:accend|spegn)(?:i|ere|ilo|ila)\s+(?:(?:il|lo|la|l')\s*)?(?:wi-?fi|bluetooth|microfono|audio|notifiche|modalita\b[\w\s]{0,20})/g },
  { act: 'settings', ask: true, pattern: /\b(?:attivo|disattivo|abilito|disabilito|imposto|configuro|cambio|modifico)\b/g },
];

/** A word in the three before a verb that takes it back, and for a send in the four before it a word that only gets it ready. */
const NEGATES = /^(?:don't|dont|not|never|no|without|cannot|can't|cant|shouldn't|mustn't|won't|wouldn't|avoid|stop|non|senza|mai|evita|evitare|niente)$/;
/** And a word in the three before it that makes it something talked about: "how to reply", "who should reply". */
const TALKS = /^(?:how|whether|should|must|who)$/;
const READIES = /^(?:draft|prepare|compose|outline|sketch|suggest|propose|bozza|abbozza|prepara|preparami|preparare|suggerisci|proponi)$/;

/** How a sentence starts when it asks for an answer and not for a thing to be done. */
const ASKS_ABOUT = /^(?:how|what|what's|whats|why|when|where|who|whom|which|whose|is|are|was|were|am|does|do\s+(?:i|we|they)|did|has|have|had|should\s+(?:i|we)|must\s+(?:i|we)|may\s+(?:i|we)|come|cosa|che\s+cosa|cos'e|cos'|perche|quando|dove|chi|quale|quali|quanto|quanti|e'\s|devo|dovrei|posso)\b/;

function wordsBefore(text: string, index: number, count: number): string[] {
  return text.slice(Math.max(0, index - 80), index).split(/[^\w'@-]+/).filter(Boolean).slice(-count);
}

/**
 * The reader: the acts a sentence asks for, read from the sentence alone.
 *
 * `as`: 'instruction' is what the owner wrote or said. 'question' is what the
 * assistant asked back and the owner said only yes to ("Shall I send it?",
 * "Lo invio?"): it is a question by its making, so its start does not rule
 * it out, and the first person of an Italian verb is read too.
 */
export function readActs(sentence: unknown, as: 'instruction' | 'question' = 'instruction'): OwnerAct[] {
  if (typeof sentence !== 'string') return [];
  const text = fold(sentence).slice(0, 2000);
  if (!text) return [];
  if (as === 'instruction' && ASKS_ABOUT.test(text)) return [];
  const found = new Set<OwnerAct>();
  for (const family of FAMILIES) {
    if (family.ask && as !== 'question') continue;
    if (found.has(family.act) && (!family.also || found.has(family.also))) continue;
    family.pattern.lastIndex = 0;
    for (let match = family.pattern.exec(text); match; match = family.pattern.exec(text)) {
      if (match[0] === '') { family.pattern.lastIndex += 1; continue; }
      // The verb itself, past whatever led to it ("and then email ...").
      const lead = LEAD.exec(match[0]);
      const at = match.index + (lead ? lead[0].length : 0);
      const before = text.slice(0, at);
      const after = text.slice(match.index + match[0].length);
      if (family.not?.test(before)) continue;
      if (family.after?.test(after)) continue;
      // "I mail the report every Friday" tells of something; only a question the assistant asked says "Shall I mail ...".
      if (as === 'instruction' && lead && /^(?:i|we)\s/.test(lead[0])) continue;
      if (wordsBefore(text, at, 3).some((word) => NEGATES.test(word) || (as === 'instruction' && TALKS.test(word)))) continue;
      if (family.act === 'send' && wordsBefore(text, at, 4).some((word) => READIES.test(word))) continue;
      found.add(family.act);
      if (family.also) found.add(family.also);
      break;
    }
  }
  return OWNER_ACTS.filter((act) => found.has(act));
}

/**
 * The question a bare yes agrees to: the last sentence of what the assistant
 * asked, and the one before it when the last is only a few words ("I can
 * mail this to Anna. Shall I?"). What stood earlier in the answer is not
 * what was asked.
 */
export function questionAsked(answer: unknown): string {
  if (typeof answer !== 'string') return '';
  const sentences = answer.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  const short = last.split(/\s+/).length < 4;
  return (short ? sentences.slice(-2) : [last]).join(' ');
}

/** The kind of act an intent of the notch's table stands for, as one of the four that are asked about. */
export function actsOfIntent(act: NotchIntentAct | null | undefined, line: readonly OwnerAct[] = []): OwnerAct[] {
  switch (act) {
    case 'send': return ['send'];
    case 'command': return ['command'];
    case 'install': return ['install'];
    case 'settings': return ['settings'];
    // A yes to a line that was up: what it covers is what the line was about.
    case 'answer': return OWNER_ACTS.filter((one) => line.includes(one));
    // none, screen, create: nothing that reaches out or runs code.
    default: return [];
  }
}

/** What is known about some words when a turn is made of them. */
export interface WordsSaid {
  words: string;
  /** The act of the fixed intent that took the sentence, when one did. */
  intent?: NotchIntentAct | null;
  /** For an intent that answers a line: what that line was about. */
  line?: readonly OwnerAct[];
  /**
   * THE SEAM (see the top of this file): the act the notch's classifier
   * read for a sentence that no fixed intent took ('none': it asks for none
   * of the four). Undefined or null: it was not asked or did not answer, and
   * the reader decides.
   */
  read?: NotchIntentAct | null;
}

/** The acts some words asked for. The one function the notch asks when it makes a turn. */
export function wordsCover(said: WordsSaid): OwnerAct[] {
  if (said.intent) return actsOfIntent(said.intent, said.line);
  if (said.read !== undefined && said.read !== null) return actsOfIntent(said.read, said.line);
  return readActs(said.words);
}
