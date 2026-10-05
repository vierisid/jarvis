import type { BriefRoomModule } from "../../contracts";

// Room-local integration point. Its D task supplies Body without replacing the registry.
export const registration = { id: "today", title: "Today" } satisfies BriefRoomModule;
