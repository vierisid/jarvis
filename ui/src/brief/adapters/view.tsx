import React from "react";
import type { ComponentType } from "react";
import type { BriefRoomProps, BriefShellPort, BriefViewPort } from "../contracts";

export function unavailableView<T>(reason: string): BriefViewPort<T> {
  return { source: "live", state: { status: "unsupported", reason } };
}

/** A room-local hook may later adapt existing readers or F contracts here. */
export function bindBriefView<T>(
  useView: (shell: BriefShellPort) => BriefViewPort<T>,
  Content: ComponentType<BriefRoomProps<T>>,
): ComponentType<{ shell: BriefShellPort }> {
  return function BoundBriefRoom({ shell }) {
    const view = useView(shell);
    const safeView = shell.mode === "live" && view.source === "fixture"
      ? unavailableView<T>("Preview data is not available in the live dashboard.")
      : view;
    return <Content shell={shell} view={safeView} />;
  };
}
