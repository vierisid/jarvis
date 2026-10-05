import { registration as room0 } from "./today/registration";
import { registration as room1 } from "./workflows/registration";
import { registration as room2 } from "./workflow/registration";
import { registration as room3 } from "./workflow-preview/registration";
import { registration as room4 } from "./workflow-draft/registration";
import { registration as room5 } from "./workflow-runs/registration";
import { registration as room6 } from "./workflow-context/registration";
import { registration as room7 } from "./all-workflows/registration";
import { registration as room8 } from "./opportunities/registration";
import { registration as room9 } from "./needs-you/registration";
import { registration as room10 } from "./goals/registration";
import { registration as room11 } from "./completed-goals/registration";
import { registration as room12 } from "./memory/registration";
import { registration as room13 } from "./memory-detail/registration";
import { registration as room14 } from "./connected-workspace/registration";
import { registration as room15 } from "./authority/registration";
import { registration as room16 } from "./profile/registration";
import { registration as room17 } from "./settings/registration";
import { registration as room18 } from "./billing/registration";
import type { BriefRoomId, BriefRoomModule } from "../contracts";

/** Static imports: no runtime plugin discovery or dependency on another workstream. */
export const BRIEF_ROOMS = {
  "today": room0,
  "workflows": room1,
  "workflow": room2,
  "workflow-preview": room3,
  "workflow-draft": room4,
  "workflow-runs": room5,
  "workflow-context": room6,
  "all-workflows": room7,
  "opportunities": room8,
  "needs-you": room9,
  "goals": room10,
  "completed-goals": room11,
  "memory": room12,
  "memory-detail": room13,
  "connected-workspace": room14,
  "authority": room15,
  "profile": room16,
  "settings": room17,
  "billing": room18,
} satisfies Record<BriefRoomId, BriefRoomModule>;
