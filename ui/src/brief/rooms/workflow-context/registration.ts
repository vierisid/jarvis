import type { BriefRoomModule } from "../../contracts";

// Room-local integration point. Its D task supplies Body without replacing the registry.
export const registration = { id: "workflow-context", title: "Context & rules", legacyRoom: "workflows" } satisfies BriefRoomModule;
