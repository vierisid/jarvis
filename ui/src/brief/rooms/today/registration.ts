import type { BriefRoomModule } from "../../contracts";
import { TodayLayout } from "../../today/layout/TodayLayout";
import { createElement } from "react";

// Room-local integration point. Its D task supplies Body without replacing the registry.
export const registration = { id: "today", title: "Today" } satisfies BriefRoomModule;

/** Call once at composition, using the existing subscribed view owner. No new reads here.
 * F-12 supplies decisions; D-09/10/11 supply slots; F-25/D-33 activate the room. */
export function createTodayRoom(useToday: () => Omit<Parameters<typeof TodayLayout>[0], "shell">): BriefRoomModule {
  return { ...registration, Body: function TodayRoom({ shell }) {
    return createElement(TodayLayout, { ...useToday(), shell });
  } };
}
