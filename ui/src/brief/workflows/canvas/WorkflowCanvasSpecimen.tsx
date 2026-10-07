import React, { useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import {
  UNKNOWN_NAVIGATION,
  type BriefNavigationBinding,
} from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { BriefButton } from "../../components/controls";
import { WorkflowCanvasRoom } from "./WorkflowCanvasRoom";
import { makeCanvasFixture } from "./fixtures";
import "../../today/preview/specimen.css";
export function WorkflowCanvasSpecimen() {
  const [advanced, setAdvanced] = useState(false),
    [revision, setRevision] = useState(0),
    [chatOpen, setChatOpen] = useState(false),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [theme, setTheme] = useTheme(),
    [draft, setDraft] = useState("");
  const [route, setRoute] = useState<BriefRoute>({
    room: "workflow",
    selection: { flowId: "meeting" },
  });
  const fixture = useMemo(
    () => makeCanvasFixture(advanced),
    [advanced, revision],
  );
  const shell = useMemo<BriefShellPort>(
    () => ({
      mode: "preview",
      route,
      sidebar,
      setSidebar,
      chatOpen,
      setChatOpen,
      theme,
      setTheme,
      navigate: setRoute,
    }),
    [route, sidebar, chatOpen, theme, setTheme],
  );
  const nav: BriefNavigationBinding = {
    capabilities: null,
    view: {
      source: "fixture",
      state: {
        status: "ready",
        data: {
          ...UNKNOWN_NAVIGATION,
          workspaceName: "Vieri’s workspace",
          connection: "connected",
          account: {
            name: "Vieri Balboni",
            plan: { status: "ready", data: "Pro plan" },
          },
          objectTitle: advanced
            ? "Meeting follow-ups · branches and loops"
            : "Meeting follow-ups",
          badges: { workflows: 4 },
        },
      },
    },
  };
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-18 · Workflow canvas</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => {
              setAdvanced(e.target.checked);
              setRoute({ room: "workflow", selection: { flowId: "meeting" } });
            }}
          />
          Branches, loops & disconnected nodes
        </label>
        <button onClick={() => setRevision((x) => x + 1)}>Reset example</button>
        <small>
          Illustrative data. Save stays in memory; Run cannot execute work.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          binding={nav}
          rooms={{ workflow: { id: "workflow", title: "Workflows" } }}
          conversation={{
            source: "fixture",
            content: (
              <>
                <div className="sample-conversation-tabs">General</div>
                <div className="sample-conversation-thread">
                  <h2 className="brief-type-section-heading">
                    What are we moving forward?
                  </h2>
                </div>
                <ConversationComposer
                  mode="preview"
                  binding={{
                    source: "fixture",
                    scopeId: "canvas-preview-chat",
                    conversationId: "general",
                    mode: "scoped",
                    connected: true,
                    metadataPending: false,
                    draft,
                    turn: null,
                    pendingAcceptance: false,
                    error: null,
                    actions: {
                      setDraft,
                      send: () => setDraft(""),
                      cancel: () => {},
                    },
                  }}
                />
              </>
            ),
          }}
        >
          {route.room === "workflow" ? (
            <WorkflowCanvasRoom
              key={revision}
              shell={shell}
              binding={{
                source: "fixture",
                scopeId: "canvas-review",
                flowId: "meeting",
                versionId: fixture.versionId,
                capabilities: {
                  contractVersion: 1,
                  capabilities: {
                    workflowContext: {
                      supported: true,
                      ready: true,
                      enabled: true,
                      state: "ready",
                      reason: null,
                    },
                  },
                },
                request: fixture.request,
                run: async () => ({
                  ok: true,
                  message: "Illustrative run selected. No workflow executed.",
                }),
              }}
            />
          ) : (
            <section>
              <h1 className="brief-type-room-title">
                {route.room === "workflow-runs"
                  ? "Runs"
                  : route.room === "workflow-context"
                    ? "Context & rules"
                    : "Workflows"}
              </h1>
              <p>
                Destination handoff. This step implements the canvas; this room
                remains with its roadmap owner.
              </p>
              <BriefButton
                onClick={() =>
                  setRoute({
                    room: "workflow",
                    selection: { flowId: "meeting" },
                  })
                }
              >
                Back to canvas
              </BriefButton>
            </section>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
