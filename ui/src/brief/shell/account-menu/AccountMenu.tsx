import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CreditCard, Settings2, UserRound } from "lucide-react";
import { FloatingSurface } from "../../components/controls/Floating";
import { useBriefMotion, useBriefReducedMotion } from "../../motion";
import type { BriefRoomId, BriefShellPort } from "../../contracts";
import { briefHash } from "../../entry/route";
import { initials, planLabel, type BriefAccount } from "../navigation/model";

const ITEMS = [
  { room: "profile", label: "Profile", Icon: UserRound },
  { room: "settings", label: "Settings", Icon: Settings2 },
  { room: "billing", label: "Billing", Icon: CreditCard },
] as const;

function MenuContent({ open, rail, children }: { open: boolean; rail: boolean; children: React.ReactNode }) {
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => { setEntered(open); }, [open]);
  const ref = useBriefMotion<HTMLDivElement>({ opacity: entered ? 1 : 0,
    transform: entered ? "translate(0px, 0px)" : rail ? "translate(-6px, 0px)" : "translate(0px, 6px)" },
  { kind: "reveal", active: entered });
  return <div ref={ref} className="brief-menu__body brief-account-menu__body" inert={!open} aria-hidden={!open}>{children}</div>;
}

/** One account origin, including avatar/name/plan, in either sidebar width. */
export function AccountMenu({ shell, account, rail }: { shell: BriefShellPort; account: BriefAccount; rail: boolean }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const first = useRef<"first" | "last">("first");
  const typeahead = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const reduced = useBriefReducedMotion();
  const name = account.name?.trim() || "Your account";
  const plan = planLabel(account.plan);
  const routeKey = briefHash(shell.route);
  const choices = () => [...surface.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []];
  const show = (which: "first" | "last" = "first") => {
    first.current = which; typeahead.current = { text: "", at: 0 }; setPresent(true); setOpen(true);
    if (open) { const items = choices(); (which === "last" ? items.at(-1) : items[0])?.focus(); }
  };
  const close = (restore = true) => { setOpen(false); if (restore) anchor.current?.focus(); };
  useLayoutEffect(() => {
    // Reopening during the exit reuses the surface, so onReady need not run again.
    if (!open) return;
    const items = choices(); (first.current === "last" ? items.at(-1) : items[0])?.focus();
  }, [open]);
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => { setPresent(false); surface.current = null; }, reduced ? 0 : 160);
    return () => clearTimeout(timer);
  }, [open, reduced]);
  // Browser Back, deep links and future voice navigation also dismiss the menu.
  useEffect(() => { if (open) close(surface.current?.contains(document.activeElement) ?? false); }, [routeKey]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !surface.current?.contains(target)) close(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") close(); // Return to origin, then let the browser move naturally.
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  function select(room: BriefRoomId) {
    close();
    if (shell.route.room !== room) shell.navigate({ room, selection: {} });
  }
  return <>
    <button ref={anchor} type="button" className="brief-account-origin" aria-label={`${name}, ${plan}. Account menu`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={present ? id : undefined}
      onClick={() => open ? close() : show()} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(event.key === "ArrowUp" ? "last" : "first"); }
      }}>
      <span className="brief-account-avatar" aria-hidden="true">{initials(account.name)}</span>
      <span className="brief-account-copy" aria-hidden={rail}><strong>{name}</strong><span title={plan}>{plan}</span></span>
    </button>
    {present && <FloatingSurface anchor={anchor} kind="menu" placement={rail ? "right-end" : "top-start"}
      className="brief-account-menu" onReady={element => {
        surface.current = element;
        if (!element.contains(document.activeElement)) {
          const items = choices(); (first.current === "last" ? items.at(-1) : items[0])?.focus();
        }
      }}>
      <MenuContent open={open} rail={rail}>
        <div role="menu" aria-label="Account" id={id} onKeyDown={event => {
          const items = choices(), current = items.indexOf(document.activeElement as HTMLButtonElement);
          let next = current;
          if (event.key === "ArrowDown") next = (current + 1) % items.length;
          else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = items.length - 1;
          else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
            const now = Date.now(); typeahead.current = { text: (now - typeahead.current.at > 500 ? "" : typeahead.current.text) + event.key.toLowerCase(), at: now };
            next = items.findIndex(item => item.textContent?.toLowerCase().startsWith(typeahead.current.text));
          } else return;
          event.preventDefault(); items[next]?.focus();
        }}>
          {ITEMS.map(({ room, label, Icon }) => <button key={room} type="button" role="menuitem" tabIndex={-1}
            aria-current={shell.route.room === room ? "page" : undefined} onClick={() => select(room)}>
            <Icon size={16} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span>
          </button>)}
        </div>
      </MenuContent>
    </FloatingSurface>}
  </>;
}
