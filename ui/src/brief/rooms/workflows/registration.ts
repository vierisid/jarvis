import type { BriefRoomModule } from "../../contracts";

// Room-local integration point. Its D task supplies Body without replacing the registry.
export const registration = { id: "workflows", title: "Workflows", legacyRoom: "workflows" } satisfies BriefRoomModule;
