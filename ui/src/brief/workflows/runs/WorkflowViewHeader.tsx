import React from "react";
import { flushSync } from "react-dom";
import type { BriefShellPort } from "../../contracts";
import "./header.css";
let transition: ViewTransition | undefined;
/** Same native elements and bounds in Canvas/Runs; Context can reuse this in D-20. */
export function WorkflowViewHeader({
  shell,
  flowId,
  versionId,
  active,
  title,
  runAction,
  disabled = false,
  children,
}: {
  shell: BriefShellPort;
  flowId: string;
  versionId: string;
  active: "canvas" | "runs" | "context";
  title: React.ReactNode;
  runAction: React.ReactNode;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  function navigate(room: "workflow" | "workflow-runs" | "workflow-context") {
    const go = () =>
      shell.navigate({
        room,
        selection: { ...shell.route.selection, flowId, versionId },
      });
    if (
      document.startViewTransition &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      transition?.skipTransition();
      transition = document.startViewTransition(() => flushSync(go));
      void transition.finished.catch(() => {});
    } else go();
  }
  const tabs = [
    { id: "canvas", label: "Canvas", room: "workflow" },
    { id: "runs", label: "Runs", room: "workflow-runs" },
    { id: "context", label: "Context & rules", room: "workflow-context" },
  ] as const;
  return (
    <header className="brief-canvas-header brief-workflow-view-header">
      <div className="brief-canvas-heading">
        <div className="brief-canvas-name">{title}</div>
        {runAction}
      </div>
      <nav
        className="brief-workflow-view-tabs"
        aria-label="Workflow views"
        data-active={active}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={active === tab.id ? "page" : undefined}
            disabled={disabled}
            title={disabled ? "Save or discard your changes first" : undefined}
            onClick={() => {
              if (active !== tab.id) navigate(tab.room);
            }}
          >
            {tab.label}
          </button>
        ))}
        <span className="brief-workflow-view-underline" aria-hidden="true" />
      </nav>
      {children}
    </header>
  );
}
