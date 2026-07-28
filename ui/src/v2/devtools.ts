/**
 * Developer-tools gate. The design showcases (#/_kit, #/_states, #/_billing —
 * the latter renders fake invoice data) and the system-state localStorage
 * override can force non-real UI into the live shell, so they are opt-in:
 * there is no build-time dev flag in the Bun bundle, and a hostname check is
 * useless for a daemon that always serves on localhost.
 *
 * Enable from the browser console:  localStorage.setItem("jarvis-devtools", "1")
 */
export function isDevToolsEnabled(): boolean {
  try {
    return localStorage.getItem("jarvis-devtools") === "1";
  } catch {
    return false;
  }
}
