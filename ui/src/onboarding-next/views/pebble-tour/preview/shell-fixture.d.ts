declare module "on-u-06-shell-fixture" {
  import type { ComponentType, ReactNode } from "react";
  export const available: boolean;
  export const BriefBrand: ComponentType;
  export const PebbleLayout: ComponentType<{
    shell: { mode: "preview"; chatOpen: boolean; setChatOpen: (open: boolean) => void };
    enabled: boolean; reducedMotion?: boolean;
    conversation: { source: "fixture"; content: ReactNode }; children: ReactNode;
  }>;
}
