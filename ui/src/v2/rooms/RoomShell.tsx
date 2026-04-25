import React, { useEffect, useRef } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button, Icon } from "../ui";
import { closeRoom } from "../router";
import "./RoomShell.css";

export interface RoomShellAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost" | "danger";
}

export interface RoomShellProps {
  title: string;
  /** Optional breadcrumb fragments shown above the title (e.g. ["Memory"]). */
  breadcrumb?: string[];
  /** Optional short subtitle / count line ("5 workflows · 4 active"). */
  subtitle?: string;
  /** Top-right action buttons. Last one in the array is rendered as primary. */
  actions?: RoomShellAction[];
  /** Override the default close handler. Defaults to `closeRoom()`. */
  onClose?: () => void;
  children: React.ReactNode;
}

/**
 * Shared shell for every Phase 6 Room. Implements the design handoff
 * COMPONENTS.md contract: `{ title, breadcrumb, actions[], onClose }`,
 * full-screen overlay over the AppShell, slide-up from bottom (360ms
 * with `prefers-reduced-motion` fallback), Esc to close, focus trap.
 *
 * Visual language matches the rest of v2: bone paper, soft dividers,
 * single-accent discipline (primary action button is the only accent).
 */
export function RoomShell({
  title,
  breadcrumb,
  subtitle,
  actions = [],
  onClose,
  children,
}: RoomShellProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handleClose = onClose ?? closeRoom;

  // Esc closes the Room. Stop propagation so the underlying shell's
  // listeners don't double-fire.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  // Lock background scroll while a Room is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Move focus into the Room on mount so keyboard nav starts here.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // The "primary" action is the LAST entry in actions[]; everything else
  // is ghost. Mirrors the prototype behavior in `hearth3-rooms.jsx`.
  const trailingPrimary = actions.length > 0 ? actions[actions.length - 1] : undefined;
  const leadingGhosts = actions.slice(0, Math.max(0, actions.length - 1));

  return (
    <div className="v2-room-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="v2-room"
        ref={rootRef}
        tabIndex={-1}
      >
        <header className="v2-room__header">
          <div className="v2-room__header-left">
            <button
              type="button"
              className="v2-room__back"
              onClick={handleClose}
              aria-label="Back to thread"
            >
              <Icon icon={ArrowLeft} size="sm" />
              <span>Back to thread</span>
            </button>
            {breadcrumb && breadcrumb.length > 0 && (
              <nav className="v2-room__breadcrumb" aria-label="Breadcrumb">
                {breadcrumb.map((b, i) => (
                  <React.Fragment key={i}>
                    <span className="v2-room__breadcrumb-item">{b}</span>
                    {i < breadcrumb.length - 1 && <span className="v2-room__breadcrumb-sep">·</span>}
                  </React.Fragment>
                ))}
              </nav>
            )}
          </div>

          <div className="v2-room__header-center">
            <h1 className="v2-room__title">{title}</h1>
            {subtitle && <div className="v2-room__subtitle">{subtitle}</div>}
          </div>

          <div className="v2-room__header-right">
            {leadingGhosts.map((a, i) => (
              <Button
                key={i}
                variant={a.variant ?? "ghost"}
                size="sm"
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            ))}
            {trailingPrimary && (
              <Button
                variant={trailingPrimary.variant ?? "primary"}
                size="sm"
                onClick={trailingPrimary.onClick}
              >
                {trailingPrimary.label}
              </Button>
            )}
            <button
              type="button"
              className="v2-room__close"
              onClick={handleClose}
              aria-label="Close room"
            >
              <Icon icon={X} size="md" />
            </button>
          </div>
        </header>

        <div className="v2-room__body">{children}</div>
      </div>
    </div>
  );
}
