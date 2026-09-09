import { createContext } from "react";

// The gate owns this until the shell mounts. A window event would be lost
// while onboarding is still visible or its status refresh is in flight.
export const WorkflowDraftContext = createContext<{
  prompt: string | null;
  consume: () => void;
}>({ prompt: null, consume: () => {} });
