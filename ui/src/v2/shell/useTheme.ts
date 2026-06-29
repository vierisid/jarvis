import { useCallback, useEffect, useState } from "react";

/**
 * Light/dark is set as `data-theme` on <html> (bootstrapped in index.html
 * before paint). This hook reads + flips it and persists to localStorage,
 * so the top-bar toggle and any Settings control stay in sync. Both themes
 * are first-class — neither is a default.
 */
export type Theme = "light" | "dark";
const KEY = "jarvis-theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
}

export function useTheme(): [Theme, (next?: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  // Re-sync on mount in case the bootstrap resolved a different value.
  useEffect(() => { setTheme(currentTheme()); }, []);

  const set = useCallback((next?: Theme) => {
    setTheme((prev) => {
      const t = next ?? (prev === "dark" ? "light" : "dark");
      applyTheme(t);
      return t;
    });
  }, []);

  return [theme, set];
}
