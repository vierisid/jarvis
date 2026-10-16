import React, {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ArrowLeft } from "lucide-react";
import { isSingleValued } from "../../../../../src/vault/fact-policy";
import { BriefButton, BriefTextarea } from "../../components/controls";
import {
  BRIEF_MOTION,
  BRIEF_EASE_OUT,
  useBriefReducedMotion,
} from "../../motion";
import { usageLabel } from "../stream/model";
import { MemoryDetailController } from "./controller";
import "./detail.css";
const date = (at: number | null) =>
  at === null ? "Not recorded" : new Date(at).toLocaleString();
export function MemoryDetailRoom({
  controller,
  onBack,
  onInspect,
}: {
  controller: MemoryDetailController;
  onBack(): void;
  onInspect(id: string): void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const { read, panel, phase } = state;
  const data = read.state === "ready" ? read.data : null;
  const sentence = useRef<HTMLHeadingElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const panelRef = useRef<HTMLDivElement>(null),
    controls = useRef<HTMLDivElement>(null);
  const previousPanel = useRef(panel),
    animated = useRef<string | null>(null);
  const assertion = useRef<HTMLDivElement>(null),
    editNote = useRef<HTMLParagraphElement>(null);
  const [editGeometry, setEditGeometry] = useState({
    assertion: 0,
    actions: 0,
    note: 0,
  });
  const reduced = useBriefReducedMotion();
  useLayoutEffect(() => {
    if (!panel) {
      setEditGeometry({ assertion: 0, actions: 0, note: 0 });
    } else if (data) {
      // Keep the editor anchored when a conflict removes stale canonical content.
      setEditGeometry({
        assertion: assertion.current?.getBoundingClientRect().height ?? 0,
        actions: controls.current?.getBoundingClientRect().height ?? 0,
        note: editNote.current?.getBoundingClientRect().height ?? 0,
      });
    }
  }, [panel, data]);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [state.factId]);
  useLayoutEffect(() => {
    const old = previousPanel.current;
    previousPanel.current = panel;
    if (panel)
      panelRef.current
        ?.querySelector<HTMLElement>("textarea")
        ?.focus({ preventScroll: true });
    else if (old)
      controls.current
        ?.querySelector<HTMLElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
  }, [panel]);
  useLayoutEffect(() => {
    const node = sentence.current,
      origin = controller.origin;
    if (
      !node ||
      !data ||
      !origin ||
      origin.factId !== data.item.factId ||
      animated.current === data.item.factId
    )
      return;
    animated.current = data.item.factId;
    const start = origin.sentence;
    delete origin.sentence;
    if (reduced || typeof node.animate !== "function" || !start) return;
    const rect = node.getBoundingClientRect();
    // Carry the sentence position, never scale text. The canonical read must settle first.
    const animation = node.animate(
      [
        {
          transform: `translate(${start.left - rect.left}px, ${start.top - rect.top}px)`,
        },
        { transform: "translate(0px, 0px)" },
      ],
      { duration: BRIEF_MOTION.transfer.enter, easing: BRIEF_EASE_OUT },
    );
    void animation.finished.catch(() => {});
    return () => animation.cancel();
  }, [data?.item.factId, reduced, controller]);
  const locked = phase === "pending";
  const editable =
    !!data?.item.permissions.canCorrect && data.item.status !== "superseded";
  return (
    <section
      className="brief-memory-detail"
      aria-labelledby="brief-memory-detail-title"
      aria-busy={locked || read.state === "loading"}
    >
      <h1
        id="brief-memory-detail-title"
        className="brief-type-room-title"
        tabIndex={-1}
        ref={heading}
      >
        Memory
      </h1>
      <BriefButton
        variant="text"
        size="sm"
        icon={<ArrowLeft size={14} aria-hidden="true" />}
        disabled={phase === "pending"}
        onClick={() => {
          if (controller.canLeave()) onBack();
          else
            panelRef.current
              ?.querySelector<HTMLElement>("textarea")
              ?.focus({ preventScroll: true });
        }}
      >
        All memories
      </BriefButton>
      <div
        className="brief-memory-detail-assertion"
        ref={assertion}
        style={
          panel ? { minHeight: editGeometry.assertion || undefined } : undefined
        }
      >
        {data ? (
          <>
            <h2
              className="brief-memory-detail-sentence"
              ref={sentence}
              data-fact-id={data.item.factId}
            >
              {data.item.sentence}
            </h2>
            <p className="brief-memory-detail-qualification">
              {data.item.basis} · {data.item.status}
              {data.item.scope && ` · Scope: ${data.item.scope}`}
            </p>
            {(data.item.validity.from !== null ||
              data.item.validity.to !== null) && (
              <p className="brief-memory-detail-qualification">
                Valid from {date(data.item.validity.from)} · until{" "}
                {date(data.item.validity.to)}
              </p>
            )}
          </>
        ) : (
          <div className="brief-memory-detail-unavailable" role="status">
            <h2>
              {read.state === "loading" || read.state === "idle"
                ? "Loading memory…"
                : read.state === "conflict"
                  ? "Memory has changed"
                  : "Memory unavailable"}
            </h2>
            {"reason" in read && <p>{read.reason}</p>}
          </div>
        )}
      </div>
      <div
        className="brief-memory-detail-actions"
        ref={controls}
        style={
          panel ? { minHeight: editGeometry.actions || undefined } : undefined
        }
      >
        <BriefButton
          variant="secondary"
          disabled={!editable || !!panel}
          onClick={() => controller.begin("correct")}
        >
          Edit memory
        </BriefButton>
        {data &&
          (data.item.basis !== "confirmed" ||
            data.item.status === "contested") && (
            <BriefButton
              variant="text"
              disabled={!editable || !!panel}
              onClick={() => controller.begin("confirm")}
            >
              Confirm fact
            </BriefButton>
          )}
        {data?.item.supersededBy && (
          <BriefButton
            variant="text"
            onClick={() => {
              if (controller.canLeave()) onInspect(data.item.supersededBy!);
            }}
          >
            View current value
          </BriefButton>
        )}
      </div>
      {data && !editable && (
        <p className="brief-memory-detail-note">
          {data.item.status === "superseded"
            ? "This is an earlier value. Open the current value to make a decision."
            : "Editing is not available for this fact."}
        </p>
      )}
      <div
        className="brief-memory-detail-feedback"
        data-editing={panel === "correct" || panel === "confirm" || undefined}
        role={state.message ? "status" : undefined}
        aria-live="polite"
      >
        {state.message || "\u00a0"}
      </div>
      {panel && (
        <div className="brief-memory-detail-panel" ref={panelRef} tabIndex={-1}>
          <form
            aria-label={
              panel === "correct" ? "Correct memory" : "Confirm memory"
            }
            onSubmit={(event) => {
              event.preventDefault();
              void controller.save();
            }}
          >
            <h3>
              {panel === "correct" ? "Correct this value" : "Confirm this fact"}
            </h3>
            <p
              className="brief-memory-detail-note"
              ref={editNote}
              style={{ minHeight: editGeometry.note || undefined }}
            >
              {data ? (
                <>
                  Recorded property: {data.fact.predicate}.{" "}
                  {isSingleValued(data.fact.predicate)
                    ? "Confirming this value replaces competing values in the same scope and period."
                    : "Other assertions and scopes are kept."}
                </>
              ) : (
                "\u00a0"
              )}
            </p>
            {panel === "correct" && (
              <BriefTextarea
                label="Correct value"
                rows={3}
                maxLength={4000}
                required
                value={state.object}
                disabled={locked || phase === "unknown"}
                onChange={(event) =>
                  controller.setDraft({ object: event.target.value })
                }
              />
            )}
            <BriefTextarea
              label="Reason or source"
              rows={2}
              maxLength={1000}
              required
              value={state.reason}
              disabled={locked || phase === "unknown"}
              onChange={(event) =>
                controller.setDraft({ reason: event.target.value })
              }
            />
            <div className="brief-memory-detail-actions">
              <BriefButton
                type="submit"
                state={phase === "pending" ? "pending" : "idle"}
                disabled={!editable || locked || phase === "unknown"}
              >
                Save confirmed value
              </BriefButton>
              <BriefButton
                variant="secondary"
                disabled={locked || phase === "unknown"}
                onClick={() => controller.cancelPanel()}
              >
                Cancel
              </BriefButton>
            </div>
          </form>
        </div>
      )}
      {read.state !== "loading" && read.state !== "ready" && (
        <BriefButton disabled={locked} onClick={() => void controller.reload()}>
          Reload current fact
        </BriefButton>
      )}
      {data && (
        <div className="brief-memory-detail-context">
          <section aria-labelledby="memory-source-heading">
            <h3 id="memory-source-heading">Where it came from</h3>
            {data.fact.evidence.length ? (
              data.fact.evidence.map((evidence) => (
                <div className="brief-memory-evidence" key={evidence.id}>
                  <p>
                    {evidence.source || "Source not recorded"} ·{" "}
                    {evidence.basis}
                  </p>
                  {evidence.quote && <blockquote>{evidence.quote}</blockquote>}
                  <small>{date(evidence.recorded_at)}</small>
                  {evidence.source_ref && (
                    <details>
                      <summary>Source reference</summary>
                      <p>{evidence.source_ref}</p>
                    </details>
                  )}
                </div>
              ))
            ) : (
              <p>No source evidence is recorded.</p>
            )}
          </section>
          <section aria-labelledby="memory-use-heading">
            <h3 id="memory-use-heading">Where it helps</h3>
            <p>{usageLabel(data.item)}</p>
            {data.item.uses?.map((use) => (
              <p className="brief-memory-use" key={use.useId}>
                {use.runId
                  ? `Run: ${use.runId}`
                  : use.turn
                    ? `Conversation: ${use.turn.conversationId}`
                    : "Context identity not recorded"}{" "}
                ·{" "}
                {use.stage === "selected"
                  ? "Selected only, not supplied"
                  : "Recorded provider handoff"}{" "}
                · {date(use.at)}
              </p>
            ))}
            <small>
              Retained handoffs show context supplied, not model reliance or
              verified outcomes. Older and uninstrumented use may be missing.
            </small>
          </section>
          <section aria-labelledby="memory-history-heading">
            <h3 id="memory-history-heading">History</h3>
            <p>Recorded {date(data.fact.created_at)}</p>
            {data.fact.verified_at !== null && (
              <p>Confirmed {date(data.fact.verified_at)}</p>
            )}
            <BriefButton
              variant="text"
              size="sm"
              onClick={() => void controller.loadHistory()}
              disabled={state.history.state === "loading"}
            >
              Show earlier values
            </BriefButton>
            {state.history.state === "loading" && (
              <p role="status">Loading earlier values…</p>
            )}
            {"reason" in state.history && (
              <p role="status">{state.history.reason}</p>
            )}
            {state.history.state === "ready" && (
              <>
                <p className="brief-memory-detail-note">
                  Linked correction history; not a complete log of every
                  confirmation.
                </p>
                {state.history.items
                  .filter((item) => item.factId !== data.item.factId)
                  .map((item) => (
                    <article
                      className="brief-memory-history-entry"
                      key={item.factId}
                    >
                      <p>{item.sentence}</p>
                      <small>
                        {item.status} · {item.basis}
                        {item.scope && ` · Scope: ${item.scope}`}
                      </small>
                      <BriefButton
                        variant="text"
                        size="sm"
                        onClick={() => {
                          if (controller.canLeave()) onInspect(item.factId);
                        }}
                      >
                        Inspect value
                      </BriefButton>
                    </article>
                  ))}
                {state.history.items.length <= 1 && (
                  <p>No earlier linked values.</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
