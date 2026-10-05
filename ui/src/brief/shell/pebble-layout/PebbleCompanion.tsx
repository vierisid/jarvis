import React, { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A single room-owned companion. Its portal target never changes during reflow. */
export const CompanionContext = createContext<{ target: HTMLElement | null; setPresent: (present: boolean) => void }>({ target: null, setPresent: () => {} });
export function PebbleCompanion({ children, closedTop = 132 }: { children: ReactNode; closedTop?: number }) {
  const { target, setPresent } = useContext(CompanionContext);
  const present = children !== null && children !== undefined && children !== false;
  useLayoutEffect(() => { setPresent(present); return () => setPresent(false); }, [present, setPresent]);
  useLayoutEffect(() => {
    target?.style.setProperty("--pebble-companion-closed-top", `${closedTop}px`);
    return () => { target?.style.removeProperty("--pebble-companion-closed-top"); };
  }, [target, closedTop]);
  return target && present ? createPortal(children, target) : null;
}
