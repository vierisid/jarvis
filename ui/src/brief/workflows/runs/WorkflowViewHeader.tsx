import React from "react";
import type { BriefShellPort } from "../../contracts";
import "./header.css";
/** Same native elements and bounds in Canvas/Runs; Context can reuse this in D-20.
 * Switching views is an immediate room navigation: a document-wide View Transition
 * would need unscoped `::view-transition-*` rules that reach the released dashboard. */
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
    shell.navigate({
      room,
      selection: { ...shell.route.selection, flowId, versionId },
    });
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
