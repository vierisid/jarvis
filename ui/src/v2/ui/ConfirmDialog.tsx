import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./ConfirmDialog.css";

/* ═══════════════════ Branded confirm dialog ═══════════════════
   Replaces native window.confirm() — which renders as unbranded OS/browser
   chrome — with an in-app Monochrome Lab modal. Imperative, promise-based, so a call
   site is just `if (!(await confirmDialog("Delete X?"))) return;`. A single
   <ConfirmHost/> mounted at the app root does the rendering. */

export type ConfirmOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Auto-inferred from the message when omitted. */
  danger?: boolean;
};

let openConfirm: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

// Serialize dialogs: a second confirmDialog() while one is open waits for the
// first to settle instead of clobbering the host state (which would leave the
// first caller's promise hanging forever).
let confirmQueue: Promise<unknown> = Promise.resolve();

/** Show a branded confirmation. Resolves true on confirm, false on cancel.
 *  Falls back to native confirm() if the host isn't mounted (e.g. tests). */
export function confirmDialog(message: string, opts: Partial<ConfirmOptions> = {}): Promise<boolean> {
  const run = confirmQueue.then(() => {
    if (!openConfirm) return typeof window !== "undefined" ? window.confirm(message) : true;
    return openConfirm({ message, ...opts });
  });
  confirmQueue = run.catch(() => {});
  return run;
}

const DANGER_RE = /\b(delete|remove|revoke|disconnect|clear|discard|permanently|cannot be undone|deletes|lost|wipe|reset)\b/i;
const VERB_RE = /^\s*(delete|remove|revoke|disconnect|clear|restart|replay|discard|skip|reset|forget|uninstall|install|update)\b/i;

function derive(opts: ConfirmOptions) {
  // Split the first line off as the title; the rest is the body.
  const raw = opts.message.trim();
  const nl = raw.indexOf("\n");
  const title = opts.title ?? (nl >= 0 ? raw.slice(0, nl).trim() : raw);
  const body = opts.title ? raw : nl >= 0 ? raw.slice(nl).trim() : "";
  const danger = opts.danger ?? DANGER_RE.test(raw);
  const verb = raw.match(VERB_RE)?.[1];
  const confirmLabel = opts.confirmLabel ?? (verb ? verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase() : danger ? "Confirm" : "Continue");
  return { title, body, danger, confirmLabel, cancelLabel: opts.cancelLabel ?? "Cancel" };
}

export function ConfirmHost() {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    openConfirm = (opts) => new Promise<boolean>((resolve) => {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setState({ opts, resolve });
    });
    return () => {
      openConfirm = null;
      // Unmounting with a dialog open: settle its promise (as cancel) so the
      // module-level queue can't wedge every future confirmDialog() forever.
      stateRef.current?.resolve(false);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    // Enter is intentionally NOT bound globally: the confirm button holds focus
    // (autoFocus), so Enter activates it natively — and a held key-repeat from
    // the triggering keypress can't auto-confirm before the dialog is readable
    // (the keydown handlers below ignore e.repeat).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === "Tab") {
        // Focus trap: Tab cycles within the dialog instead of escaping into
        // the obscured page underneath.
        const box = boxRef.current;
        if (!box) return;
        const focusables = box.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !box.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !box.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return null;
  const { title, body, danger, confirmLabel, cancelLabel } = derive(state.opts);
  const close = (v: boolean) => {
    state.resolve(v);
    setState(null);
    restoreFocusRef.current?.focus?.();
    restoreFocusRef.current = null;
  };

  return createPortal(
    <div className="jconfirm" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div ref={boxRef} className="jconfirm__box" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="jconfirm__title">{title}</div>
        {body && <div className="jconfirm__body">{body}</div>}
        <div className="jconfirm__actions">
          <button type="button" className="jconfirm__btn jconfirm__btn--ghost" onClick={() => close(false)}>{cancelLabel}</button>
          <button
            type="button"
            className={`jconfirm__btn ${danger ? "jconfirm__btn--danger" : "jconfirm__btn--pri"}`}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); }}
            onClick={() => close(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
