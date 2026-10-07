/**
 * Approval Delivery — Pushes approval requests to the user through
 * appropriate channels (WebSocket always, Telegram/Discord too).
 */

import { approvalIntentFromContext, type ApprovalRequest } from './approval.ts';
import { boundedReceiptText } from '../roles/untrusted.ts';
import { commandForCard } from '../util/card-text.ts';
import type { SendOptions } from '../comms/channels/telegram.ts';
import { impactFromCategory } from '../roles/authority.ts';

/**
 * Line breaks, other C0/C1 controls and the two Unicode line separators: every
 * character that can start a new line, or erase one, on a channel that renders
 * text as it arrives. These collapse to a space.
 */
const LABEL_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;

/**
 * Every format character (`\p{Cf}`): the bidi embeddings, overrides and
 * isolates that can visually reorder the rest of a line on a client that
 * applies bidi -- `Agent: ` followed by a reversed tail -- and the zero-width
 * characters. A label needs none of them, and they are removed rather than
 * spaced, since none of them stands for a gap.
 */
const LABEL_FORMAT = /\p{Cf}+/gu;

/**
 * One line of an approval card's label, safe to put in front of a human (#651).
 *
 * A card is a few labelled lines -- `Action:`, `Agent:`, `Reason:` -- and a
 * label is text a workflow author, or the composer model, chose. A line break
 * inside one is a forged field (`Daily digest\nReason: routine read, safe to
 * approve`), so breaks collapse to a space. Then `boundedReceiptText` defangs
 * any framing delimiter and cuts, and `...` marks a cut so a shortened label
 * never reads as whole.
 *
 * Text that is already one line, unmarked and within `maxChars` comes back
 * byte-exact.
 */
export function boundedApprovalLabel(text: string, maxChars: number): string {
  const oneLine = text.replace(LABEL_FORMAT, '').replace(LABEL_BREAKS, ' ');
  const bounded = boundedReceiptText(oneLine, maxChars);
  return oneLine.length > maxChars ? `${bounded}...` : bounded;
}

/**
 * Ceiling for a label at the point of DELIVERY, applied to every approval
 * whatever wrote it. It is a backstop, not the bound: the workflow writer in
 * `effect-boundary.ts` bounds its parts first, and the longest label it can
 * compose is the audit `agent_name` -- "Workflow " (9) + a 515-character name
 * + " / " (3) + a 123-character step + " / " (3) + a 68-character effect id +
 * the "as <role>" suffix -- about 720 characters. 1024 sits above that, so it
 * never cuts a label a writer already bounded; it exists for a writer that
 * bounds nothing.
 */
export const APPROVAL_LABEL_DELIVERY_MAX_CHARS = 1024;

/** `U+000A`: a code point as a model can name it back. */
function codePointName(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Why this code would alter `text` on its way to an approval surface, or null
 * when every surface's text receives it exactly as written (#724).
 *
 * The test is `boundedApprovalLabel` itself at the delivery ceiling, so it
 * cannot drift from what the channel card and the desktop toast do: null means
 * `boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS) === text`.
 * The other branches only say WHICH alteration it would be, in words a model
 * can act on. That covers what THIS code does to the text, not what a
 * renderer does after it. (Since #718 the channel card is sent as literal
 * text, so no channel renders its markup.)
 *
 * It refuses ordinary text that carries a format character, too: an emoji
 * built with a zero-width joiner, a left-to-right or right-to-left mark in
 * Hebrew or Arabic text, a soft hyphen. Each of those is stripped by the
 * label reduction, so the card would not show what was written.
 */
export function approvalLabelAlteration(text: string): string | null {
  const brk = new RegExp(LABEL_BREAKS.source, 'u').exec(text);
  if (brk) return `it contains a line break, tab or other control character (${codePointName(brk[0])} at position ${brk.index})`;
  const fmt = new RegExp(LABEL_FORMAT.source, 'u').exec(text);
  if (fmt) return `it contains an invisible formatting character (${codePointName(fmt[0])} at position ${fmt.index})`;
  if (text.length > APPROVAL_LABEL_DELIVERY_MAX_CHARS) {
    return `it is ${text.length} characters long; the approval card shows at most ${APPROVAL_LABEL_DELIVERY_MAX_CHARS}`;
  }
  if (boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS) !== text) {
    return 'it contains text the approval card would rewrite (a content-framing marker or an unpaired surrogate)';
  }
  return null;
}

/**
 * The most text, in display columns, a desktop approval toast may show before
 * its Approve and Deny buttons (#791).
 *
 * The OS cuts a toast's body, not this code: Windows' ToastGeneric template
 * and macOS banners show a few lines and drop the rest, right beside the
 * buttons, so a long body was approved with its tail unseen.
 *
 * THIS IS NOT A MEASUREMENT. Nothing in the daemon can see how much a given
 * machine shows -- that depends on the OS version, banner or alert style,
 * display scaling, font and language -- and it has not been measured on real
 * Windows 11 or macOS banners either. It is a deliberately conservative
 * choice: two lines of about forty Latin characters, which is the smallest
 * layout we design for (a macOS banner shows its body in about two lines;
 * Windows shows more). A wide character (CJK, most emoji) counts as two
 * columns (`toastColumns`).
 *
 * It is the one dial for how often a toast can be approved directly: above
 * it the toast is review-only and approving needs the dashboard. To tighten
 * or loosen it, screenshot real approval toasts on Windows 11 (100% and 150%
 * scaling) and macOS 14/15 (banner and alert styles) with bodies of known
 * length, take the longest that every one of them shows whole together with
 * its ` · <impact>` suffix, and set it at or below that.
 */
export const TOAST_APPROVABLE_MAX_COLUMNS = 80;

/** East Asian Wide/Fullwidth ranges and the emoji blocks: two columns each. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

/** Display columns, counting a wide character as two. */
export function toastColumns(text: string): number {
  let columns = 0;
  for (const ch of text) columns += WIDE.test(ch) ? 2 : 1;
  return columns;
}

/** The longest prefix of `text` that fits `max` columns. */
function fitColumns(text: string, max: number): string {
  let columns = 0;
  let out = '';
  for (const ch of text) {
    columns += WIDE.test(ch) ? 2 : 1;
    if (columns > max) break;
    out += ch;
  }
  return out;
}

/** A `notify.show` payload for one approval, and whether it offers Approve. */
export type ApprovalToast = {
  id: string;
  /** `approval` carries Approve/Deny; `approval_review` only opens Jarvis. */
  kind: 'approval' | 'approval_review';
  title: string;
  body: string;
  meta: string;
  destructive: boolean;
  actions: Array<{ id: string; label: string; primary?: boolean }>;
  approvable: boolean;
};

/**
 * The desktop approval toast (`notify.show` to every sidecar, daemon/index.ts).
 *
 * The sidecar renders `body · meta` as one text under the title, and the OS
 * cuts it to a few lines (#791). So the part the person decides on -- the body,
 * then the impact that leads the meta -- must fit `TOAST_APPROVABLE_MAX_COLUMNS`
 * for the toast to carry Approve and Deny. What follows the impact may be cut
 * by the OS, and is never what the decision is about.
 *
 * Above the budget the toast is review-only: no Approve, no Deny, an "Open
 * Jarvis" action, the body cut here with a visible `...`, and its own kind,
 * `approval_review`. The kind matters, not just the action list: the macOS
 * sidecar takes a notification's buttons from a category registered per kind,
 * and the `approval` category always has Approve and Deny, whatever actions
 * the payload lists. An `approval_review` kind is not a registered category on
 * any sidecar shipped so far, which macOS renders with no buttons (tapping the
 * banner still opens Jarvis), and the daemon acts on a notification's
 * approve/deny only for kind `approval` (`notificationApprovalDecision`).
 *
 * Every text is reduced like a channel-card label: one line, no format
 * characters. The body must stay one line for a second reason: the Windows
 * sidecar embeds it in a PowerShell here-string, where a line starting `'@`
 * would end the string.
 */
export function approvalToast(request: ApprovalRequest): ApprovalToast {
  const label = (text: string) => boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS);
  const words = label(request.tool_name).replace(/[_-]+/g, ' ').trim();
  const tool = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Action';
  const reason = boundedApprovalLabel(request.reason?.trim() ?? '', (request.reason ?? '').length);
  const body = reason || `${label(request.agent_name)} wants to run ${tool}.`;
  const impact = impactFromCategory(request.action_category);
  const toolLabel = label(request.tool_name);
  const destructive = impact === 'destructive';
  const approvable = toastColumns(`${body} · ${impact}`) <= TOAST_APPROVABLE_MAX_COLUMNS;
  if (approvable) {
    return {
      id: request.id, kind: 'approval', title: `Approve: ${tool}?`, body, meta: `${impact} · ${toolLabel}`, destructive,
      actions: [{ id: 'deny', label: 'Deny' }, { id: 'approve', label: 'Approve', primary: true }],
      approvable,
    };
  }
  // Leave room for the `...` and the ` · <impact>` that follows the body.
  const room = TOAST_APPROVABLE_MAX_COLUMNS - toastColumns(`... · ${impact}`);
  return {
    id: request.id, kind: 'approval_review', title: `Review in Jarvis: ${tool}`,
    body: `${fitColumns(body, room).trimEnd()}...`,
    meta: `${impact} · ${toolLabel} · too long to approve from a notification`, destructive,
    actions: [{ id: 'review', label: 'Open Jarvis', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    approvable,
  };
}

/**
 * What an approval will do, and why it needed approval, as two separate texts.
 *
 * WHAT WILL HAPPEN (`action`) is what the person is deciding on; WHY approval
 * was needed (`reason`) is the Authority engine's decision reason (#721).
 * `request.reason` is that reason on every request but one, and the engine's
 * wording names a category or a rule, never the effect: `Override requires
 * approval for execute_command`, a context rule's own `description`,
 * `send_email is a governed action requiring user approval`. This used to
 * recognise the engine only by two suffixes and the taint label and let any
 * other reason REPLACE the sentence, so an override or a context rule hid the
 * command, the path or the skill's steps entirely: the reviewer saw why
 * approval was needed but not what would happen.
 *
 * The one exception is `request_approval`, whose `reason` IS the model's
 * declared intent (#696): that is the action, reduced to one line with no
 * format characters and not cut, and it has no separate reason. Its `context`
 * is model-written too, so it is never read as a gate sentence
 * (`approvalIntentFromContext`) -- before #721 an intent ending in "requires
 * user approval" made the model's own context JSON the headline.
 *
 * The reason gets the same one-line reduction: a context rule's description is
 * free text from config. The engine's own wording comes back byte-exact.
 *
 * Neither part is cut here. Each surface decides how much it can show, and a
 * surface that cannot show the action whole must not offer to approve it
 * (`approvalChannelCard`, the desktop toast).
 */
export function approvalIntentParts(request: ApprovalRequest): { action: string; reason: string } {
  const raw = (request.reason ?? '').trim();
  const reason = boundedApprovalLabel(raw, raw.length).trim();
  if (request.tool_name === 'request_approval' && reason) return { action: reason, reason: '' };
  return { action: synthesizeApprovalIntent(request), reason };
}

/**
 * The two parts as one sentence, the reason in parentheses after the action:
 * the dashboard's `intent` field, and what a REST client of
 * `/api/authority/approvals` reads.
 */
export function formatApprovalIntent(request: ApprovalRequest): string {
  const { action, reason } = approvalIntentParts(request);
  return reason ? `${action} (${reason})` : action;
}

function synthesizeApprovalIntent(request: ApprovalRequest): string {
  // A gated tool (run_skill, record_skill, manage_skills delete) writes the
  // sentence that names what will actually happen, with resolved values.
  // Never for request_approval, whose context the model wrote.
  const gated = approvalIntentFromContext(request);
  if (gated) return gated;

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(request.tool_arguments ?? '{}');
  } catch {
    // fall through with empty args
  }

  // Per-tool fallbacks for the common destructive/external intents.
  switch (request.tool_name) {
    case 'send_email': {
      const to = labelOf(args.to) ?? 'someone';
      const subject = labelOf(args.subject);
      // Quoted with its quotes escaped, so a subject cannot close its own
      // literal and continue the sentence; a plain subject reads as it did.
      return subject
        ? `Send email to ${to} — ${JSON.stringify(subject)}`
        : `Send email to ${to}`;
    }
    case 'send_message': {
      const channel = labelOf(args.channel) ?? 'channel';
      return `Send message via ${channel}`;
    }
    case 'run_command':
    case 'execute_command': {
      // Only an approval recorded before `run_command` had a gate (#720)
      // reaches this; every new one carries the gate's sentence above. Shown
      // as the gate shows it, never raw: a newline collapsed in HTML let a
      // second line hide behind a `#` comment, and a bidi override reordered
      // the line. A plain one-line command reads exactly as it always did.
      const shown = commandForCard(asString(args.command) ?? '', { trim: false });
      return asString(args.command) === undefined ? 'Run a shell command' : `R${shown.slice(1)}`;
    }
    case 'delete_file':
    case 'delete_data': {
      const path = labelOf(args.path) ?? labelOf(args.target) ?? 'the target';
      return `Delete ${path}`;
    }
    case 'install_software': {
      const pkg = labelOf(args.package) ?? labelOf(args.name) ?? 'software';
      return `Install ${pkg}`;
    }
    case 'make_payment': {
      const amount = labelOf(args.amount) ?? labelOf(args.total);
      const to = labelOf(args.recipient) ?? labelOf(args.to) ?? 'recipient';
      return amount ? `Pay ${amount} to ${to}` : `Make a payment to ${to}`;
    }
    case 'spawn_agent': {
      const role = labelOf(args.role) ?? 'an agent';
      return `Spawn ${role}`;
    }
    default: {
      // Governed workflow-piece effects: `piece:<catalog id>/<action>`. The
      // durable effect's target rides along in `context`, so the sentence can
      // name the recipient, file or endpoint rather than just the piece.
      const governedPiece = /^piece:([^/]+)\/(.+)$/u.exec(request.tool_name);
      if (governedPiece) return describeGovernedPieceIntent(governedPiece[1]!, governedPiece[2]!, request);
      const verb = request.tool_name.replace(/_/g, ' ');
      return `${verb}`.replace(/^./, (c) => c.toUpperCase());
    }
  }
}

/** A governed piece's target value in the dashboard sentence: the 80 it always had. */
const GOVERNED_TARGET_VALUE_MAX_CHARS = 80;

/**
 * "Gmail - send email to finance@example.test, subject: Q3 invoice".
 *
 * Reads the reviewed target out of the approval's context, which is what the
 * piece adapter resolved from the step's real input. A card that said only
 * "gmail" would not be governance.
 */
function describeGovernedPieceIntent(pieceId: string, action: string, request: ApprovalRequest): string {
  const label = pieceId.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
  const verb = action.replace(new RegExp(`^${pieceId.replace(/-/g, '_')}_`, 'u'), '').replace(/[_-]/g, ' ');
  let target: Record<string, unknown> = {};
  try {
    const context: unknown = JSON.parse(request.context ?? '{}');
    if (context && typeof context === 'object' && !Array.isArray(context)) {
      const raw = (context as Record<string, unknown>).target;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) target = raw as Record<string, unknown>;
    }
  } catch {
    // No context to read; the piece and action alone still describe the step.
  }
  const details: string[] = [];
  for (const [key, value] of Object.entries(target)) {
    if (key === 'piece' || key === 'action' || key === 'unmappedAction') continue;
    const rendered = Array.isArray(value) ? value.map(item => String(item)).join(', ')
      : value === null || typeof value === 'object' ? undefined : String(value);
    if (!rendered) continue;
    // The step's real input, which a flow can wire from anything it read, so
    // one line with no format characters before the 80-character cut (#697):
    // the same reduction #651 gave the Telegram card's labels.
    const shown = boundedApprovalLabel(rendered, GOVERNED_TARGET_VALUE_MAX_CHARS) || '(invisible characters only)';
    details.push(`${key.replace(/_/g, ' ')}: ${shown}`);
    if (details.length === 3) break;
  }
  const head = `${label} - ${verb}`;
  return details.length > 0 ? `${head} (${details.join(', ')})` : head;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * A model-supplied argument in a fallback sentence: one line with no format
 * characters, not cut (#721 review). Since #721 these sentences lead the card
 * whenever the engine's reason is an override or a context rule, where before
 * the reason replaced them, so they get the reduction the headline gets. A
 * value that reduces to nothing falls back like a missing one.
 */
function labelOf(v: unknown): string | undefined {
  const s = asString(v);
  return s === undefined ? undefined : boundedApprovalLabel(s, s.length).trim() || undefined;
}


/** A label as the channel card shows it, and whether showing it cut anything. */
function cardLine(text: string): { shown: string; cut: boolean } {
  const shown = boundedApprovalLabel(text, APPROVAL_LABEL_DELIVERY_MAX_CHARS);
  return { shown, cut: shown !== boundedApprovalLabel(text, text.length) };
}

/**
 * The Telegram/Discord approval card (#718), and whether it may be approved by
 * replying to it.
 *
 * It leads with what will happen -- the gate's sentence, the same one the
 * dashboard leads with -- on its own `Intent:` line. Before #718 it carried
 * only `Action:`, `Agent:` and `Reason:`, so a `site_run_command` was approved
 * from a chat without the command ever being shown. The reason keeps its own
 * `Reason:` line rather than following the sentence in parentheses, so a
 * command cannot imitate it.
 *
 * Every line is reduced like any label: one line, no format characters, the
 * delivery backstop. A line the backstop CUT is not shown whole, so the card
 * then offers only `deny` and sends the person to the dashboard to approve;
 * `approvable` is what the channel reply handler (`channelApprovalReply`)
 * checks before it acts on an `approve`. Denying something you could not
 * read whole is always safe.
 *
 * The card is sent as literal text (`{ literal: true }`): Telegram's Markdown
 * and Discord's markdown would otherwise render a label's own `[text](url)`,
 * `||spoiler||`, `*`/`_` pairs or mentions, which can hide or drop part of
 * what is being approved.
 */
export function approvalChannelCard(request: ApprovalRequest): { text: string; approvable: boolean } {
  const shortId = request.id.slice(0, 8);
  const { action, reason } = approvalIntentParts(request);
  const intent = cardLine(action);
  const tool = cardLine(request.tool_name);
  const agent = cardLine(request.agent_name);
  const why = cardLine(reason);
  const approvable = ![intent, tool, agent, why].some((line) => line.cut);
  return {
    approvable,
    text: [
      `[APPROVAL NEEDED]`,
      `Intent: ${intent.shown}`,
      `Action: ${tool.shown} (${request.action_category})`,
      `Agent: ${agent.shown}`,
      ...(why.shown ? [`Reason: ${why.shown}`] : []),
      ``,
      ...(approvable
        ? [`Reply with:`, `  approve ${shortId}`, `  deny ${shortId}`]
        : [
            `This is too long to show whole here, so it cannot be approved from this chat.`,
            `Open the Jarvis dashboard to read all of it and decide, or reply:`,
            `  deny ${shortId}`,
          ]),
    ].join('\n'),
  };
}

export type ApprovalBroadcaster = {
  broadcastApprovalRequest(request: ApprovalRequest): void;
};

export type ChannelSender = {
  broadcastToAll(text: string, options?: SendOptions): Promise<void>;
};

export class ApprovalDelivery {
  private broadcaster: ApprovalBroadcaster | null = null;
  private channelSender: ChannelSender | null = null;

  setBroadcaster(broadcaster: ApprovalBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  setChannelSender(sender: ChannelSender): void {
    this.channelSender = sender;
  }

  /**
   * Deliver an approval request to all appropriate channels.
   */
  async deliver(request: ApprovalRequest): Promise<void> {
    // Always push to dashboard via WebSocket
    this.broadcaster?.broadcastApprovalRequest(request);

    // Always push to Telegram/Discord so users can approve/deny directly
    // from messaging channels without opening the dashboard.
    if (this.channelSender) {
      try {
        const card = approvalChannelCard(request);
        await this.channelSender.broadcastToAll(card.text, { literal: true });
      } catch (err) {
        console.error('[ApprovalDelivery] Failed to send to external channels:', err);
      }
    }
  }
}
