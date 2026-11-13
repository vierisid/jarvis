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
 * a call is not asked about. Two things still are, by the owner's own words:
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
 *     way as a control's label (the probe, set by the daemon).
 *
 * It is a reading, not a proof. A delete written so that none of this sees it
 * (a script that removes files, a button with no name) goes ahead like
 * anything else: that is the price of not being asked, and it is the owner's
 * to pay. What is NOT waived: a call the product refuses outright (it stays
 * refused), and a call whose own classifier failed (nothing is known about
 * it, so it is asked about).
 *
 * This also sets aside, for these turns, the guard that asks about every step
 * after outside content was read (authority/taint-gating.ts). That guard
 * exists because a page, a file or a window can carry instructions. With it
 * set aside, what such text can make the agent do is no longer held for a
 * yes unless it is a delete or a payment. The owner chose that.
 *
 * Where it applies: only inside a turn the owner started on the notch, and
 * only with the notch switch on. Dashboard chat, Telegram, background agents
 * and workflows are judged as before.
 */
import type { ActionCategory } from '../roles/authority.ts';
import { ownerAskedOnNotch } from './app-open.ts';

/** What is still asked about when the owner asked for the thing themselves. */
export const STILL_ASKED: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['delete_data', 'make_payment']);

/**
 * Whether a command's text removes something. Shell, PowerShell and the
 * common tools that delete by a verb of their own. Read on the command as
 * written, so a name in quotes or after a pipe is seen too.
 */
/** Where a command word can stand: at the start, after ; & | ( a newline or a quote, or after a word that runs what follows. */
const AT_COMMAND = String.raw`(?:^|[;&|(\n\`"']|\b(?:sudo|doas|xargs|exec|then|do|else)\s|-exec(?:dir)?\s|(?:\/[ck]|-c|-command)\s+["']?)\s*`;

const DELETES: readonly RegExp[] = [
  // The verbs that remove, in a shell, in cmd and as PowerShell's short names.
  new RegExp(`${AT_COMMAND}(?:rm|rmdir|unlink|shred|srm|del|erase|rd|ri|rimraf|trash|trash-put|sdelete(?:64)?)(?:\\.exe)?(?=\\s|$)`, 'i'),
  // PowerShell by its long names.
  /\b(?:Remove-[A-Za-z]+|Uninstall-[A-Za-z]+|Unregister-[A-Za-z]+|Clear-(?:Content|Item|ItemProperty|RecycleBin|Disk|EventLog))\b/i,
  /\[(?:System\.)?IO\.(?:File|Directory)\]::Delete/i,
  // What a tool deletes by its own word.
  /\bfind\b[^|;&]*\s-delete\b/i,
  /\bgit\s+(?:clean|rm|reset\s+--hard|checkout\s+--\s|branch\s+-D|push\s+[^|;&]*--delete|stash\s+(?:drop|clear))/i,
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
  // Emptying a file: writing nothing over it.
  /(?:^|[;&|\n])\s*(?::\s*)?>\s*[^\s&|>]/,
  /\btruncate\s+-s\s*0\b/i,
];

export function commandDeletes(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  return DELETES.some((pattern) => pattern.test(command));
}

/** Whether a key press holds the Delete key: in a file list that removes the file. */
export function keysDelete(keys: unknown): boolean {
  if (typeof keys !== 'string') return false;
  return keys.split(/[,+]/).some((key) => /^(?:delete|del|forwarddelete|kp_delete)$/i.test(key.trim()));
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
  if ((toolName === 'desktop_press_keys' || toolName === 'browser_press_key') && keysDelete(params.keys ?? params.key)) return true;
  return false;
}

/**
 * Asks the machine what a raw click would land on, and answers with what that
 * reads as (`delete_data`, `make_payment`, or nothing). The daemon sets it;
 * without it a raw click is judged by the call alone.
 */
export type OwnerWordProbe = (toolName: string, params: Record<string, unknown>) => Promise<readonly ActionCategory[]>;

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

/**
 * What the owner's word says about a call:
 *
 *   - `go`: it is inside a turn they started on the notch and nothing about it
 *     reads as a delete or a payment. It is not asked about.
 *   - `ask`: it is inside such a turn and it does read as a delete or a
 *     payment. It is asked about, also where the product's ordinary rules
 *     would have let it run: a command that deletes ran unasked in a turn that
 *     had read nothing, and "a delete is asked about" has to be true.
 *   - null: not such a turn, or a call whose own classifier failed. The
 *     product's ordinary rules decide, as everywhere else.
 *
 * `asked` is for tests; the product asks `ownerAskedOnNotch`.
 */
export type OwnerWord = 'go' | 'ask';

export async function ownerWord(
  toolName: string,
  params: Record<string, unknown>,
  gate: OwnerWordGate,
  asked: () => boolean = ownerAskedOnNotch,
): Promise<OwnerWord | null> {
  if (!asked()) return null;
  if (gate.unclassified) return null;
  if (callDeletesOrPays(toolName, params, gate.categories)) return 'ask';
  if (probe && RAW_PRESS_TOOLS.has(toolName)) {
    try {
      const reads = await probe(toolName, params);
      if (reads.some((category) => STILL_ASKED.has(category))) return 'ask';
    } catch {
      // The machine could not say. Not knowing is not a delete or a payment.
    }
  }
  return 'go';
}

/** The reason an audit row and a log line carry for a call that went ahead this way. */
export const OWNER_WORD_REASON = 'asked for by the owner on the notch: saying it is the approval';

/** And for one that is asked about because it deletes or pays. */
export const OWNER_WORD_ASKS_REASON = 'a delete or a payment is always asked about';
