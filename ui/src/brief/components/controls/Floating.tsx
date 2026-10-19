import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { BriefButton } from "./Buttons";
import { BRIEF_MOTION, useBriefMotion, useBriefReducedMotion } from "../../motion";

/** Default: menus open below and end-align, tooltips prefer above. `top-start` sits above and
 * start-aligned, `bottom-start` below and start-aligned; `right`/`right-end` sit beside a rail target. */
export type BriefFloatingPlacement = "top-start" | "bottom-start" | "right-end" | "right";

/** Portals escape clipping; native popovers also escape other stacking contexts.
 * The portal explicitly follows the invoking Brief root's chosen appearance. */
export function FloatingSurface({ anchor, kind, children, onReady, placement, className, ...props }:
  HTMLAttributes<HTMLDivElement> & { anchor: RefObject<HTMLElement | null>; kind: "menu" | "tooltip";
    placement?: BriefFloatingPlacement;
    children: ReactNode; onReady?: (element: HTMLDivElement) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState("light");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const target = anchor.current, element = surface.current;
    if (!target || !element) return;
    const root = target.closest<HTMLElement>(".brief-root");
    const readTheme = () => setTheme(root?.dataset.briefTheme ?? document.documentElement.dataset.theme ?? "light");
    readTheme();
    const observer = new MutationObserver(readTheme);
    if (root) observer.observe(root, { attributes: true, attributeFilter: ["data-brief-theme"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Chromium/WebView uses the top layer. The body portal is a usable fallback
    // in test DOMs and older hosts without the Popover API.
    element.showPopover?.();
    const place = () => {
      const rect = target.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const padding = 8;
      const below = rect.bottom;
      const above = rect.top - box.height;
      const preferAbove = kind === "tooltip";
      const top = preferAbove && above >= padding ? above
        : below + box.height <= window.innerHeight - padding ? below : Math.max(padding, above);
      const desiredLeft = (placement === "top-start" || placement === "bottom-start") ? rect.left
        : placement === "right" ? rect.right : placement === "right-end" ? rect.right + 24 : rect.right - box.width;
      const desiredTop = placement === "top-start" ? above
        : placement === "right-end" ? rect.bottom - box.height
        : placement === "right" ? rect.top + (rect.height - box.height) / 2 : top;
      setPosition({
        left: Math.max(padding, Math.min(desiredLeft, window.innerWidth - box.width - padding)),
        top: Math.max(padding, Math.min(desiredTop, window.innerHeight - box.height - padding)),
      });
    };
    place();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(element); resize?.observe(target);
    const composer = target.closest(".brief-composer-surface");
    if (composer) resize?.observe(composer);
    const workspace = target.closest(".brief-workspace-content");
    if (composer && workspace) resize?.observe(workspace);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onReady?.(element);
    return () => {
      observer.disconnect(); resize?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, kind, placement]);
  return createPortal(<div className="brief-root brief-control-layer" data-brief-theme={theme}>
    <div {...props} data-placement={placement} ref={surface} popover="manual" className={["brief-floating", `brief-floating--${kind}`, className].filter(Boolean).join(" ")}
      style={{ left: position.left, top: position.top }}>{children}</div>
  </div>, document.body);
}

export function BriefTooltip({ label, children, placement, disabled = false, delay = 500 }: { label: string; children: ReactElement<HTMLAttributes<HTMLElement>>; placement?: "right"; disabled?: boolean; delay?: number }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressed = useRef(false);
  const focused = useRef(false);
  const hovering = useRef(false);
  const [open, setOpen] = useState(false);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const close = () => { clear(); setOpen(false); };
  const leave = () => {
    clear(); hovering.current = false;
    if (focused.current) return;
    suppressed.current = false;
    timer.current = setTimeout(() => setOpen(false), 80);
  };
  useEffect(() => () => clear(), []);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Dismiss the topmost hint before the containing panel sees Escape.
        event.preventDefault(); event.stopPropagation();
        suppressed.current = true; close();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [open]);
  return <span ref={anchor} className="brief-tooltip-anchor"
    onPointerEnter={event => {
      hovering.current = true;
      if (disabled || event.pointerType === "touch" || suppressed.current) return;
      clear(); timer.current = setTimeout(() => setOpen(true), delay);
    }} onPointerLeave={leave}
    onFocus={() => { clear(); focused.current = true; suppressed.current = false; if (!disabled) setOpen(true); }}
    onBlur={() => { focused.current = false; if (!hovering.current) { suppressed.current = false; close(); } }}
    onClickCapture={() => { suppressed.current = true; close(); }}>
    {/* A tooltip that repeats the accessible name would be announced twice. */}
    {cloneElement(children, { "aria-describedby": [children.props["aria-describedby"],
      open && !disabled && children.props["aria-label"] !== label ? id : null].filter(Boolean).join(" ") || undefined })}
    {open && !disabled && <FloatingSurface anchor={anchor} kind="tooltip" placement={placement} onPointerEnter={() => { clear(); hovering.current = true; }} onPointerLeave={leave}>
      <span role="tooltip" id={id} className="brief-tooltip__body">{label}</span>
    </FloatingSurface>}
  </span>;
}

export interface BriefMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  /** Marks the item that names the current page (aria-current="page"). */
  current?: boolean;
  onSelect: () => void;
}
/** Props a custom trigger must spread onto its single native button. */
export interface BriefMenuTriggerProps {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls"?: string;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}
export interface BriefMenuProps {
  label: string;
  items: readonly BriefMenuItem[];
  /** Renders the trigger; defaults to a secondary BriefButton showing `label`. */
  trigger?: (props: BriefMenuTriggerProps) => ReactElement;
  placement?: BriefFloatingPlacement;
  className?: string;
  /** A change (for example the current route) dismisses an open menu. */
  dismissKey?: string;
  /** D-04 reveal on open and close; the surface stays mounted through the exit. */
  reveal?: "up" | "left";
}

function MenuReveal({ open, from, children }: { open: boolean; from: "up" | "left"; children: ReactNode }) {
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => { setEntered(open); }, [open]);
  const ref = useBriefMotion<HTMLDivElement>({ opacity: entered ? 1 : 0,
    transform: entered ? "translate(0px, 0px)" : from === "left" ? "translate(-6px, 0px)" : "translate(0px, 6px)" },
  { kind: "reveal", active: entered });
  // Semantic state changes immediately; only the visual exit waits.
  return <div ref={ref} inert={!open} aria-hidden={open ? undefined : true}>{children}</div>;
}

export function BriefMenu({ label, items, trigger, placement, className, dismissKey, reveal }: BriefMenuProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const initial = useRef<"first" | "last">("first");
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const reduced = useBriefReducedMotion();
  const triggerButton = () => anchor.current?.querySelector<HTMLButtonElement>("button");
  const close = (restore: boolean) => { setOpen(false); if (restore) triggerButton()?.focus(); };
  const options = () => [...menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const focusInitial = () => { const rows = options(); (initial.current === "last" ? rows.at(-1) : rows[0])?.focus(); };
  const show = (which: "first" | "last") => {
    initial.current = which; typeahead.current = { text: "", at: 0 };
    if (reveal) setPresent(true);
    setOpen(true);
    if (open) focusInitial();
  };
  // Reopening during a reveal exit reuses the mounted surface, so onReady does not run again.
  useLayoutEffect(() => { if (open && menu.current?.isConnected) focusInitial(); }, [open]);
  useEffect(() => {
    if (open || !present || !reveal) return;
    const timer = setTimeout(() => { setPresent(false); menu.current = null; }, reduced ? 0 : BRIEF_MOTION.reveal.exit);
    return () => clearTimeout(timer);
  }, [open, present, reveal, reduced]);
  const dismissed = useRef(dismissKey);
  useEffect(() => {
    if (dismissed.current === dismissKey) return;
    dismissed.current = dismissKey;
    if (open) close(menu.current?.contains(document.activeElement) ?? false);
  }, [dismissKey]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menu.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  const triggerProps: BriefMenuTriggerProps = {
    "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": open ? id : undefined,
    onClick: () => { if (open) close(true); else show("first"); },
    onKeyDown: event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); show(event.key === "ArrowUp" ? "last" : "first");
      } else if (event.key === "Escape" && open) { event.preventDefault(); close(true); }
    },
  };
  const list = (
    <div role="menu" id={id} aria-label={label} className="brief-menu__body">
      {items.map(item => <button type="button" role="menuitem" key={item.id} tabIndex={-1} disabled={item.disabled}
        aria-current={item.current ? "page" : undefined}
        data-intent={item.destructive ? "destructive" : undefined} onClick={() => { close(true); item.onSelect(); }}>
        <span className="brief-menu__icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
      </button>)}
    </div>
  );
  return <span ref={anchor} className="brief-menu-anchor">
    {trigger ? trigger(triggerProps)
      : <BriefButton variant="secondary" icon={<ChevronDown size={16} />} {...triggerProps}>{label}</BriefButton>}
    {(open || (!!reveal && present)) && <FloatingSurface anchor={anchor} kind="menu" placement={placement} className={className} onReady={element => {
      menu.current = element;
      if (open && !element.contains(document.activeElement)) focusInitial();
    }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === "Tab") { close(true); return; }
      const rows = options();
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        const text = (now - typeahead.current.at < 500 ? typeahead.current.text : "") + event.key.toLowerCase();
        typeahead.current = { text, at: now };
        const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        ordered.find(row => row.textContent?.trim().toLowerCase().startsWith(text))?.focus();
      }
    }}>
      {reveal ? <MenuReveal open={open} from={reveal}>{list}</MenuReveal> : list}
    </FloatingSurface>}
  </span>;
}
