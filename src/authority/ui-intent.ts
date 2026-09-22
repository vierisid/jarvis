import type { ToolGate } from '../actions/tools/registry';
import type { ActionCategory } from '../roles/authority';

// UI text is untrusted evidence, not a capability declaration. These hints
// may add a policy check; neither a matching label nor an absent match proves
// what an arbitrary page's event handler does.
const MAIL_CONTEXT = /gmail|outlook|\bmail\b|mail\.|proton|thunderbird|yahoo|fastmail|hey\.com/i;
const MESSAGING_CONTEXT = /slack|teams|discord|whatsapp|telegram|messenger|signal|imessage|\bsms\b|\bchat\b|linkedin|twitter|x\.com|bluesky|mastodon|reddit/i;
const PAYMENT_RE = /\b(pay|pay now|purchase|buy|buy now|checkout|check out|place (your )?order|confirm (payment|purchase|order)|subscribe|complete (purchase|order|payment))\b/i;
const DELETE_RE = /\b(delete|remove|trash|erase|discard|uninstall|permanently|empty (bin|trash))\b/i;
const SEND_RE = /^(send|send (now|email|mail|message|it|reply)|reply|reply all|forward|post|publish|submit|tweet|share)$/i;
const SETTINGS_RE = /^(save (settings|changes|preferences)|apply|grant|allow access|change password|update (settings|permissions))$/i;

export function uiEffectHints(action: string, name: string, context: string, value = ''): ActionCategory[] {
  const hints: ActionCategory[] = [];
  if (action === 'click') {
    const n = name.trim();
    if (PAYMENT_RE.test(n)) hints.push('make_payment');
    if (DELETE_RE.test(n)) hints.push('delete_data');
    if (SETTINGS_RE.test(n)) hints.push('modify_settings');
    if (SEND_RE.test(n)) hints.push(MAIL_CONTEXT.test(context) ? 'send_email' : 'send_message');
  }
  if (action === 'press_keys') {
    const keys = value.toLowerCase();
    const plainEnter = /(^|\+|\s)(enter|return)$/.test(keys) && !/ctrl|cmd|meta|alt/.test(keys);
    const chordEnter = /(ctrl|cmd|meta)\+(enter|return)$/.test(keys);
    if (plainEnter && MESSAGING_CONTEXT.test(context)) hints.push('send_message');
    if (chordEnter && MAIL_CONTEXT.test(context)) hints.push('send_email');
  }
  return hints;
}

// Applies by tool identity, including createBrowserTools' isolated controller
// and tools exposed to sub-agents. A model-supplied intent/effect never opts a
// raw action out. Screenshots and snapshots remain available without a card.
export const REVIEWED_UI_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press_key',
  'browser_upload_file', 'browser_hover', 'browser_scroll', 'browser_evaluate',
  'desktop_click', 'desktop_type', 'desktop_press_keys', 'desktop_launch_app',
  'desktop_focus_window', 'ui_act',
]);

export function rawUiGate(toolName: string, params: Record<string, unknown>): ToolGate | null {
  if (!REVIEWED_UI_TOOLS.has(toolName)) return null;
  if (toolName === 'ui_act' && params.action === 'get_value') return null;
  // Arguments are already present on the approval card. Do not duplicate
  // typed text, file contents or arbitrary expressions in the intent/logs.
  const element = typeof params.element_id === 'number' ? ` on element [${params.element_id}]` : '';
  return {
    actionCategory: 'control_app',
    intent: `Review ${toolName}${element}. Business effect unknown: this UI action may send, submit, delete or change data. Check the current screen and the exact arguments before approving; prefer a typed connector for a known business action.`,
    confirm: 'always',
  };
}
