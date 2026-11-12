/**
 * Whether a fact the model proposed reads as an instruction, a standing order
 * or a permission ("always run ...", "pay invoices without approval") rather
 * than a description of the person or their world.
 *
 * Extraction output is shaped by whatever the model read that turn, including a
 * web page or a file, so such a fact is only believed when the owner's own
 * message says it too (the extractor's user_quote check). Memory is recalled
 * into every later prompt; an order planted once would be repeated forever.
 *
 * Deliberately narrow: ordinary preferences and facts ("prefers short replies",
 * "likes to review invoices on Friday") must pass. A miss here is not the
 * control (recall frames non-owner memory as outside content and taints the
 * turn); this only keeps the store from collecting the obvious cases.
 */
const AUTHORITY_WORDS = /\b(?:run|runs|running|execute|exec|send|pay|wire|transfer|delete|remove|install|approve|forward|share|disable|grant|ignore|disregard|override)\b/;
const STANDING = /\b(?:always|never|from now on|going forward|every time|whenever|automatically|standing (?:order|instruction)|owner(?:'s)? (?:order|instruction|permission)|system (?:prompt|instruction))\b/;
const PERMISSION = [
  /\bwithout (?:asking|approval|confirmation|permission|review|checking|prompting)\b/,
  /\b(?:no|skip|bypass|waive) (?:the )?(?:approval|confirmation|review|permission)\b/,
  /\b(?:pre-?approved|auto-?approv\w*|auto-?pay|auto-?run)\b/,
  /\b(?:do not|don't|never) (?:ask|confirm|check|require|wait)\b/,
  /\b(?:is|are|been) (?:authorized|authorised|allowed|permitted|trusted) to\b/,
  /\bhas (?:permission|authority|standing approval) to\b/,
  /\bignore (?:all |any |the |your |previous |prior |earlier )+(?:instructions|rules|approvals?|restrictions|limits)\b/,
  /\bdisregard\b/,
];
const SHELL = /\|\s*(?:sh|bash|zsh)\b|\b(?:curl|wget)\s+\S+|\bsudo\s+\S+|\brm\s+-\w+/;
const LEADING_COMMAND = /^\s*(?:run|execute|send|pay|wire|transfer|delete|install|approve|forward|ignore|disregard|disable|grant)\b/;

export function readsAsInstruction(text: string): boolean {
  const t = text.toLowerCase();
  if (SHELL.test(t) || LEADING_COMMAND.test(t)) return true;
  if (PERMISSION.some(rule => rule.test(t))) return true;
  return STANDING.test(t) && AUTHORITY_WORDS.test(t);
}
