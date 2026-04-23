const STORAGE_KEY = "jarvis:ui-v2";

export function isV2Enabled(): boolean {
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const q = params.get("ui");
  if (q === "v2") {
    window.localStorage.setItem(STORAGE_KEY, "1");
    return true;
  }
  if (q === "v1") {
    window.localStorage.removeItem(STORAGE_KEY);
    return false;
  }

  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function disableV2(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  const url = new URL(window.location.href);
  url.searchParams.set("ui", "v1");
  window.location.href = url.toString();
}
