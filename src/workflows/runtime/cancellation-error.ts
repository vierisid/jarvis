/**
 * The cancellation fence's exception, alone in a leaf module (#630).
 *
 * It lives apart from `cancellation.ts` for one reason: `ToolRegistry.execute`
 * has to recognise it by TYPE, and `cancellation.ts` reaches the workflow
 * database. Measured, with `bun build --target=bun` on `registry.ts`: 3 modules
 * today, 23 if it imports `cancellation.ts` (the workflow db module, the vault
 * schema, the credential encryption helpers, the run-cancellation repo and the
 * cancellation signal bus). `registry.ts` is on every chat turn's path and owns
 * no workflow state, so paying for that graph to read one `instanceof` would be
 * the wrong trade. Importing this file instead costs ONE module, and
 * `cancellation.ts` re-exports the name so no existing importer moves.
 *
 * Matching on `error.name` would have avoided the import without the file --
 * and would be a string comparison standing in for a type, silently satisfied
 * by any other error that chose the same name and silently broken by a rename
 * the compiler would otherwise have caught. The class is three lines; a leaf
 * module for it is cheaper than that.
 */
export class WorkflowCancellationError extends Error {
  override readonly name = "WorkflowCancellationError";
  constructor(runId: string) { super(`Workflow ${runId} was canceled or deleted; no new actions may start. Previously dispatched effects may have completed.`); }
}
