/**
 * Workflow bookkeeping that is not a memory (the assistant's own reports about
 * a flow it built: ids, versions, cron strings, "saved as a disabled draft").
 * One definition for the extractor (never store it) and the Memory stream
 * (hide what was already stored, without deleting it).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A generated id (flow, version, run): one token, 16+ characters, mixed case with a digit. */
export function looksLikeId(text: string): boolean {
  const t = text.trim();
  return UUID.test(t) || (/^[A-Za-z0-9_-]{16,}$/.test(t) && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t));
}

/** A five-field cron expression such as "0 9 * * 1-5". */
export function looksLikeCron(text: string): boolean {
  const fields = text.trim().split(/\s+/);
  return fields.length === 5 && fields.every(f => /^[0-9*/,\-?LW#A-Za-z]+$/.test(f)) && fields.some(f => /[0-9*]/.test(f))
    && fields.every(f => /^[0-9*/,\-?]+$/.test(f) || /^(MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)([,\-].*)?$/i.test(f));
}

/** The object of the fact is an id or a schedule expression, never something a founder says. */
export function isOperationalObject(object: string): boolean {
  return looksLikeId(object) || looksLikeCron(object);
}

/** Words that make an `assistant_` / `reported_` predicate a report about the assistant's own work. */
const BOOKKEEPING_WORDS = new Set(['id', 'ids', 'uuid', 'status', 'state', 'save', 'saved', 'draft', 'drafts', 'version', 'versions',
  'cron', 'schedule', 'workflow', 'workflows', 'flow', 'flows', 'run', 'runs', 'publish', 'published', 'validation', 'validated',
  'blocker', 'blockers', 'blocked', 'trigger', 'triggers', 'result', 'results', 'error', 'errors']);

/**
 * Predicates the extractor uses when the assistant describes its own work
 * ("assistant_reported_save_status", "reported_draft_version_id"). Without a
 * quote from the user's message they are the assistant's report, not a fact.
 * A plain relation such as "reported_to" or "assistant_name" is not: the
 * predicate must also name a piece of the assistant's work.
 */
export function isAssistantReportPredicate(predicate: string): boolean {
  const words = predicate.trim().toLowerCase().split(/[_\s]+/);
  return (words[0] === 'assistant' || words[0] === 'reported') && words.slice(1).some(w => BOOKKEEPING_WORDS.has(w));
}

/**
 * Whether a fact should be kept out of memory. `userQuoted`: a quote from the
 * user's message supports it. `objectStated`: the user's own words contain the
 * object itself, so an id or cron string the user typed (an account id, a
 * schedule they asked for) is theirs, not the assistant's bookkeeping.
 */
export function isOperationalFact(fact: { predicate: string; object: string; userQuoted: boolean; objectStated: boolean }): boolean {
  return (!fact.objectStated && isOperationalObject(fact.object)) || (!fact.userQuoted && isAssistantReportPredicate(fact.predicate));
}

/**
 * A subject that is a workflow itself ("Order ingestion workflow"): what a
 * workflow must do belongs in Workflows, not in memory. Saved workflows are also
 * matched by display name at read time.
 */
export function isWorkflowSubjectName(name: string): boolean {
  return /\bworkflows?$/i.test(name.trim());
}
