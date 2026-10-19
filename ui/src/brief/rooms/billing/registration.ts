import type { BriefRoomModule } from "../../contracts";
import { BillingWorkspace } from "../../account/billing/BillingWorkspace";

// D-31 has no feature prerequisite: this reuses the existing read-only hosted bridge.
// The opt-in Brief entry and default dashboard rollout remain unchanged.
export const registration = {
  id: "billing",
  title: "Billing",
  legacyRoom: "usage",
  Body: BillingWorkspace,
} satisfies BriefRoomModule;
