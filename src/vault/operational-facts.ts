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

/**
 * Predicates the extractor uses when the assistant describes its own work
 * ("assistant_reported_save_status", "reported_draft_version_id"). Without a
 * quote from the user's message they are the assistant's report, not a fact.
 */
export function isAssistantReportPredicate(predicate: string): boolean {
  return /^(assistant_|reported_)/.test(predicate);
}

/** Whether a fact should be kept out of memory. `userQuoted`: the user's own words support it. */
export function isOperationalFact(fact: { predicate: string; object: string; userQuoted: boolean }): boolean {
  return isOperationalObject(fact.object) || (!fact.userQuoted && isAssistantReportPredicate(fact.predicate));
}

/**
 * A subject that is a workflow itself ("Order ingestion workflow"): what a
 * workflow must do belongs in Workflows, not in memory. Saved workflows are also
 * matched by display name at read time.
 */
export function isWorkflowSubjectName(name: string): boolean {
  return /\bworkflows?$/i.test(name.trim());
}
