import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./ConfirmDialog.css";

/* ═══════════════════ Branded confirm dialog ═══════════════════
   Replaces native window.confirm() — which renders as unbranded OS/browser
   chrome — with an in-app FABLE5 modal. Imperative, promise-based, so a call
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

/** Show a branded confirmation. Resolves true on confirm, false on cancel.
 *  Falls back to native confirm() if the host isn't mounted (e.g. tests). */
export function confirmDialog(message: string, opts: Partial<ConfirmOptions> = {}): Promise<boolean> {
  if (!openConfirm) return Promise.resolve(typeof window !== "undefined" ? window.confirm(message) : true);
  return openConfirm({ message, ...opts });
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

  useEffect(() => {
    openConfirm = (opts) => new Promise<boolean>((resolve) => setState({ opts, resolve }));
    return () => { openConfirm = null; };
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!state) return null;
  const { title, body, danger, confirmLabel, cancelLabel } = derive(state.opts);
  const close = (v: boolean) => { state.resolve(v); setState(null); };

  return createPortal(
    <div className="jconfirm" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div className="jconfirm__box" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="jconfirm__title">{title}</div>
        {body && <div className="jconfirm__body">{body}</div>}
        <div className="jconfirm__actions">
          <button type="button" className="jconfirm__btn jconfirm__btn--ghost" onClick={() => close(false)}>{cancelLabel}</button>
          <button type="button" className={`jconfirm__btn ${danger ? "jconfirm__btn--danger" : "jconfirm__btn--pri"}`} autoFocus onClick={() => close(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
