/**
 * Which "add a device" section the Devices tab shows, and what it says when the
 * list is empty.
 *
 * The two installs add devices in opposite directions, and showing the wrong
 * one is worse than showing nothing:
 *
 *  - SELF-HOSTED: the dashboard mints a long-lived enrollment JWT, displays it
 *    once, and the user carries it to the new machine (`jarvis --token <jwt>`).
 *    Not their only route -- docs/SELF_HOSTING.md calls `jarvis enroll <name>`
 *    on the brain host the primary one -- but it is the only route the
 *    dashboard offers, so it must keep working here.
 *  - HOSTED: the device enrolls ITSELF. Install Jarvis there, sign in, and the
 *    control plane runs `jarvis enroll` over SSH. There is no token to copy:
 *    the JWT goes to the sidecar over the handshake nonce and never through
 *    page JS. The daemon refuses the mint route with a 403 -- both because the
 *    instructions would be wrong and because that route is the one place a
 *    panel-session cookie could become a permanent credential.
 *
 * Derived from `hosted_install`, which the daemon sets to `isHostedInstall`,
 * THE SAME PREDICATE the route's guard uses. Not `hosted_llm`, which is the
 * narrower "is the hosted LLM available" and is false on a hosted deployment
 * with no LLM proxy configured -- exactly where the server still refuses. A UI
 * gated on the narrow signal would offer a button the daemon 403s.
 */
export type AddDeviceMode = "unknown" | "hosted" | "self-hosted";

/**
 * The hook holds `llm` as `LLMConfig | null` and starts it at null, so null is
 * "not loaded yet" -- a THIRD answer rather than a default to either side.
 * Rendering the self-hosted form for a beat -- telling a hosted user to copy a
 * token, then swapping to "there is no token" -- is the confusion this whole
 * change removes, in miniature.
 *
 * Unknown is also reachable after loading finishes: the settings fetch resolves
 * null on any non-2xx, and the room mounts this tab anyway. That is why the
 * caller must render something for it rather than nothing.
 */
export function addDeviceMode(
  llm: { hosted_install?: boolean } | null | undefined,
): AddDeviceMode {
  if (llm === null || llm === undefined) return "unknown";
  // Strict boolean: the field crosses the wire as JSON, and anything other than
  // a real `true` means a daemon whose shape changed. Falling back to the form
  // is the safe direction -- the server still gates it.
  return llm.hosted_install === true ? "hosted" : "self-hosted";
}

/**
 * What the enrolled list says when it is empty.
 *
 * "Enroll one above" is only true where there IS something above: on hosted the
 * section above says to install and sign in, and on an unresolved install there
 * is no section at all. Pointing a user at a control that is not on their
 * screen is the same category of wrong as the button this change removes.
 */
export function noDevicesCopy(mode: AddDeviceMode): string {
  switch (mode) {
    case "hosted":
      return "No devices yet. Install Jarvis on a device and sign in — it appears here.";
    case "self-hosted":
      return "Enroll one above to get started.";
    case "unknown":
      return "No devices enrolled yet.";
  }
}
