import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HTMLAttributes, ReactElement, ReactNode, RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { BriefButton } from "./Buttons";

/** Portals escape clipping; native popovers also escape other stacking contexts.
 * The portal explicitly follows the invoking Brief root's chosen appearance. */
export function FloatingSurface({ anchor, kind, children, onReady, placement, className = "", ...props }:
  HTMLAttributes<HTMLDivElement> & { anchor: RefObject<HTMLElement | null>; kind: "menu" | "tooltip";
    placement?: "top-start" | "right-end" | "right";
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
      const desiredLeft = placement === "top-start" ? rect.left
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
    <div {...props} data-placement={placement} ref={surface} popover="manual" className={`brief-floating brief-floating--${kind} ${className}`}
      style={{ left: position.left, top: position.top }}>{children}</div>
  </div>, document.body);
}

export function BriefTooltip({ label, children, placement, disabled = false }: { label: string; children: ReactElement<HTMLAttributes<HTMLElement>>; placement?: "right"; disabled?: boolean }) {
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
      if (event.key === "Escape") { suppressed.current = true; close(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  return <span ref={anchor} className="brief-tooltip-anchor"
    onPointerEnter={event => {
      hovering.current = true;
      if (disabled || event.pointerType === "touch" || suppressed.current) return;
      clear(); timer.current = setTimeout(() => setOpen(true), 500);
    }} onPointerLeave={leave}
    onFocus={() => { clear(); focused.current = true; suppressed.current = false; if (!disabled) setOpen(true); }}
    onBlur={() => { focused.current = false; if (!hovering.current) { suppressed.current = false; close(); } }}
    onClickCapture={() => { suppressed.current = true; close(); }}>
    {cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], open && !disabled ? id : null].filter(Boolean).join(" ") || undefined })}
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
  onSelect: () => void;
}
export function BriefMenu({ label, items }: { label: string; items: readonly BriefMenuItem[] }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const initial = useRef<"first" | "last">("first");
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const trigger = () => anchor.current?.querySelector<HTMLButtonElement>("button");
  const close = (restore: boolean) => { setOpen(false); if (restore) trigger()?.focus(); };
  const options = () => [...menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menu.current?.contains(target)) close(false);
    };
    const focus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menu.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focus); };
  }, [open]);
  return <span ref={anchor} className="brief-menu-anchor">
    <BriefButton variant="secondary" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      icon={<ChevronDown size={16} />} onClick={() => { initial.current = "first"; setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); initial.current = event.key === "ArrowUp" ? "last" : "first"; setOpen(true);
        } else if (event.key === "Escape" && open) { event.preventDefault(); close(true); }
      }}>{label}</BriefButton>
    {open && <FloatingSurface anchor={anchor} kind="menu" onReady={element => {
      menu.current = element;
      typeahead.current = { text: "", at: 0 };
      const rows = options(); (initial.current === "last" ? rows.at(-1) : rows[0])?.focus();
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
      <div role="menu" id={id} aria-label={label} className="brief-menu__body">
        {items.map(item => <button type="button" role="menuitem" key={item.id} tabIndex={-1} disabled={item.disabled}
          data-intent={item.destructive ? "destructive" : undefined} onClick={() => { close(true); item.onSelect(); }}>
          <span className="brief-menu__icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
        </button>)}
      </div>
    </FloatingSurface>}
  </span>;
}
