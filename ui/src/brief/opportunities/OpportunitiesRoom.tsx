import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  Check,
  ChevronRight,
  FileText,
  Globe,
  RefreshCw,
  Target,
} from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../contracts";
import { BriefButton, BriefIconButton } from "../components/controls";
import { useBriefReducedMotion } from "../motion/hooks";
import { OpportunitiesController } from "./controller";
import {
  APPROVE_LABEL,
  approvalBlock,
  receiptMessage,
  resolvedReceipt,
} from "./model";
import "./opportunities.css";

export interface OpportunitiesBinding {
  source: "fixture" | "live";
  scopeId: string;
  capabilities?: unknown;
  controller: OpportunitiesController;
}
export function opportunitiesAvailable(
  shell: BriefShellPort,
  binding?: OpportunitiesBinding,
) {
  return (
    !!binding &&
    !!binding.scopeId &&
    binding.source === (shell.mode === "preview" ? "fixture" : "live") &&
    binding.controller.source === binding.source &&
    binding.controller.scopeId === binding.scopeId &&
    (shell.mode === "preview" ||
      isBriefCapabilityEnabled(binding.capabilities, "preparedOpportunities"))
  );
}
export function OpportunitiesRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: OpportunitiesBinding;
}) {
  const available = opportunitiesAvailable(shell, binding);
  const write =
    available &&
    (shell.mode === "preview" ||
      isBriefCapabilityEnabled(binding?.capabilities, "opportunityActivation"));
  useLayoutEffect(() => {
    binding?.controller.setAccess(available, write);
  }, [binding?.controller, available, write]);
  if (!available || !binding)
    return (
      <section className="brief-opportunities">
        <h1 className="brief-type-room-title">Opportunities</h1>
        <p role="status">Prepared opportunities are unavailable.</p>
      </section>
    );
  return (
    <ConnectedOpportunities
      shell={shell}
      controller={binding.controller}
      write={write}
    />
  );
}
function ConnectedOpportunities({
  shell,
  controller,
  write,
}: {
  shell: BriefShellPort;
  controller: OpportunitiesController;
  write: boolean;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const reduced = useBriefReducedMotion();
  const scroll = useRef<HTMLDivElement>(null),
    list = useRef<HTMLElement>(null),
    actions = useRef<HTMLDivElement>(null);
  const appliedRoute = useRef<string | undefined>(undefined);
  const moveFocus = useRef(false),
    previousId = useRef(state.selectedId);
  useLayoutEffect(() => {
    controller.setReduced(reduced);
  }, [controller, reduced]);
  useEffect(() => {
    if (controller.snapshot().read.status === "loading")
      void controller.refresh();
  }, [controller]);
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = controller.scrollTop;
  }, [controller]);
  useLayoutEffect(() => {
    if (
      previousId.current !== state.selectedId &&
      moveFocus.current &&
      (actions.current?.contains(document.activeElement) ||
        document.activeElement === document.body)
    ) {
      (
        list.current?.querySelector<HTMLButtonElement>(
          '[aria-pressed="true"]',
        ) ?? scroll.current
      )?.focus({ preventScroll: true });
    }
    if (previousId.current !== state.selectedId) moveFocus.current = false;
    previousId.current = state.selectedId;
  }, [state.selectedId]);
  useEffect(() => {
    const id = shell.route.selection.opportunityId;
    if (
      id &&
      appliedRoute.current !== id &&
      state.rows.some((x) => x.proposal.proposalId === id)
    ) {
      appliedRoute.current = id;
      controller.select(id);
    }
  }, [shell.route.selection.opportunityId, state.rows, controller]);
  const item = state.rows.find(
    (x) => x.proposal.proposalId === state.selectedId,
  );
  const attempt = item && state.attempts.get(item.proposal.proposalId);
  const receipt = attempt?.receipt;
  const block = item ? approvalBlock(item) : null;
  const status = receipt
    ? receipt.decision === "dismiss"
      ? "Dismissed"
      : resolvedReceipt(receipt)
        ? "Enabled"
        : "Approval saved"
    : attempt?.state === "refused"
      ? "Decision not saved"
      : attempt
        ? "Awaiting confirmation"
        : state.read.status !== "ready"
          ? "Refresh needed"
          : item?.proposal.state === "preparing"
            ? "Preparing"
            : block
              ? "Needs attention"
              : "Ready to enable";
  const feedback = receipt
    ? receiptMessage(receipt)
    : attempt?.state === "refused"
      ? `${attempt.reason} Refresh before deciding again.`
      : attempt?.state === "unknown"
        ? "The result is not confirmed. Check the saved decision before trying anything else."
        : attempt
          ? "Saving your decision…"
          : !write
            ? "Approval and dismissal are unavailable until activation is connected."
            : state.read.status === "stale"
              ? state.read.reason
              : block;
  const unavailable = ["unavailable", "unsupported"].includes(
    state.read.status,
  );
  const act = (decision: "approve" | "dismiss") => {
    if (!item) return;
    moveFocus.current = true;
    void controller.act(item.proposal.proposalId, decision);
  };
  return (
    <section
      className="brief-opportunities"
      data-compact={shell.chatOpen}
      data-reduced={reduced}
    >
      <header className="brief-opportunities-heading">
        <h1 className="brief-type-room-title">Opportunities</h1>
        <BriefIconButton
          label="Refresh opportunities"
          icon={<RefreshCw size={16} />}
          disabled={state.refreshing}
          onClick={() => void controller.refresh()}
        />
      </header>
      <div
        className="brief-opportunities-scroll"
        ref={scroll}
        tabIndex={-1}
        onScroll={(e) => {
          controller.scrollTop = e.currentTarget.scrollTop;
        }}
      >
        {(state.read.status === "stale" || unavailable) && (
          <p className="brief-opportunities-notice" role="status">
            {"reason" in state.read
              ? state.read.reason
              : "Opportunities are unavailable."}
          </p>
        )}
        {!item ? (
          <div className="brief-opportunities-empty" role="status">
            <FileText size={24} aria-hidden="true" />
            <h2 className="brief-type-section-heading">
              {state.read.status === "loading"
                ? "Loading opportunities…"
                : unavailable
                  ? "Opportunities are unavailable"
                  : "No proposals to review"}
            </h2>
            <p>
              {state.message ||
                (state.read.status === "loading"
                  ? ""
                  : "Prepared opportunities will appear here.")}
            </p>
          </div>
        ) : (
          <div className="brief-opportunities-grid">
            <nav
              ref={list}
              className="brief-opportunity-list"
              aria-label="Available proposals"
            >
              {state.rows.map((row) => (
                <button
                  type="button"
                  key={row.proposal.proposalId}
                  className="brief-proposal-choice"
                  aria-pressed={row.proposal.proposalId === state.selectedId}
                  aria-label={row.title}
                  onClick={() => {
                    moveFocus.current = false;
                    controller.select(row.proposal.proposalId);
                    shell.navigate({
                      room: "opportunities",
                      selection: { opportunityId: row.proposal.proposalId },
                    });
                  }}
                >
                  <span className="brief-proposal-name">
                    <FileText size={18} aria-hidden="true" />
                    <strong>{row.title}</strong>
                  </span>
                  <span className="brief-proposal-observation">
                    {row.listObservation || row.observation}
                  </span>
                  <span className="brief-proposal-goal">
                    {row.goalTitle || "Goal link unavailable"}
                  </span>
                  <span className="brief-proposal-selected">
                    {row.proposal.proposalId === state.selectedId ? (
                      <>
                        <Check size={13} aria-hidden="true" />
                        Selected
                      </>
                    ) : (
                      "Open brief"
                    )}
                  </span>
                </button>
              ))}
            </nav>
            <article
              className="brief-finished"
              data-proposal={item.proposal.proposalId}
              data-revision={item.proposal.revision}
              data-phase={state.phase}
              aria-labelledby="finished-title"
            >
              <header className="brief-finished-header">
                <h2 id="finished-title" className="brief-type-section-heading">
                  {item.title}
                </h2>
                <span
                  className="brief-finished-status"
                  data-status={
                    receipt?.decision === "approve" && resolvedReceipt(receipt)
                      ? "enabled"
                      : block && !receipt
                        ? "attention"
                        : "neutral"
                  }
                >
                  <i aria-hidden="true" />
                  {status}
                </span>
              </header>
              <div className="brief-finished-content">
                <div className="brief-finished-preview">
                  <div className="brief-observed">
                    <p className="brief-type-utility">Jarvis noticed</p>
                    <h3>{item.observation}</h3>
                    <p className="brief-observed-source">
                      <Globe size={16} aria-hidden="true" />
                      {item.observationSource}
                    </p>
                  </div>
                  <div className="brief-finished-paper">
                    <h3>
                      <FileText size={17} aria-hidden="true" />
                      {item.output?.title || "Output preview"}
                    </h3>
                    {item.output ? (
                      <>
                        <ul>
                          {item.output.lines.map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>
                        {item.output.emphasis && (
                          <p className="brief-output-emphasis">
                            {item.output.emphasis}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="brief-output-missing">
                        A preview is not available for this prepared version.
                      </p>
                    )}
                    <p className="brief-output-basis">
                      {!item.output
                        ? ""
                        : item.proposal.previewBasis === "verified_output"
                          ? "Verified output"
                          : item.proposal.previewBasis === "sandbox_sample"
                            ? "Sandbox sample"
                            : item.proposal.previewBasis ===
                                "illustrative_template"
                              ? "Illustrative output preview"
                              : "Unverified preview"}
                    </p>
                  </div>
                </div>
                <div className="brief-opportunity-goal">
                  <Target size={21} aria-hidden="true" />
                  <div>
                    <strong>
                      {item.proposal.goal?.rationale ||
                        "Goal contribution unavailable"}
                    </strong>
                    <p>{item.goalTitle || "No verified goal link"}</p>
                  </div>
                </div>
                {item.steps.length > 0 && (
                  <ol
                    className="brief-mini-workflow"
                    aria-label="Prepared workflow steps"
                  >
                    {item.steps.map((step, i) => (
                      <li key={step.id}>
                        <span>{step.title}</span>
                        {i < item.steps.length - 1 && (
                          <ChevronRight size={12} aria-hidden="true" />
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="brief-opportunity-schedule">
                  {[item.schedule, item.target].filter(Boolean).join(" · ") ||
                    "Schedule and target are not available."}
                </p>
              </div>
              <div className="brief-finished-actions" ref={actions}>
                <BriefButton
                  variant="primary"
                  disabled={
                    !controller.canAct(item.proposal.proposalId, "approve")
                  }
                  onClick={() => act("approve")}
                >
                  {APPROVE_LABEL}
                </BriefButton>
                <BriefButton
                  variant="ghost"
                  disabled={
                    !controller.canAct(item.proposal.proposalId, "dismiss")
                  }
                  onClick={() => act("dismiss")}
                >
                  Dismiss
                </BriefButton>
                {attempt &&
                  attempt.state !== "sending" &&
                  attempt.state !== "refused" &&
                  (!receipt || !resolvedReceipt(receipt)) && (
                    <BriefButton
                      size="sm"
                      state={attempt.checking ? "pending" : "idle"}
                      onClick={() =>
                        void controller.recover(item.proposal.proposalId)
                      }
                    >
                      Check result
                    </BriefButton>
                  )}
              </div>
              <div
                className="brief-finished-feedback"
                role="status"
                aria-live="polite"
              >
                {feedback}
              </div>
            </article>
          </div>
        )}
      </div>
    </section>
  );
}
/** Opt-in host seam. The released registry is deliberately unchanged. */
export function opportunitiesRegistration(
  useBinding: () => OpportunitiesBinding | undefined,
): BriefRoomModule {
  return {
    id: "opportunities",
    title: "Opportunities",
    legacyRoom: "workflows",
    Body: ({ shell }) => (
      <OpportunitiesRoom shell={shell} binding={useBinding()} />
    ),
  };
}
