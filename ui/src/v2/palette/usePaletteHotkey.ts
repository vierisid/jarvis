import { useEffect } from "react";

/**
 * Global ⌘K (mac) / Ctrl+K (win/linux) listener. `preventDefault` on the
 * keydown so the browser doesn't focus its address bar.
 */
export function usePaletteHotkey(onOpen: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
