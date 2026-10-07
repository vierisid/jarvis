import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { FileText, Check, RefreshCw, ArrowUpRight } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../contracts";
import { BriefButton, BriefIconButton } from "../components/controls";
import { useBriefReducedMotion } from "../motion/hooks";
import { decisionStatus } from "../today/hero-paper/model";
import { DecisionsController } from "./controller";
import {
  actionLabel,
  decisionId,
  documentError,
  fields,
  receiptMessage,
  revision,
  type DecisionDocument,
  type DocumentAction,
} from "./model";
import "./decisions.css";
export interface DecisionsBinding {
  source: "fixture" | "live";
  scopeId: string;
  capabilities?: unknown;
  controller: DecisionsController;
}
export function decisionsAvailable(
  shell: BriefShellPort,
  binding?: DecisionsBinding,
) {
  return (
    !!binding &&
    !!binding.scopeId &&
    binding.source === (shell.mode === "preview" ? "fixture" : "live") &&
    binding.controller.source === binding.source &&
    binding.controller.scopeId === binding.scopeId &&
    (shell.mode === "preview" ||
      isBriefCapabilityEnabled(binding.capabilities, "decisions"))
  );
}
export function DecisionsRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: DecisionsBinding;
}) {
  const available = decisionsAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.controller.setAccess(available);
  }, [available, binding?.controller]);
  if (!available || !binding)
    return (
      <section>
        <h1 className="brief-type-room-title">Needs you</h1>
        <p role="status">Your decisions are unavailable here.</p>
      </section>
    );
  return <ConnectedDecisions shell={shell} controller={binding.controller} />;
}
function ConnectedDecisions({
  shell,
  controller,
}: {
  shell: BriefShellPort;
  controller: DecisionsController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const reduced = useBriefReducedMotion();
  const list = useRef<HTMLElement>(null),
    paper = useRef<HTMLElement>(null),
    actions = useRef<HTMLDivElement>(null);
  const previous = useRef(state.selectedId),
    intent = useRef(false),
    appliedRoute = useRef("");
  useLayoutEffect(() => {
    controller.setReduced(reduced);
  }, [reduced, controller]);
  useEffect(() => {
    if (controller.snapshot().read.status === "loading")
      void controller.refresh();
  }, [controller]);
  useLayoutEffect(() => {
    if (paper.current) paper.current.scrollTop = controller.scrollTop;
    if (list.current) {
      list.current.scrollLeft = controller.listScrollLeft;
      list.current.scrollTop = controller.listScrollTop;
    }
  }, [controller]);
  useLayoutEffect(() => {
    if (state.selectedId !== previous.current) {
      // Keep the route aligned after local settlement, including deferred items that
      // remain in the queue. Otherwise returning can reselect the old approval.
      if (previous.current !== null) {
        const next = state.rows.find(
          (row) => decisionId(row) === state.selectedId,
        );
        const old = shell.route.selection;
        appliedRoute.current = `${old.approvalId || ""}:${old.workItemId || ""}`;
        shell.navigate({
          room: "needs-you",
          selection: next?.paper.decision.approval
            ? { approvalId: next.paper.decision.approval.approvalId }
            : next?.paper.decision.workItemId
              ? { workItemId: next.paper.decision.workItemId }
              : {},
        });
      }
      if (paper.current) paper.current.scrollTop = 0;
      controller.scrollTop = 0;
      if (
        intent.current &&
        (actions.current?.contains(globalThis.document.activeElement) ||
          globalThis.document.activeElement === globalThis.document.body)
      )
        (
          list.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ||
          paper.current
        )?.focus({ preventScroll: true });
      intent.current = false;
      previous.current = state.selectedId;
    }
    const element = list.current;
    if (!element) return;
    const reveal = () => {
      const target = element.querySelector<HTMLElement>(
        '[aria-pressed="true"]',
      );
      if (!target) return;
      const a = target.getBoundingClientRect(),
        b = element.getBoundingClientRect();
      if (a.left < b.left) element.scrollLeft += a.left - b.left - 4;
      else if (a.right > b.left + element.clientWidth)
        element.scrollLeft += a.right - b.left - element.clientWidth + 4;
      if (a.top < b.top) element.scrollTop += a.top - b.top - 4;
      else if (a.bottom > b.top + element.clientHeight)
        element.scrollTop += a.bottom - b.top - element.clientHeight + 4;
    };
    reveal();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [state.selectedId, !!state.rows.length, controller]);
  useEffect(() => {
    const selection = shell.route.selection;
    const key = `${selection.approvalId || ""}:${selection.workItemId || ""}`;
    if (key === ":" || appliedRoute.current === key) return;
    const match = state.rows.find((x) =>
      selection.approvalId
        ? x.paper.decision.approval?.approvalId === selection.approvalId
        : x.paper.decision.workItemId === selection.workItemId,
    );
    if (match && controller.select(decisionId(match)))
      appliedRoute.current = key;
  }, [shell.route.selection, state.rows, controller]);
  const item = state.rows.find((x) => decisionId(x) === state.selectedId);
  const id = item ? decisionId(item) : "";
  const attempt = state.attempts.get(id),
    editing = state.draft?.id === id;
  const document = editing ? state.draft!.document : item?.document;
  const draftChanged =
    editing &&
    (state.read.status !== "ready" ||
      !state.read.data.some(
        (x) => decisionId(x) === id && revision(x) === state.draft!.revision,
      ));
  const frozen =
    attempt?.state === "sending" ||
    attempt?.state === "unknown" ||
    !!attempt?.checking ||
    state.phase !== "rest";
  const feedback =
    attempt?.state === "sending"
      ? "Saving your decision…"
      : attempt?.state === "unknown"
        ? "The result is not confirmed. Check the result before trying again."
        : attempt?.state === "refused"
          ? `${attempt.reason} Refresh to review the current decision.`
          : draftChanged
            ? "This decision changed. Your unsaved text is preserved. Cancel editing and refresh before acting."
            : editing && document
              ? documentError(document) || "Review your changes before saving."
              : attempt?.receipt
                ? receiptMessage(attempt.receipt)
                : item?.reason || "";
  const act = (action: DocumentAction) => {
    intent.current = true;
    void controller.act(id, action, revision(item!));
  };
  const status =
    attempt?.state === "sending" || attempt?.state === "unknown"
      ? "Checking decision"
      : attempt?.receipt && revision(item!) === attempt.request.revision
        ? "Decision saved"
        : item?.state === "deferred"
          ? "Draft kept"
          : item
            ? decisionStatus(item.paper)
            : "";
  return (
    <section className="brief-decisions" data-reduced={reduced}>
      <header className="brief-decisions-heading">
        <h1 className="brief-type-room-title">Needs you</h1>
        <BriefIconButton
          label="Refresh decisions"
          icon={<RefreshCw size={16} />}
          disabled={state.refreshing || state.phase !== "rest"}
          onClick={() => void controller.refresh()}
        />
      </header>
      {state.read.status !== "ready" && "reason" in state.read && (
        <p className="brief-decision-notice" role="status">
          {state.read.reason}
        </p>
      )}
      {!item ? (
        <div className="brief-decisions-empty" role="status">
          <FileText size={26} />
          <h2 className="brief-type-section-heading">
            {state.read.status === "loading"
              ? "Loading decisions…"
              : ["unavailable", "unsupported"].includes(state.read.status)
                ? "Decisions are unavailable"
                : "Nothing needs your review"}
          </h2>
          <p>{state.message}</p>
        </div>
      ) : (
        <div className="brief-decisions-grid">
          <nav
            ref={list}
            className="brief-decision-list"
            aria-label="Decisions to review"
            onScroll={(e) => {
              controller.listScrollTop = e.currentTarget.scrollTop;
              controller.listScrollLeft = e.currentTarget.scrollLeft;
            }}
          >
            {state.rows.map((row) => (
              <button
                type="button"
                className="brief-decision-choice"
                key={decisionId(row)}
                aria-label={row.paper.title}
                aria-pressed={decisionId(row) === id}
                disabled={!!state.draft || state.phase !== "rest"}
                onClick={() => {
                  intent.current = false;
                  if (controller.select(decisionId(row)))
                    shell.navigate({
                      room: "needs-you",
                      selection: row.paper.decision.approval
                        ? { approvalId: row.paper.decision.approval.approvalId }
                        : row.paper.decision.workItemId
                          ? { workItemId: row.paper.decision.workItemId }
                          : {},
                    });
                }}
              >
                <span>
                  <strong>{row.paper.title}</strong>
                </span>
                <span className="brief-decision-recipient">
                  {row.paper.document.recipient || "Decision"}
                </span>
                <span className="brief-decision-hint">
                  {row.paper.description}
                </span>
                <small>
                  {decisionId(row) === id ? (
                    <>
                      <Check size={13} />
                      Selected
                    </>
                  ) : row.state === "deferred" ? (
                    "Draft kept"
                  ) : (
                    row.paper.reviewLabel
                  )}
                </small>
              </button>
            ))}
          </nav>
          <article
            ref={paper}
            tabIndex={-1}
            className="brief-decision-paper"
            data-decision={id}
            data-revision={revision(item)}
            data-phase={state.phase}
            onScroll={(e) => {
              controller.scrollTop = e.currentTarget.scrollTop;
            }}
            aria-labelledby="decision-title"
          >
            <header className="brief-decision-title">
              <h2 id="decision-title" className="brief-type-section-heading">
                {item.paper.title}
              </h2>
              <span className="brief-decision-badge">
                <i />
                {status}
              </span>
            </header>
            <div className="brief-decision-context">
              <span>{item.context}</span>
              {item.paper.decision.workflow && (
                <BriefButton
                  size="sm"
                  variant="ghost"
                  icon={<ArrowUpRight size={14} />}
                  onClick={() =>
                    shell.navigate({
                      room: "workflow",
                      selection: {
                        flowId: item.paper.decision.workflow!.flowId,
                        versionId:
                          item.paper.decision.workflow!.versionId || undefined,
                        runId: item.paper.decision.run?.runId,
                      },
                    })
                  }
                >
                  Open workflow
                </BriefButton>
              )}
            </div>
            <div className="brief-decision-document">
              {document ? (
                fields(item.document || document).map((original) => {
                  const field = fields(document).find(
                    (f) => f.key === original.key,
                  ) || { ...original, value: "" };
                  return (
                    <DocumentField
                      key={`${id}:${field.key}`}
                      label={field.label}
                      value={field.value}
                      multiline={field.multiline}
                      editable={!!editing}
                      frozen={frozen}
                      attention={item.paper.document.attention}
                      onChange={(value) => {
                        const addresses = [
                          "to",
                          "cc",
                          "bcc",
                          "attendees",
                        ].includes(field.key);
                        controller.change({
                          ...document,
                          [field.key]: addresses
                            ? value
                                .split(",")
                                .map((v) => v.trim())
                                .filter(Boolean)
                            : value,
                        });
                      }}
                    />
                  );
                })
              ) : (
                <>
                  <p>{item.paper.document.recipient}</p>
                  <h3>{item.paper.document.subject}</h3>
                  {item.paper.document.paragraphs.map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                  {item.paper.document.attention && (
                    <mark>{item.paper.document.attention}</mark>
                  )}
                </>
              )}
              {item.options.length > 0 && (
                <dl className="brief-decision-options">
                  {item.options.map((option) => (
                    <div key={option.label}>
                      <dt>{option.label}</dt>
                      <dd>{option.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            <div className="brief-decision-bottom">
              <div ref={actions} className="brief-decision-actions">
                <BriefButton
                  variant="secondary"
                  disabled={editing ? frozen : !controller.canBeginEdit(id)}
                  onClick={() =>
                    editing ? controller.cancelEdit() : controller.edit(id)
                  }
                >
                  {editing ? "Cancel edit" : "Edit draft"}
                </BriefButton>
                <BriefButton
                  variant="ghost"
                  disabled={!controller.canAct(id, "keep_draft")}
                  onClick={() => act("keep_draft")}
                >
                  {actionLabel(item, "keep_draft")}
                </BriefButton>
                <BriefButton
                  variant="ghost"
                  disabled={!controller.canAct(id, "reject")}
                  onClick={() => act("reject")}
                >
                  {actionLabel(item, "reject")}
                </BriefButton>
                <BriefButton
                  variant="primary"
                  disabled={
                    !controller.canAct(
                      id,
                      editing
                        ? "save"
                        : item.actions.includes("reopen")
                          ? "reopen"
                          : "approve",
                    )
                  }
                  onClick={() =>
                    act(
                      editing
                        ? "save"
                        : item.actions.includes("reopen")
                          ? "reopen"
                          : "approve",
                    )
                  }
                >
                  {actionLabel(
                    item,
                    editing
                      ? "save"
                      : item.actions.includes("reopen")
                        ? "reopen"
                        : "approve",
                  )}
                </BriefButton>
              </div>
              <div
                className="brief-decision-feedback"
                role="status"
                aria-live="polite"
              >
                <span>
                  {feedback ||
                    (!item.editable && !item.actions.length
                      ? "This decision is read-only here."
                      : "")}
                </span>
                {attempt &&
                  !attempt.settled &&
                  ["unknown", "confirmed"].includes(attempt.state) &&
                  state.phase === "rest" && (
                    <BriefButton
                      size="sm"
                      disabled={attempt.checking}
                      onClick={() => void controller.recover(id)}
                    >
                      Check result
                    </BriefButton>
                  )}
              </div>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
function DocumentField({
  label,
  value,
  multiline,
  editable,
  frozen,
  attention,
  onChange,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  editable: boolean;
  frozen: boolean;
  attention?: string;
  onChange: (v: string) => void;
}) {
  const [raw, setRaw] = useState(value);
  useEffect(() => {
    if (!editable) setRaw(value);
  }, [editable, value]);
  const parts = attention && !editable ? value.split(attention) : [value];
  return (
    <div
      className="brief-document-field"
      data-field={label}
      data-multiline={!!multiline}
      data-editing={editable}
    >
      <label>{label}</label>
      <div className="brief-document-value">
        <span className="brief-document-mirror" aria-hidden="true">
          {value || " "}
          {"\n"}
        </span>
        {editable ? (
          <textarea
            aria-label={label}
            value={raw}
            disabled={frozen}
            spellCheck
            rows={1}
            onChange={(e) => {
              setRaw(e.target.value);
              onChange(e.target.value);
            }}
          />
        ) : (
          <div className="brief-document-read">
            {parts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <mark>{attention}</mark>}
                {part}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
/** Optional mount only. Live registration waits for the F-12/F-14 authenticated owner. */
export function decisionsRegistration(
  useBinding: () => DecisionsBinding | undefined,
): BriefRoomModule {
  return {
    id: "needs-you",
    title: "Needs you",
    legacyRoom: "authority",
    Body: ({ shell }) => <DecisionsRoom shell={shell} binding={useBinding()} />,
  };
}
