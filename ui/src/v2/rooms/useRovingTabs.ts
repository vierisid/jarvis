import { useCallback, useEffect, useRef } from "react";

/**
 * WAI-ARIA tabs pattern with roving tabindex + automatic activation
 * (Phase 7 Pass B).
 *
 * Each room's main view tabs and any sub-tab strips can wire this up
 * with one hook call and one ref instead of repeating the same id
 * string composition, tabindex juggling, and arrow-key handler in
 * every component. Settings Room got the full pattern by hand in
 * Pass A; this hook generalises that shape.
 *
 * Usage:
 *   const tabs = useRovingTabs(["overview","timeline"], activeTab, setActiveTab, "goals");
 *   <div ref={tabs.tablistRef} role="tablist" aria-label="Goals view">
 *     {ALL_TABS.map(t => (
 *       <button key={t} {...tabs.getTabProps(t)}>...</button>
 *     ))}
 *   </div>
 *   <div {...tabs.getPanelProps()}>...</div>
 *
 * Behaviour:
 *   - Active tab gets `tabIndex=0`; others `tabIndex=-1` (roving).
 *   - ←/→ moves focus to the prev/next tab AND activates it
 *     (automatic activation per WAI-ARIA tabs pattern). Wraps.
 *   - Home/End jump to first/last tab.
 *   - Tab key escapes the tablist into the tabpanel (default browser
 *     behaviour given the roving tabindex).
 */
export interface RovingTabsApi<T extends string> {
  tablistRef: React.RefObject<HTMLDivElement | null>;
  getTabProps: (key: T) => {
    id: string;
    role: "tab";
    "aria-selected": boolean;
    "aria-controls": string;
    tabIndex: 0 | -1;
    onClick: () => void;
    "data-roving-tab": T;
  };
  getPanelProps: () => {
    id: string;
    role: "tabpanel";
    "aria-labelledby": string;
  };
}

export function useRovingTabs<T extends string>(
  tabs: readonly T[],
  activeTab: T,
  setActiveTab: (next: T) => void,
  idPrefix: string,
): RovingTabsApi<T> {
  const tablistRef = useRef<HTMLDivElement | null>(null);

  // Latest props — refs so the keydown handler doesn't have to be
  // re-bound on every state change.
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeTab);
  const setActiveRef = useRef(setActiveTab);
  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = activeTab;
    setActiveRef.current = setActiveTab;
  }, [tabs, activeTab, setActiveTab]);

  useEffect(() => {
    const root = tablistRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.getAttribute("role") !== "tab") return;
      const all = tabsRef.current;
      const cur = target.getAttribute("data-roving-tab") as T | null;
      const i = cur ? all.indexOf(cur) : -1;
      if (i === -1) return;

      let nextIdx = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        nextIdx = (i + 1) % all.length;
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        nextIdx = (i - 1 + all.length) % all.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = all.length - 1;
      } else {
        return;
      }
      e.preventDefault();
      const nextKey = all[nextIdx]!;
      setActiveRef.current(nextKey);
      // Focus the new tab on the next frame so the re-render with the
      // updated roving tabindex has run before we move focus.
      requestAnimationFrame(() => {
        const next = root.querySelector<HTMLElement>(
          `[data-roving-tab="${nextKey}"]`,
        );
        next?.focus();
      });
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, []);

  const getTabProps = useCallback(
    (key: T) => ({
      id: `${idPrefix}-tab-${key}`,
      role: "tab" as const,
      "aria-selected": activeTab === key,
      "aria-controls": `${idPrefix}-tabpanel-${key}`,
      tabIndex: (activeTab === key ? 0 : -1) as 0 | -1,
      onClick: () => setActiveTab(key),
      "data-roving-tab": key,
    }),
    [activeTab, idPrefix, setActiveTab],
  );

  const getPanelProps = useCallback(
    () => ({
      id: `${idPrefix}-tabpanel-${activeTab}`,
      role: "tabpanel" as const,
      "aria-labelledby": `${idPrefix}-tab-${activeTab}`,
    }),
    [activeTab, idPrefix],
  );

  return { tablistRef, getTabProps, getPanelProps };
}
