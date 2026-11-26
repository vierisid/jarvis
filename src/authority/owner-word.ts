/**
 * Saying it is the approval.
 *
 * Decided by the owner on 13 November 2026, after using the notch for a day:
 * "If I ask something, it should do it. Everything apart from deleting and
 * payments. It shouldn't ask me for approval after I said it. Saying is
 * approval." Every step of "open Notepad and write a poem" had been stopping
 * for a yes.
 *
 * So, in a turn the owner started on the notch with their own hands or voice,
 * a call is not asked about. Two things still are, always, by the owner's own
 * words:
 *
 *   - a delete: something is removed and may not come back;
 *   - a payment: money moves.
 *
 * What is recognised as one of those, and it is every sign this side has:
 *
 *   - a category the call's own gate names (`delete_data`, `make_payment`):
 *     a tool that deletes, the model's own declared intent, an on-screen
 *     action whose control reads as "Delete" or "Buy now" (`uiEffectHints`);
 *   - a command that deletes, read from its text (`commandDeletes`);
 *   - a Delete key (`keysDelete`);
 *   - for a raw click, what the machine says is at that place, read the same
 *     way as a control's label (the probe, set by the daemon). When a
 *     machine that can say what is there fails to, also on a second try, the
 *     click is asked about.
 *
 * ## After outside content: what was not asked for
 *
 * Decided by the owner on 26 November 2026. "Saying it is the approval" is
 * about what they said. Once the turn has read something they did not write
 * (a page, a file, a window, a mail, a colleague's message, memory they did
 * not enter, the assistant's own question that they only said yes to), text
 * in it can ask for things they never asked for. From then on, in that turn,
 * four kinds of act are asked about again, and only when their own sentence
 * did not ask for that kind of act:
 *
 *   - a send (`send_email`, `send_message`): something goes to somebody;
 *   - a command (`execute_command`): a program or a script is run. An app
 *     started with arguments, or a shell, a script host or an installer
 *     started at all, is a command by another name (`plainAppOpen` says
 *     which opens are plain);
 *   - an install (`install_software`);
 *   - a change of settings (`modify_settings`).
 *
 * Which of them a call is, is said in one place (`callActs`), from the
 * categories the product's one gate gave the call (`resolveToolGate`) and,
 * for a raw click, from what the machine says is at that place. What the
 * owner's sentence asked for is read once, where the turn is made
 * (words-cover.ts), and travels with the turn's standing (`covers`).
 *
 * Everything else is as it was on 13 November, also after outside content: a
 * click, typed text, a key press, a page, a file written, a plain app opened,
 * a helper started. "Open Notepad and write a poem" still runs with no
 * question, and so does a turn that has read nothing, whatever it does.
 * Asking about everything after outside content was what the owner rejected
 * on 13 November, since opening an app is itself outside content.
 *
 * Three narrower things follow from the same decision:
 *
 *   - a command that installs (`npm install`, `winget install`, an
 *     installer) is asked for by "install ...", and a command that changes
 *     a setting (`reg add`, `defaults write`) by "turn on ...": the owner
 *     named the thing, not the tool (`commandInstalls`, `commandSets`). No
 *     other command is covered by those words;
 *   - a send whose recipients can be read from the call must go to somebody
 *     the owner's words name: "send it to Anna" does not cover a send to
 *     somebody else in the same turn. A name is matched as a word against
 *     the address or the name the call gives; "reply" names nobody and
 *     covers whoever wrote the thing. Where the call names no recipient (a
 *     click on Send), the kind alone decides;
 *   - a raw click where the machine cannot look by its making (screen
 *     awareness off, a Mac or Linux desktop app, no machine) goes ahead in a
 *     turn that has read nothing, and is asked about in one that has: what
 *     it lands on cannot be read, and what was read may have chosen it.
 *
 * It is a reading, not a proof. A delete written so that none of this sees it
 * (a script that removes files, a button with no name) goes ahead like
 * anything else. After outside content, clicks and typed text are still not
 * asked about, so text that was read can still drive an app by its buttons;
 * a button that reads as Send, Delete or Buy is caught by its name. When the
 * owner did ask for a send, what was read can still shape its wording. That
 * is the price of not being asked, and it is the owner's to pay.
 * What is NOT waived: a call the product refuses outright (it stays
 * refused), and a call whose own classifier failed (nothing is known about
 * it, so it is asked about).
 *
 * Where it applies: only inside a turn the owner started on the notch, and
 * only with the notch switch on. Dashboard chat, Telegram, background agents
 * and workflows are judged as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionCategory } from '../roles/authority.ts';
import { ownersTurn, plainAppOpen } from './app-open.ts';
import type { OwnerAct } from './words-cover.ts';

/** What is still asked about when the owner asked for the thing themselves. */
export const STILL_ASKED: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['delete_data', 'make_payment']);

/**
 * Whether a command's text removes something. Shell, PowerShell and the
 * common tools that delete by a verb of their own. Read on the command as
 * written, so a name in quotes or after a pipe is seen too.
 */
/** A letter of a word in a command: not a space, a break between commands, a quote, a redirect or an equals sign. */
const LETTER = String.raw`[^\s;&|"'<>=]`;
/** The folder a program is named with (`/bin/`, `.\tools\`), and one that holds programs, for where less is certain. */
const FOLDER = String.raw`(?!-)${LETTER}{0,256}[\\/]`;
const PROGRAM_FOLDER = String.raw`(?!-)(?:${LETTER}{0,256}bin[\\/]|[A-Za-z]:\\${LETTER}{0,256}\\)`;

/**
 * What may stand between the place a command starts and its own word, none of
 * which changes what runs: a variable set for that one command (`FOO=1`), a
 * word that only runs what follows (`env`, `command`, `nohup`, `time`, `nice`,
 * `timeout`, `busybox`, and `sudo` again), also by its path (`/usr/bin/env`),
 * such a word's own options with at most one value each (`-n 10`,
 * `-u www-data`, `-I {}`), the two dashes that end them, and a bare number
 * (`timeout 5`). Each kind starts differently from the others and an option's
 * value may be none of them, so a run of them reads one way only. None of
 * them runs over a break between commands (; & |), and no more than sixteen
 * are read, so the time this takes grows with the length of the command and
 * no faster (pinned by a test on 200,000 letters).
 */
const RUNS_WHAT_FOLLOWS = 'sudo|doas|env|command|builtin|nohup|time|nice|ionice|timeout|stdbuf|setsid|busybox|toybox|xargs|exec';
const BEFORE_THE_WORD = [
  String.raw`[A-Za-z_]\w*=(?:"[^"]{0,256}"|'[^']{0,256}'|[^\s"';&|]*)\s+`,
  // (`command -v rm` only says where rm is.)
  String.raw`(?!command\s+-[vV]\s)(?:${FOLDER})?(?:${RUNS_WHAT_FOLLOWS})\s+`,
  String.raw`-{1,2}\w[\w-]*(?:=[^\s;&|]*)?\s+(?:(?!(?:${FOLDER})?(?:${RUNS_WHAT_FOLLOWS})\s)[^\s\d=;&|-][^\s=;&|]*\s+)?`,
  String.raw`--\s+`,
  String.raw`\d+(?:\.\d+)?[smhd]?\s+`,
].join('|');
const PAST_THOSE = String.raw`\s*(?:${BEFORE_THE_WORD}){0,16}\\?`;

/**
 * Where a command word can stand. For certain: at the start, after ; & | ( a
 * newline or a backtick, or after a word that runs what follows. Perhaps:
 * after a quote, or after the -c or /c that hands a command to a shell (a
 * quote may as well close what came before, and -c is an option of many
 * programs). Then past what changes nothing (above) and past the backslash
 * that steps round an alias (`\rm`).
 */
const FOR_CERTAIN = String.raw`(?:^|[;&|(\n\`]|\b(?:sudo|doas|xargs|exec|then|do|else)\s|-exec(?:dir)?\s)`;
const PERHAPS = String.raw`(?:["']|(?:\/[ck]|-c|-command)\s+["']?)`;

/** The verbs that remove, in a shell, in cmd and as PowerShell's short names; and those of them that are programs with a path. */
const VERBS = String.raw`(?:rm|rmdir|unlink|shred|srm|del|erase|rd|ri|rimraf|trash|trash-put|sdelete(?:64)?)(?:\.exe)?(?=\s|$)`;
const PROGRAMS = String.raw`(?:rm|rmdir|unlink|shred|srm|rimraf|trash|trash-put|sdelete(?:64)?)(?:\.exe)?(?=\s|$)`;

const DELETES: readonly RegExp[] = [
  new RegExp(`(?:${FOR_CERTAIN}|${PERHAPS})${PAST_THOSE}${VERBS}`, 'i'),
  // Named by its path (`/bin/rm`, `.\\tools\\sdelete.exe`). Where the start is
  // only perhaps one, the folder has to be one that holds programs:
  // `grep "x" docs/rm` and `du -c ~/.local/share/Trash` name a file.
  new RegExp(`${FOR_CERTAIN}${PAST_THOSE}(?:${FOLDER})${PROGRAMS}`, 'i'),
  new RegExp(`${PERHAPS}${PAST_THOSE}(?:${PROGRAM_FOLDER})${PROGRAMS}`, 'i'),
  // PowerShell by its long names.
  /\b(?:Remove-[A-Za-z]+|Uninstall-[A-Za-z]+|Unregister-[A-Za-z]+|Clear-(?:Content|Item|ItemProperty|RecycleBin|Disk|EventLog))\b/i,
  /\[(?:System\.)?IO\.(?:File|Directory)\]::Delete/i,
  // What a tool deletes by its own word.
  /\bfind\b[^|;&]*\s-delete\b/i,
  /\bgit\s+(?:clean|rm|reset\s+--hard|checkout\s+--\s|branch\s+-D|stash\s+(?:drop|clear))/i,
  /\brsync\b[^|;&]*\s--delete/i,
  /\brobocopy\b[^|;&]*\s\/(?:MIR|PURGE)\b/i,
  /\b(?:docker|podman)\s+(?:(?:image|container|volume|network|system)\s+)?(?:rm|rmi|prune)\b/i,
  /\bkubectl\s+delete\b/i,
  /\b(?:winget|choco|scoop|brew|apt|apt-get|dnf|yum|pip|pip3|npm|pnpm|yarn|bun|cargo|gem)\s+(?:uninstall|remove|purge|rm|autoremove)\b/i,
  /\bpacman\s+-R/,
  /\bmsiexec\b[^|;&]*\s\/x\b/i,
  /\b(?:reg(?:\.exe)?\s+delete|schtasks\b[^|;&]*\s\/delete|net\s+(?:user|share|localgroup)\b[^|;&]*\s\/delete|wmic\b[^|;&]*\bdelete\b)/i,
  /\b(?:format(?:\.com)?\s+[a-z]:|diskpart\b|mkfs(?:\.\w+)?\b|wipefs\b|cipher\s+\/w\b|vssadmin\s+delete\b|wevtutil\s+cl\b)/i,
  /\bdd\b[^|;&]*\bof=/i,
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i,
  // A script given on the command line that removes files.
  /\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|(?:fs|fsPromises|promises)\.(?:rm|rmdir|unlink)(?:Sync)?|unlinkSync|rmSync|rmdirSync|File\.Delete|Directory\.Delete|FileUtils\.rm\w*)\b/,
  // A file or a folder removed by its own method: pathlib's `Path(x).unlink()`, PowerShell's `(Get-Item x).Delete()`.
  // (On something: `grep ".Delete(" src` only looks for the word.)
  /[\w)\]]\.(?:unlink|rmdir|rmtree|Delete)\s*\(/,
  // Emptying a file: writing nothing over it.
  /(?:^|[;&|\n])\s*(?::\s*)?>\s*[^\s&|>]/,
  /\btruncate\s+-s\s*0\b/i,
];

/**
 * A push that throws away what the other side had. Read one command at a
 * time, with `git` where a command starts (so a push that is only written
 * about, in a commit message or an echo, is not one), and then by what
 * follows the word: forced (`--force`, `-f`, `-fu`), a delete (`--delete`,
 * `-d`, `:branch`), `--mirror`, `--prune`, or a + before the branch.
 */
const PUSH = new RegExp(String.raw`(?:^[\s({$\`]*|(?:\/[ck]|-c|-command|\beval)\s+["']\s*)(?:(?:then|do|else)\s+)?(?:${BEFORE_THE_WORD}){0,16}(?:${FOLDER})?git(?:\.exe)?\s+(?:-{1,2}\w[\w-]*(?:=\S*)?\s+(?:[^\s-]\S*\s+)?){0,8}push(?=\s|$)`);
const THROWS_AWAY = /(?:^|\s)(?:--(?:force(?:-with-lease|-if-includes)?|delete|mirror|prune)(?=[\s="')`]|$)|-[A-Za-z]*[fd][A-Za-z]*(?=[\s"')`]|$)|["']?[+:][\w./-])/;

function pushThrowsAway(command: string): boolean {
  if (!command.includes('push')) return false;
  return command.split(/[;&|\n]/).some((part) => {
    const push = PUSH.exec(part);
    return push !== null && THROWS_AWAY.test(part.slice(push.index + push[0].length));
  });
}

export function commandDeletes(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  return DELETES.some((pattern) => pattern.test(command)) || pushThrowsAway(command);
}

/**
 * Whether a key press deletes: the Delete key in any chord (in a file list
 * that removes the file), or on a Mac the command key with backspace, which
 * is how a file goes to the Trash there (and, with more keys, past it).
 * `desktop` is false for keys sent into a page, where the command key with
 * backspace rubs out a line of text and never a file.
 */
export function keysDelete(keys: unknown, desktop = true): boolean {
  if (typeof keys !== 'string') return false;
  const held = keys.split(/[,+]/).map((key) => key.trim().toLowerCase());
  if (held.some((key) => /^(?:delete|del|forwarddelete|kp_delete)$/.test(key))) return true;
  return desktop && held.some((key) => /^(?:backspace|bs)$/.test(key)) && held.some((key) => /^(?:cmd|command|meta|super|win|windows)$/.test(key));
}

/** The words of a call that can hold a command: the product's own tools for running one. */
function commandText(toolName: string, params: Record<string, unknown>): string {
  if (toolName !== 'run_command' && !/(^|_)(exec|shell|command|terminal)($|_)/.test(toolName)) return '';
  const parts: string[] = [];
  for (const key of ['command', 'cmd', 'script', 'args']) {
    const value = params[key];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(value.filter((item): item is string => typeof item === 'string').join(' '));
  }
  return parts.join('\n');
}

/** What can be told from the call itself, without asking any machine: it deletes, or it pays. */
export function callDeletesOrPays(toolName: string, params: Record<string, unknown>, categories: readonly ActionCategory[]): boolean {
  if (categories.some((category) => STILL_ASKED.has(category))) return true;
  if (commandDeletes(commandText(toolName, params))) return true;
  if (toolName === 'desktop_press_keys' && keysDelete(params.keys ?? params.key)) return true;
  if (toolName === 'browser_press_key' && keysDelete(params.keys ?? params.key, false)) return true;
  return false;
}

/**
 * A command that installs something: a package manager told to install or
 * add, an installer run. Read so that "install ..." covers the command that
 * does it, and no other command.
 */
const INSTALLS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun|pip|pip3|pipx|uv|brew|apt|apt-get|dnf|yum|zypper|winget|choco|scoop|cargo|gem|go|snap|flatpak|port|conda|mamba|composer|dotnet\s+tool)\s+(?:-\S+\s+)*(?:i|install|add|upgrade|update)\b/i,
  /\b(?:pacman|yay|paru)\s+-S|\bcode(?:\.cmd)?\s+--install-extension\b/,
  /\bmsiexec\b[^|;&]*\s\/i\b/i,
  /\bdpkg\s+-i\b|\brpm\s+-[iU]|\binstaller\s+-pkg\b|\bInstall-(?:Module|Package|Script)\b|\bAdd-AppxPackage\b/i,
  /(?:^|[\s"'\\/])[\w .()-]*(?:setup|install(?:er)?)[\w .()-]*\.(?:exe|msi|pkg|dmg|deb|rpm|appimage|sh)\b/i,
];

export function commandInstalls(command: unknown): boolean {
  return typeof command === 'string' && command.trim() !== '' && INSTALLS.some((pattern) => pattern.test(command));
}

/** A command that changes a setting of the system by the system's own tool for it. */
const SETS: readonly RegExp[] = [
  /\breg(?:\.exe)?\s+add\b|\b(?:Set|New)-ItemProperty\b|\bSet-(?:ExecutionPolicy|TimeZone|Culture|WinUserLanguageList|MpPreference|NetConnectionProfile|DnsClientServerAddress)\b/i,
  /\bdefaults\s+write\b|\b(?:networksetup|systemsetup|pmset)\s+-\w|\bscutil\s+--set\b/i,
  /\bgsettings\s+set\b|\bdconf\s+write\b|\btimedatectl\s+set-|\bnmcli\b[^|;&]*\b(?:on|off|up|down|modify)\b|\bxdg-settings\s+set\b/i,
  /\b(?:powercfg|netsh)\b|\bsetx\s/i,
];

export function commandSets(command: unknown): boolean {
  return typeof command === 'string' && command.trim() !== '' && SETS.some((pattern) => pattern.test(command));
}

const ACT_OF: Partial<Record<ActionCategory, OwnerAct>> = {
  send_email: 'send',
  send_message: 'send',
  execute_command: 'command',
  install_software: 'install',
  modify_settings: 'settings',
};

/**
 * Which of the four kinds of act a call is: the one place that says it. The
 * categories are the ones the product's gate gave the call
 * (`resolveToolGate`: the tool's own entry, its per-call gate, an on-screen
 * control's label), with what the machine read at a raw click's place added
 * by the caller. Nothing here keeps a list of tools.
 */
export function callActs(toolName: string, params: Record<string, unknown>, categories: readonly ActionCategory[]): OwnerAct[] {
  const acts = new Set<OwnerAct>();
  for (const category of categories) {
    const act = ACT_OF[category];
    if (act) acts.add(act);
  }
  // An app told what to do, or a program that is not an app: a command by another name (app-open.ts).
  if (toolName === 'desktop_launch_app' && !plainAppOpen(toolName, params)) acts.add('command');
  return [...acts];
}

/** The fields of a call that say who a send goes to. */
const RECIPIENT_KEYS = /^(?:to|cc|bcc|recipients?|receivers?|addressees?|emails?|addresses|chat|chat_?id|chat_?name|channel|channel_?id|channel_?name|phone|phone_?number|number|user|username|user_?id|contact|contacts|peer|person|handle)$/i;

function recipientsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return value.split(/[;,]/).map((one) => one.trim()).filter(Boolean);
  if (typeof value === 'number') return [String(value)];
  if (depth > 2 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((one) => recipientsOf(one, depth + 1));
  // A person as an object: whatever it is called by.
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => /^(?:name|email|address|display_?name|id|handle|phone|number|username)$/i.test(key))
    .flatMap(([, one]) => recipientsOf(one, depth + 1));
}

/** Who a call sends to, as far as the call says: every value of a field that names a recipient. */
export function callRecipients(params: Record<string, unknown>): string[] {
  return Object.entries(params).filter(([key]) => RECIPIENT_KEYS.test(key)).flatMap(([, value]) => recipientsOf(value));
}

const plain = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Words of a sentence that name nobody. */
const NO_NAME = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'file', 'files', 'mail', 'email', 'message', 'send', 'forward', 'reply',
  'please', 'you', 'can', 'could', 'would', 'will', 'him', 'her', 'them', 'his', 'their', 'from', 'about', 'now', 'then', 'also', 'not', 'all', 'yes', 'shall',
  'che', 'con', 'per', 'del', 'della', 'dei', 'gli', 'una', 'uno', 'questo', 'questa', 'invia', 'manda', 'inoltra', 'rispondi', 'messaggio', 'posta', 'non',
  'com', 'org', 'net', 'www', 'http', 'https', 'gmail', 'outlook', 'hotmail', 'yahoo', 'icloud']);

/**
 * Whether the owner's words name this recipient. A word of theirs (three
 * letters or more, and not one that names nobody) has to be a word of the
 * recipient's name, or of the part of an address before the @, or begin one
 * ("Anna" names anna.rossi@corp.example and "Anna Rossi"). An address they
 * wrote out names itself. The part after the @ never does: "corp" in their
 * sentence does not name everybody at corp.example.
 */
export function wordsName(words: string, recipient: string): boolean {
  const said = plain(words);
  const whole = plain(recipient).trim();
  if (!whole) return true;
  const address = /[^\s<>"'(),;]+@[^\s<>"'(),;]+/.exec(whole)?.[0] ?? '';
  if (address && said.includes(address)) return true;
  // The name beside the address and the part before the @; with no address, the whole of it.
  const named = address ? `${whole.replace(address, ' ')} ${address.slice(0, address.indexOf('@'))}` : whole;
  const parts = named.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 2);
  // Their words with every address taken out first: the part after an @ names nobody.
  const mine = said.replace(/[^\s<>"'(),;]+@[^\s<>"'(),;]+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !NO_NAME.has(word));
  return mine.some((word) => parts.some((part) => part === word || (word.length >= 4 && part.startsWith(word))));
}

/** Words that send to whoever wrote the thing in front, and so name nobody: a reply. */
const REPLIES = /\b(?:reply|respond|answer|rispond\w+|risposta)\b/i;

/**
 * Whether sends to somebody the owner's words do not name are asked about.
 * The owner's decision speaks of kinds of act; this is the stricter reading
 * of it, chosen so that "send Anna the file" does not also cover a second
 * send that something read in the turn added. False: the kind alone decides.
 */
export const RECIPIENTS_MUST_BE_NAMED = true;

/**
 * The outside content the code running now has read, as the turn's own tool
 * loops keep it: each loop enters with its live set of marks (the main
 * agent's turn, a helper's run), and a loop started inside another sees both.
 */
type Held = { marks: ReadonlySet<string>; counts: (mark: string) => boolean; above: Held | undefined };
const held = new AsyncLocalStorage<Held>();

/**
 * Runs `run` with `marks` as what its tool loop has read. `marks` is the
 * live set: what is read later counts from then on. `counts` leaves out the
 * marks that are not outside content (an intent the person did not approve).
 */
export function withOutsideContent<T>(marks: ReadonlySet<string>, run: () => T, counts: (mark: string) => boolean = () => true): T {
  return held.run({ marks, counts, above: held.getStore() }, run);
}

/** What has been read from outside where the code runs now. Null: nobody said, which is not "nothing". */
export function outsideContentHeld(): string[] | null {
  const store = held.getStore();
  if (!store) return null;
  const sources = new Set<string>();
  for (let level: Held | undefined = store; level; level = level.above) {
    for (const mark of level.marks) if (level.counts(mark)) sources.add(mark);
  }
  return [...sources];
}

/**
 * Asks the machine what a raw click would land on, and answers with what that
 * reads as (the categories a click on that name means), or nothing. The
 * daemon sets it; without it nothing can look.
 *
 * Four answers, kept apart:
 *
 *   - a list (often empty): it looked;
 *   - `'blind'`: it cannot look by its making (screen awareness off, a
 *     desktop app that cannot say, no machine). The click goes ahead in a
 *     turn that has read nothing, and is asked about in one that has;
 *   - null: it tried to look and was told nothing;
 *   - a throw: the asking failed (no answer in time, a desktop app too old to
 *     know the question).
 *
 * Neither of the last two is "nothing is there": it is asked once more, and
 * then the owner is asked.
 */
export type OwnerWordProbe = (toolName: string, params: Record<string, unknown>) => Promise<readonly ActionCategory[] | 'blind' | null>;

let probe: OwnerWordProbe | null = null;

export function setOwnerWordProbe(next: OwnerWordProbe | null): void {
  probe = next;
}

/** The tools that press whatever is at a place the call itself does not name. */
const RAW_PRESS_TOOLS: ReadonlySet<string> = new Set(['desktop_click', 'desktop_pointer']);

export interface OwnerWordGate {
  categories: readonly ActionCategory[];
  /** The tool's own classifier failed: nothing is known about what the call does. */
  unclassified?: boolean;
}

/** What is known of the turn a call is made in, when the owner started it with words of their own. */
export interface OwnerTurn {
  /** Whether the turn has read something the owner did not write. */
  outside: boolean;
  /** The kinds of act the owner's words asked for. */
  covers: readonly OwnerAct[];
  /** The words themselves, for who a send may go to. */
  words: string;
}

/**
 * The turn the code running now belongs to, or null when it is not one the
 * owner started on the notch with words of their own. `own`: what the caller
 * itself has read (a helper's run), beside what the loops above it have.
 * Where nobody says what was read, it is taken as read: not knowing is a
 * reason to ask.
 */
export function currentOwnerTurn(own?: ReadonlySet<string>): OwnerTurn | null {
  const standing = ownersTurn();
  if (!standing) return null;
  const above = outsideContentHeld();
  const outside = standing.answers || (own !== undefined && own.size > 0) || (above === null ? own === undefined : above.length > 0);
  return { outside, covers: standing.covers, words: standing.words };
}

/**
 * What the owner's word says about a call:
 *
 *   - `go`: it is inside a turn they started on the notch, nothing about it
 *     reads as a delete or a payment, and it is not one of the four kinds of
 *     act in a turn that has read outside content, or their words asked for
 *     it. It is not asked about.
 *   - `ask`: it is inside such a turn and it does read as a delete or a
 *     payment. It is asked about, also where the product's ordinary rules
 *     would have let it run: a command that deletes ran unasked in a turn that
 *     had read nothing, and "a delete is asked about" has to be true.
 *   - `unseen`: it is a raw click on a screen that can be read and was not,
 *     asked twice. It is asked about like `ask`, with its own reason: a click
 *     is not pressed blind, since "Delete" and "Buy now" are found by reading
 *     what is there.
 *   - `blind`: it is a raw click where nothing can look, in a turn that has
 *     read outside content.
 *   - `unasked-send`, `unasked-command`, `unasked-install`,
 *     `unasked-settings`: the turn has read outside content, the call is that
 *     kind of act, and the owner's words did not ask for one.
 *   - `unnamed`: the same, for a send they did ask for that goes to somebody
 *     their words do not name.
 *   - null: not such a turn, or a call whose own classifier failed. The
 *     product's ordinary rules decide, as everywhere else.
 *
 * Every answer but `go` and null is asked about, with its own reason
 * (`ownerWordAsks`).
 *
 * `turn` is for tests and for a helper, which says what it has read itself;
 * the product otherwise asks `currentOwnerTurn`. A function that answers
 * true stands for a turn that has read nothing.
 */
export type OwnerWord = 'go' | 'ask' | 'unseen' | 'blind' | `unasked-${OwnerAct}` | 'unnamed';

const CLEAN: OwnerTurn = { outside: false, covers: [], words: '' };

export async function ownerWord(
  toolName: string,
  params: Record<string, unknown>,
  gate: OwnerWordGate,
  turn: () => OwnerTurn | boolean | null = currentOwnerTurn,
): Promise<OwnerWord | null> {
  const told = turn();
  if (!told) return null;
  const now = told === true ? CLEAN : told;
  if (gate.unclassified) return null;
  if (callDeletesOrPays(toolName, params, gate.categories)) return 'ask';
  let reads: readonly ActionCategory[] = gate.categories;
  if (RAW_PRESS_TOOLS.has(toolName)) {
    let looked: readonly ActionCategory[] | 'blind' | null = probe ? null : 'blind';
    // Asked once more when the first asking fails or sees nothing: a machine
    // that was busy answers the second time. After that it is not known what
    // is there, and not knowing is a reason to ask.
    for (let tries = 0; probe && tries < 2 && looked === null; tries += 1) {
      try {
        looked = await probe(toolName, params);
      } catch {
        // The machine could not say this time.
      }
    }
    if (looked === null) return 'unseen';
    if (looked === 'blind') {
      if (now.outside) return 'blind';
    } else {
      if (looked.some((category) => STILL_ASKED.has(category))) return 'ask';
      // What is at the place is part of what the click does: a click on "Send" is a send.
      reads = [...gate.categories, ...looked];
    }
  }
  if (!now.outside) return 'go';
  const acts = callActs(toolName, params, reads);
  const command = commandText(toolName, params);
  for (const act of acts) {
    if (now.covers.includes(act)) continue;
    // "Install ..." asks for the command that installs, "turn on ..." for the one that sets: and for no other command.
    if (act === 'command' && command && ((now.covers.includes('install') && commandInstalls(command)) || (now.covers.includes('settings') && commandSets(command)))) continue;
    return `unasked-${act}`;
  }
  if (RECIPIENTS_MUST_BE_NAMED && acts.includes('send') && !REPLIES.test(now.words)) {
    if (callRecipients(params).some((recipient) => !wordsName(now.words, recipient))) return 'unnamed';
  }
  return 'go';
}

/** The reason an audit row and a log line carry for a call that went ahead this way. */
export const OWNER_WORD_REASON = 'asked for by the owner on the notch: saying it is the approval';

/** And for one that is asked about because it deletes or pays. */
export const OWNER_WORD_ASKS_REASON = 'a delete or a payment is always asked about';

/** And for a raw click on a screen that could not be read first. */
export const OWNER_WORD_UNSEEN_REASON = 'the screen could not be read to see what this click lands on, so it is asked about';

/** And for a raw click where nothing can look, after outside content was read. */
export const OWNER_WORD_BLIND_REASON = 'this turn has read content you did not write, and what this click lands on cannot be read here, so it is asked about';

const ACT_SAID: Record<OwnerAct, string> = {
  send: 'a send',
  command: 'running a command',
  install: 'an install',
  settings: 'a change of settings',
};

/** And for an act that reaches out or runs code, after outside content, that the owner's words did not ask for. */
export function ownerWordUnaskedReason(act: OwnerAct): string {
  return `your words did not ask for ${ACT_SAID[act]}, and this turn has read content you did not write, so it is asked about`;
}

/** And for a send to somebody their words do not name. */
export const OWNER_WORD_UNNAMED_REASON = 'your words did not name who this is sent to, and this turn has read content you did not write, so it is asked about';

/** The reason a word asks with, or null when it does not ask. */
export function ownerWordAsks(word: OwnerWord | null): string | null {
  switch (word) {
    case null: case 'go': return null;
    case 'ask': return OWNER_WORD_ASKS_REASON;
    case 'unseen': return OWNER_WORD_UNSEEN_REASON;
    case 'blind': return OWNER_WORD_BLIND_REASON;
    case 'unnamed': return OWNER_WORD_UNNAMED_REASON;
    default: return ownerWordUnaskedReason(word.slice('unasked-'.length) as OwnerAct);
  }
}
