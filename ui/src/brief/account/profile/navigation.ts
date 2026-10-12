import type { BriefShellPort } from "../../contracts";
import type { ProfileController } from "./controller";

const guarded = new WeakMap<BriefShellPort, ProfileController>();
/** Install at the shell host, not just the room: sidebar and account menu must share this port.
 * Other route sources (browser Back, voice/deep links) must use navigateAway before applying a route.
 */
export function guardProfileNavigation(
  shell: BriefShellPort,
  controller: ProfileController,
): BriefShellPort {
  const result: BriefShellPort = {
    ...shell,
    navigate(route) {
      if (shell.route.room === "profile" && route.room !== "profile") {
        void controller.navigateAway(() => shell.navigate(route));
      } else shell.navigate(route);
    },
  };
  guarded.set(result, controller);
  return result;
}
export const hasProfileNavigationGuard = (
  shell: BriefShellPort,
  controller: ProfileController,
) => guarded.get(shell) === controller;
