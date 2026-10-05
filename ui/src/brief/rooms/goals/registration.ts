import type { BriefRoomModule } from "../../contracts";

// Room-local integration point. Its D task supplies Body without replacing the registry.
export const registration = { id: "goals", title: "Goals", legacyRoom: "goals" } satisfies BriefRoomModule;
