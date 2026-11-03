/**
 * The native ticket refund step and the saved account it names, by input
 * field: the provider piece it must belong to and its label in the editor.
 * A leaf module with no imports, shared by the runtime, the binding pins, the
 * readiness rule, the safeguards and the UI.
 */
export const REFUND_PIECE = '@jarvispieces/piece-jarvis-refund';
export const REFUND_ACTION = 'approval_refund';
export const REFUND_ACCOUNTS = { stripeConnection: '@activepieces/piece-stripe' } as const;
export type RefundAccountField = keyof typeof REFUND_ACCOUNTS;
export const REFUND_ACCOUNT_LABELS: Record<RefundAccountField, string> = { stripeConnection: 'Stripe' };
/** Fields, providers and labels in display order. */
export const REFUND_ACCOUNT_FIELDS = (Object.keys(REFUND_ACCOUNTS) as RefundAccountField[])
  .map(field => [field, REFUND_ACCOUNTS[field], REFUND_ACCOUNT_LABELS[field]] as const);
/**
 * No managed-connection exemption covers the refund: the Stripe account it
 * names must be a saved account, refused in readiness and at run time.
 */
export function managedRefundRefusal(field: RefundAccountField): string {
  return `Select a saved ${REFUND_ACCOUNT_LABELS[field]} account; a Jarvis-managed connection cannot be used by the ticket refund`;
}
/**
 * The request key names the ticket, not a loop iteration, so a refund step in
 * a loop body could raise one card per iteration for the same ticket. It is
 * refused in readiness and at run time.
 */
export const REFUND_LOOP_REFUSAL = 'Move the ticket refund step out of the loop; one ticket event proposes one refund';
/** The jarvis-refund piece names a refund step may carry, exactly. */
export const REFUND_STEP_PIECES: readonly string[] = [REFUND_PIECE, 'jarvis-refund'];
/** One rule for every check (pins, readiness, safeguards), as for the report step: any spelling of the refund piece is the
 * refund step. Only the canonical name runs; readiness refuses the short name instead of passing it to fail at run time. */
export function isRefundAction(settings: {pieceName?: unknown; actionName?: unknown} | undefined): boolean {
  return typeof settings?.pieceName === 'string' && REFUND_STEP_PIECES.includes(settings.pieceName) && settings?.actionName === REFUND_ACTION;
}
/**
 * Whether a flow node is a ticket refund step: a PIECE action node of the
 * exact jarvis-refund piece running approval_refund. A CODE node or a trigger
 * carrying the same settings is not one, and neither is a piece whose name
 * merely ends in jarvis-refund.
 */
export function isRefundStep(nodeType: unknown, settings: unknown): boolean {
  if (nodeType !== 'PIECE' || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const s = settings as Record<string, unknown>;
  return isRefundAction(s) && s.triggerName === undefined;
}
