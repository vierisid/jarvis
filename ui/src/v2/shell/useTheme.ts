import { useSyncExternalStore } from "react";

/** The bootstrapped root attribute is the single in-page theme source. */
export type Theme = "light" | "dark";
const KEY = "jarvis-theme";
const CHANGE = "jarvis-theme-change";
const valid = (value: unknown): value is Theme =>
  value === "light" || value === "dark";
function currentTheme(): Theme {
  return typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}
function systemTheme(): Theme {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
function setTheme(next?: Theme) {
  if (typeof document === "undefined") return;
  const theme = next ?? (currentTheme() === "dark" ? "light" : "dark");
  if (!valid(theme)) return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* In-memory appearance still works. */
  }
  window.dispatchEvent(new Event(CHANGE));
}
function subscribe(changed: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    let stored: string | null;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
      // Events may be queued behind a newer choice in this or another tab.
      stored = window.localStorage.getItem(KEY);
    } catch {
      // Keep the in-memory choice when storage is inaccessible.
      return;
    }
    // Storage removal/clear uses the same fallback as the before-paint bootstrap.
    document.documentElement.setAttribute(
      "data-theme",
      valid(stored) ? stored : systemTheme(),
    );
    changed();
  };
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window.addEventListener(CHANGE, changed);
  window.addEventListener("storage", storage);
  return () => {
    observer.disconnect();
    window.removeEventListener(CHANGE, changed);
    window.removeEventListener("storage", storage);
  };
}
/** Existing top-bar toggles and Brief selectors share this API and storage key. */
export function useTheme(): [Theme, (next?: Theme) => void] {
  return [
    useSyncExternalStore(subscribe, currentTheme, () => "light"),
    setTheme,
  ];
}
