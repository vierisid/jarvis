/**
 * The relevance heuristic.
 *
 * This is the only part of the filter that reads the conversation, and it is
 * the only part that is allowed to be wrong. Everything it produces is a
 * CANDIDATE: `normalizeToolSet` checks the invariants on the result and fails
 * open if they do not hold, so a bad trigger table costs tokens or a round
 * trip, never the framing guarantee. That separation is what lets this be
 * replaced later -- by embeddings, by a learned router -- without redoing the
 * security review.
 *
 * Two properties it must have, both about NOT dropping things:
 *
 *   - A research or browse ask keeps the browser tools. #475 dropped them on
 *     exactly those asks, which is how it ended up steering the model to
 *     curl. #483 requirement 5 asks specifically for coverage of wrong
 *     exclusion, not just correct inclusion.
 *   - A pasted URL counts. #475 matched `\burl\b` as a literal word, so
 *     `summarise this article https://example.com/post/1` matched nothing and
 *     lost every browser tool.
 */

import type { LLMMessage } from '../../../llm/provider.ts';
import type { ToolDefinition } from '../registry.ts';
import { isFramedPerception, isInvariantTrigger } from './authority-classes.ts';

/**
 * A group of tools and the text that makes them relevant.
 *
 * Kept as one table so `coverage` can assert that every droppable registered
 * tool appears in it. A tool nobody assigned a trigger to would otherwise be
 * dropped on every turn and nothing would fail.
 */
type TriggerGroup = {
  tools: readonly string[];
  /** Matched as whole words unless the pattern is a RegExp. */
  words?: readonly string[];
  patterns?: readonly RegExp[];
};

/** A bare URL anywhere in the conversation. The case #475 missed. */
const URL_RE = /https?:\/\/\S+|\bwww\.\S+/i;
/**
 * A bare domain with no scheme: "go to github.com", "visit example.org".
 * People rarely paste the scheme when they type a site name, and the URL
 * pattern above needs one.
 *
 * Only the last label before the TLD is matched, and it is length-bounded:
 * the test is boolean, so `docs.github.com` matching on `github.com` is
 * enough, and an unbounded repeated `(\.label)*` group backtracked
 * quadratically -- 250 ms on an 8,000-char window of "a.a.a.", on the event
 * loop, on text an injected page can put there. TLDs are limited to ones
 * that are not also ordinary words or run-on sentences ("thanks.It",
 * "done.Co"), and not `.ts`/`.json`-style file extensions.
 */
const DOMAIN_RE = /\b[a-z0-9-]{1,63}\.(?:com|org|net|io|dev|app|edu|gov)\b/i;
/**
 * Site-building intent: a verb of making, then within 40 characters a site
 * noun. "build me a landing page", "create a website for my bakery", "code a
 * website for me". Not "create an account on the site", "make sure the
 * website loads", "generate a report on their website traffic" -- those are
 * browses, and a browse must not be offered the site shell. `start`,
 * `design`, `set up` and a bare "my site" matched too many of them to keep.
 *
 * The excluded words block a match only BETWEEN the verb and the noun (a
 * tempered gap: every gap character is taken only where no excluded word
 * starts). An earlier version put them in a lookahead over the 40
 * characters after the verb, so "create a website with a login page" lost
 * its site tools to a word that came after the noun. Each gap step looks
 * ahead a bounded distance and the gap is bounded, so it stays linear.
 */
const SITE_BUILD_RE = /\b(?:build|make|create|code|generate|scaffold|spin up|whip up|put together)\b(?:(?!\b(?:account|sign ?in|log ?in|sure|summary|report|bookmark|shortcut)\b)[^.?!\n]){0,40}?\b(?:web ?site|site|web ?page|homepage|landing page|portfolio|html page)s?\b/i;

/** A path-looking token, or a fenced code block. */
const PATH_RE = /(^|\s)[~.]?[/\\][\w.\-/\\]+|```/;

export const TRIGGER_GROUPS: readonly TriggerGroup[] = [
  {
    tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
      'browser_hover', 'browser_press_key', 'browser_scroll', 'browser_screenshot',
      'browser_upload_file', 'browser_evaluate'],
    words: ['url', 'web', 'website', 'webpage', 'page', 'browse', 'browser', 'article',
      'link', 'online', 'google', 'search', 'internet', 'site', 'blog', 'news',
      'research', 'summarise', 'summarize', 'competitor', 'landscape', 'dashboard',
      // Asks that are browses without naming the web. Each of these was
      // measured dropping every browser tool (floor + hatch only) before it
      // was added; see selection.test.ts "realistic browse asks".
      'visit', 'navigate', 'hover', 'scroll', 'form', 'homepage', 'look up', 'lookup',
      'price', 'weather', 'forecast', 'flight', 'recipe', 'shop', 'buy', 'reddit',
      'youtube', 'gmail', 'wikipedia'],
    patterns: [URL_RE, DOMAIN_RE],
  },
  {
    tools: ['desktop_snapshot', 'desktop_find_element', 'desktop_list_windows',
      'desktop_screenshot', 'capture_screen', 'ui_snapshot'],
    words: ['screen', 'window', 'see', 'look', 'showing', 'display', 'dialog',
      'button', 'field', 'visible', 'onscreen', 'desktop'],
  },
  {
    tools: ['desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app',
      'desktop_focus_window', 'ui_act'],
    words: ['open', 'launch', 'start', 'click', 'type', 'press', 'key', 'keyboard',
      'notepad', 'app', 'application', 'close', 'focus', 'switch', 'element',
      'foreground', 'minimize', 'maximize'],
  },
  {
    tools: ['run_command'],
    words: ['run', 'command', 'terminal', 'shell', 'script', 'build', 'compile',
      'test', 'install', 'npm', 'bun', 'git', 'log', 'logs', 'process', 'restart',
      'service', 'check', 'status', 'deploy'],
  },
  {
    tools: ['read_file', 'list_directory', 'write_file'],
    words: ['file', 'folder', 'directory', 'read', 'write', 'save', 'disk', 'path', 'download'],
    patterns: [PATH_RE],
  },
  {
    tools: ['get_clipboard', 'set_clipboard'],
    words: ['clipboard', 'copy', 'copied', 'paste'],
  },
  {
    tools: ['list_sidecars'],
    words: ['sidecar', 'sidecars', 'machine', 'machines', 'device', 'devices',
      'remote', 'paired', 'computer', 'laptop', 'pc'],
  },
  {
    tools: ['run_skill', 'record_skill', 'manage_skills'],
    words: ['skill', 'skills', 'record', 'replay', 'macro', 'teach', 'demonstrate'],
  },
  {
    tools: ['delegate_task', 'manage_agents'],
    words: ['delegate', 'agent', 'agents', 'specialist', 'parallel', 'background', 'spawn'],
  },
  {
    tools: ['manage_workflow'],
    words: ['workflow', 'workflows', 'automation', 'automate', 'schedule', 'scheduled',
      'recurring', 'daily', 'weekly', 'morning', 'trigger', 'every'],
  },
  {
    tools: ['manage_goals'],
    words: ['goal', 'goals', 'objective', 'okr', 'target', 'milestone', 'ship'],
  },
  {
    tools: ['commitments'],
    words: ['remind', 'reminder', 'remember', 'commit', 'commitment', 'promise',
      'todo', 'deadline', 'due', 'follow'],
  },
  {
    tools: ['create_document'],
    words: ['document', 'doc', 'note', 'notes', 'memo', 'report', 'draft', 'write'],
  },
  {
    tools: ['content_pipeline'],
    words: ['content', 'pipeline', 'idea', 'outline', 'publish', 'post'],
  },
  {
    tools: ['research_queue'],
    words: ['research', 'queue', 'queued', 'investigate'],
  },
  {
    // Registered only when `sites.enabled`. Without a group these eight were
    // dropped on EVERY turn -- the coverage test walked BUILTIN_TOOLS, and
    // none of them is in it. Every one is `fetch` (site_run_command is a real
    // `sh -c` shell), so selecting them always pulls the framed readers in
    // with them; that is the invariant working, not a leak.
    //
    // Triggered by BUILD intent only. "site", "website", "homepage" belong to
    // the browse group: "go to their website and read the pricing" must not
    // be offered a shell, a delete and a GitHub push. Likewise "project",
    // "repo", "commit", "push" are ordinary dev chat, and "html", "css",
    // "template" are too broad on their own ("fix the css in my react app",
    // "use the email template") -- a verb of making next to a site noun
    // carries the intent instead.
    tools: ['site_create_project', 'site_read_file', 'site_write_file', 'site_delete_file',
      'site_list_files', 'site_run_command', 'site_git_commit', 'site_github_push'],
    words: ['site builder', 'landing page', 'portfolio site', 'portfolio website', 'project directory',
      'static site', 'html page'],
    patterns: [SITE_BUILD_RE],
  },
];

/**
 * What a user message that matched NO group is offered (applied per message
 * by `selectForConversation`): the browse group's framed READERS, and only
 * those that are not invariant triggers themselves.
 *
 * Before this, such an ask got the floor and the hatch and nothing else --
 * three tools. That was measured on "find the cheapest flight to Tokyo",
 * "visit example.org and tell me what it says", "what are people saying on
 * reddit about the new iphone": all browses, none naming the web, and a
 * small model holding three tools answers them from memory rather than
 * calling `discover_tools`. A trigger table can never enumerate every way to
 * ask for something from outside, so the unmatched case needs a default.
 *
 * The default is the browse group's framed readers, and never the shell.
 * That is the direction the whole design leans: when the filter does not
 * know what the turn needs, the way to reach outside content it offers is
 * the one that frames it. It can only add tools, so it cannot break an
 * invariant; its price is schema bytes on a quiet turn ("hi", "thanks") --
 * see `unmatchedDefaultNames` and the benchmark.
 */
const UNMATCHED_DEFAULT_GROUP: TriggerGroup = (() => {
  // Found by content, not by position, so reordering the table cannot
  // silently swap the default for, say, the shell group. The throw is a
  // tripwire for an edit to the static table, which the tests would hit
  // first.
  const g = TRIGGER_GROUPS.find((x) => x.tools.includes('browser_navigate'));
  if (!g || g.tools.includes('run_command')) throw new Error('tool-relevance: no browse group to default to');
  return g;
})();

/**
 * Filtered to the browse group's framed, non-trigger tools at the call site,
 * where the definitions are. That drops `browser_evaluate` (framed, but
 * execute_command -- rank 506, the shell's own rank, and so an invariant
 * trigger whose presence would drag every desktop reader in by the union)
 * and `browser_upload_file` (a FRAMED_ACTOR: it sends a local file out, and
 * must never be auto-added). What is left is the browse readers and the
 * page actuators at access_browser: about 8 kB instead of 14, and no
 * repair. A one-word "ok" or "thanks" pays this for as long as it stays in
 * the window; that is the accepted price of never leaving an unrecognised
 * ask with nothing to read the web with.
 */
function unmatchedDefaultNames(available?: ReadonlyMap<string, ToolDefinition>): string[] {
  return UNMATCHED_DEFAULT_GROUP.tools.filter((n) => {
    if (!available) return true;
    const t = available.get(n);
    return t !== undefined && isFramedPerception(t) && !isInvariantTrigger(t);
  });
}

/**
 * How much conversation the selection reads.
 *
 * Bounded on purpose. Unbounded scanning would be O(history x patterns) on
 * every turn against histories retained up to 200k tokens. Bounding is safe
 * for what I2 protects -- the tools a task is USING -- because the ledger
 * holds every tool that was called or admitted, and a match that scrolls
 * out of the window cannot take one of those away. A tool that was only
 * ever selected, never used, can drop out once its trigger scrolls out;
 * nothing in flight depends on it.
 */
export const SELECTION_WINDOW_CHARS = 8000;

type TextPart = { role: 'user' | 'assistant'; text: string };

/**
 * The user/assistant text inside the selection window, oldest first,
 * lowercased: the most recent SELECTION_WINDOW_CHARS of the parts joined
 * with newlines, the oldest part cut to what fits. The window is measured
 * before lowercasing, so a few non-ASCII characters that lengthen when
 * lowercased ("İ") can take it past the nominal size -- at most about 2x,
 * and harmless for matching.
 *
 * Built newest-first and reversed once (not `unshift` per part, which is
 * quadratic in the number of messages), and lowercased AFTER windowing, so
 * a 200k-token history costs one pass over its tail rather than two full
 * `toLowerCase` copies. The joining newline is charged before a part is
 * taken, so a window that ends exactly on a message boundary does not take
 * an empty sliver of the next-older one.
 */
function windowedParts(messages: readonly LLMMessage[]): TextPart[] {
  const newestFirst: TextPart[] = [];
  let budget = SELECTION_WINDOW_CHARS;
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const texts = typeof m.content === 'string'
      ? [m.content]
      : Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])) : [];
    for (let j = texts.length - 1; j >= 0 && budget > 0; j--) {
      if (newestFirst.length > 0) {
        budget -= 1; // the newline joining this part to the newer one
        if (budget <= 0) break;
      }
      const t = texts[j]!;
      newestFirst.push({ role: m.role, text: (t.length > budget ? t.slice(-budget) : t).toLowerCase() });
      budget -= t.length;
    }
  }
  return newestFirst.reverse();
}

/** Flatten the conversation to the text the triggers are matched against. */
export function conversationText(messages: readonly LLMMessage[]): string {
  return windowedParts(messages).map((p) => p.text).join('\n');
}

const wordCache = new Map<string, RegExp>();
/**
 * Whole word, plus the plain plural. "documents", "reports" and "apps" used
 * to miss their own groups -- `create_document`'s own description ("vault
 * documents: reports, plans...") did not select `create_document`. Matching
 * more can only keep more, so this errs the safe way.
 */
function wordRe(word: string): RegExp {
  let re = wordCache.get(word);
  if (!re) {
    re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i');
    wordCache.set(word, re);
  }
  return re;
}

function groupMatches(group: TriggerGroup, text: string): boolean {
  if (group.patterns?.some((p) => p.test(text))) return true;
  return group.words?.some((w) => wordRe(w).test(text)) ?? false;
}

/**
 * Names the given text makes relevant, from the trigger table alone.
 *
 * `available` is the call site's registry; names outside it are left out so
 * "matched something" means "matched something this call site can offer".
 */
export function selectRelevantNames(text: string, available?: ReadonlySet<string>): Set<string> {
  const usable = (t: string) => !available || available.has(t);
  const out = new Set<string>();
  for (const g of TRIGGER_GROUPS) {
    if (groupMatches(g, text)) for (const t of g.tools) if (usable(t)) out.add(t);
  }
  return out;
}

/**
 * Names the conversation makes relevant: the trigger table over the whole
 * window, plus the unmatched default for any USER message in the window
 * that selects nothing on its own. Not a tool set: the caller unions this
 * with the floor and the ledger, then normalises.
 *
 * Why per message rather than "the whole window matched nothing":
 *
 *   - Capability. "set a goal to ship the release", then "find the cheapest
 *     flight to Tokyo": the window matches the goals group, so a
 *     whole-window rule never fires and the flight ask gets no browser.
 *   - Monotonicity. A whole-window default switches OFF the moment a later
 *     message matches any group, so "hi" then "what is on my screen?"
 *     would drop the browser tools the first turn was offered. A
 *     per-message default, like every other trigger, only ever adds as the
 *     conversation grows (until the message scrolls out of the window).
 *
 * `available` is the call site's registry. "Selects nothing" means nothing
 * THIS call site can offer: a scoped sub-agent registry of the browser tools
 * plus the shell, asked to "set a goal", matches the goals group -- whose
 * tool it does not have -- and would otherwise be left with the hatch alone.
 */
export function selectForConversation(
  messages: readonly LLMMessage[],
  available?: readonly ToolDefinition[],
): Set<string> {
  const byName = available ? new Map(available.map((t) => [t.name, t])) : undefined;
  const names = byName ? new Set(byName.keys()) : undefined;
  const parts = windowedParts(messages);
  const out = selectRelevantNames(parts.map((p) => p.text).join('\n'), names);
  const unmatched = parts.some((p) => p.role === 'user' && selectRelevantNames(p.text, names).size === 0);
  if (unmatched) for (const t of unmatchedDefaultNames(byName)) out.add(t);
  return out;
}

/** Every tool name the trigger table knows about. Used by the coverage test. */
export function triggerTableNames(): Set<string> {
  const out = new Set<string>();
  for (const g of TRIGGER_GROUPS) for (const t of g.tools) out.add(t);
  return out;
}

/** True when the tool is named by at least one trigger group. */
export function hasTrigger(tool: ToolDefinition): boolean {
  return triggerTableNames().has(tool.name);
}
