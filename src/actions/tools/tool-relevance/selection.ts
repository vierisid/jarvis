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
/** A path-looking token, or a fenced code block. */
const PATH_RE = /(^|\s)[~.]?[/\\][\w.\-/\\]+|```/;

export const TRIGGER_GROUPS: readonly TriggerGroup[] = [
  {
    tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
      'browser_hover', 'browser_press_key', 'browser_scroll', 'browser_screenshot',
      'browser_upload_file', 'browser_evaluate'],
    words: ['url', 'web', 'website', 'webpage', 'page', 'browse', 'browser', 'article',
      'link', 'online', 'google', 'search', 'internet', 'site', 'blog', 'news',
      'research', 'summarise', 'summarize', 'competitor', 'landscape', 'dashboard'],
    patterns: [URL_RE],
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
      'notepad', 'app', 'application', 'close', 'focus', 'switch'],
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
];

/**
 * How much conversation the selection reads.
 *
 * Bounded on purpose. Unbounded scanning would be O(history x patterns) on
 * every turn against histories retained up to 200k tokens. Bounding is safe
 * here only because the ledger (I2) absorbs anything that scrolls out of the
 * window: a match that disappears cannot shrink the exposed set.
 */
export const SELECTION_WINDOW_CHARS = 8000;

/** Flatten the conversation to the text the triggers are matched against. */
export function conversationText(messages: readonly LLMMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'text') parts.push(b.text);
    }
  }
  const joined = parts.join('\n').toLowerCase();
  return joined.length > SELECTION_WINDOW_CHARS ? joined.slice(-SELECTION_WINDOW_CHARS) : joined;
}

const wordCache = new Map<string, RegExp>();
function wordRe(word: string): RegExp {
  let re = wordCache.get(word);
  if (!re) {
    re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    wordCache.set(word, re);
  }
  return re;
}

function groupMatches(group: TriggerGroup, text: string): boolean {
  if (group.patterns?.some((p) => p.test(text))) return true;
  return group.words?.some((w) => wordRe(w).test(text)) ?? false;
}

/**
 * Names the conversation makes relevant. Not a tool set: the caller unions
 * this with the floor and the ledger, then normalises.
 */
export function selectRelevantNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const g of TRIGGER_GROUPS) {
    if (groupMatches(g, text)) for (const t of g.tools) out.add(t);
  }
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
