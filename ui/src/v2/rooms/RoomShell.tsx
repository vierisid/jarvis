import React, { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, X } from "lucide-react";
import { Button, Icon } from "../ui";
import { closeRoom, type RoomKey } from "../router";
import { composeBreadcrumb, useRoomEntry } from "./roomEntryStore";
import "./RoomShell.css";

const ROOM_KEYS = new Set<RoomKey>([
  "workflows",
  "memory",
  "tools",
  "agents",
  "authority",
  "logs",
  "calendar",
  "goals",
  "tasks",
  "content",
  "workspaces",
  "settings",
]);

function readRoomKeyFromHash(): RoomKey | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash.startsWith("_room_")) return null;
  const key = hash.slice("_room_".length);
  return ROOM_KEYS.has(key as RoomKey) ? (key as RoomKey) : null;
}

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

  // Phase 6.8 — derive a contextual breadcrumb prefix from the entry
  // store so the user can see how they got here (Palette · Tasks vs
  // Thread · Q3 launch · Tasks vs Voice · Tasks). Falls back to the
  // explicit `breadcrumb` prop if no entry record is found, so legacy
  // direct-mount callers (and the primitives showcase) still work.
  const roomKey = useMemo(readRoomKeyFromHash, []);
  const entry = useRoomEntry(roomKey ?? ("tools" as RoomKey));
  const effectiveBreadcrumb = useMemo(() => {
    // If the caller passed an explicit breadcrumb, treat the LAST item
    // as the room's display name (e.g. ["Workflows"] → "Workflows") and
    // compose the entry prefix in front of it. If they passed multi-
    // segment crumbs, preserve those after the prefix.
    if (!roomKey) return breadcrumb ?? [];
    const tail = breadcrumb && breadcrumb.length > 0 ? breadcrumb : [title];
    if (!entry || entry.source === "direct") return tail;
    const composed = composeBreadcrumb(entry, tail[tail.length - 1]!);
    // composed already includes the room name; preserve any extra
    // tail segments the caller passed (rare, but possible).
    if (tail.length > 1) {
      return [...composed.slice(0, -1), ...tail];
    }
    return composed;
  }, [breadcrumb, entry, roomKey, title]);

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

  // Phase 6.8 — focus trap. Without this, Tab inside an open Room
  // overlay can land on elements in the rail/header behind the
  // overlay (since the overlay doesn't `inert` the underlying tree).
  // Trap cycles forward at the last focusable, backward at the first.
  // Only the Room's own focusable elements are in scope.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // Standard CSS selector for "things that can accept focus" — same
      // shape as react-focus-lock's matcher; good enough for our shell.
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
          ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      // If focus is currently outside the Room (e.g. it bled into the
      // rail behind), pull it back to the appropriate edge.
      if (!active || !root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
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
            {effectiveBreadcrumb.length > 0 && (
              <nav className="v2-room__breadcrumb" aria-label="Breadcrumb">
                {effectiveBreadcrumb.map((b, i) => (
                  <React.Fragment key={i}>
                    <span
                      className="v2-room__breadcrumb-item"
                      data-segment={i === 0 ? "source" : i === effectiveBreadcrumb.length - 1 ? "room" : "context"}
                    >
                      {b}
                    </span>
                    {i < effectiveBreadcrumb.length - 1 && <span className="v2-room__breadcrumb-sep">·</span>}
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
