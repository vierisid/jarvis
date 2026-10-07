import React, { useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import {
  UNKNOWN_NAVIGATION,
  type BriefNavigationBinding,
} from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { WorkflowCanvasRoom } from "../canvas/WorkflowCanvasRoom";
import { makeCanvasFixture } from "../canvas/fixtures";
import { WorkflowRunsRoom } from "./WorkflowRunsRoom";
import { WorkflowViewHeader } from "./WorkflowViewHeader";
import { BriefButton } from "../../components/controls";
import { makeRunsFixture, RUN_SCOPE, RUN_CAPABILITY } from "./fixtures";
import "../../today/preview/specimen.css";
export function WorkflowRunsSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0),
    [mode, setMode] = useState("normal");
  const [route, setRoute] = useState<BriefRoute>({
    room: "workflow-runs",
    selection: {
      flowId: RUN_SCOPE.flowId,
      versionId: RUN_SCOPE.versionId,
      runId: "meeting-run-012",
    },
  });
  const fixture = useMemo(() => makeRunsFixture(), [revision]),
    canvas = useMemo(() => makeCanvasFixture(), [revision]);
  const shell = useMemo<BriefShellPort>(
    () => ({
      mode: "preview",
      theme,
      setTheme,
      sidebar,
      setSidebar,
      chatOpen,
      setChatOpen,
      route,
      navigate: setRoute,
    }),
    [theme, setTheme, sidebar, chatOpen, route],
  );
  const binding = {
    ...RUN_SCOPE,
    source: "fixture" as const,
    title: "Meeting follow-ups",
    capabilities: RUN_CAPABILITY,
    controller: fixture.controller,
  };
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
          objectTitle: "Meeting follow-ups",
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
        <span>D-19 · Run history</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Run history example"
            value={mode}
            onChange={(e) => {
              const value = e.target.value;
              setMode(value);
              fixture.setMode(value as Parameters<typeof fixture.setMode>[0]);
              void fixture.controller.refresh();
            }}
          >
            <option value="normal">Normal</option>
            <option value="slow">Slow detail responses</option>
            <option value="unavailable">Unavailable</option>
            <option value="empty">Empty history</option>
            <option value="uncertain-command">Unconfirmed run request</option>
          </select>
        </label>
        <button
          onClick={() => {
            fixture.controller.retire();
            setRevision((v) => v + 1);
            setMode("normal");
            setRoute({
              room: "workflow-runs",
              selection: {
                flowId: RUN_SCOPE.flowId,
                versionId: RUN_SCOPE.versionId,
                runId: "meeting-run-012",
              },
            });
          }}
        >
          Reset example
        </button>
        <small>
          Illustrative runs. No workflow executes and no external action is
          sent.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          binding={nav}
          rooms={{
            "workflow-runs": { id: "workflow-runs", title: "Workflows" },
            workflow: { id: "workflow", title: "Workflows" },
            "workflow-context": { id: "workflow-context", title: "Workflows" },
          }}
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
                    scopeId: "runs-preview-chat",
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
          {route.room === "workflow-runs" ? (
            <WorkflowRunsRoom key={revision} shell={shell} binding={binding} />
          ) : route.room === "workflow" ? (
            <WorkflowCanvasRoom
              shell={shell}
              binding={{
                ...RUN_SCOPE,
                source: "fixture",
                capabilities: RUN_CAPABILITY,
                request: canvas.request,
              }}
            />
          ) : (
            <section className="brief-workflow-runs">
              <WorkflowViewHeader
                shell={shell}
                {...RUN_SCOPE}
                active="context"
                title={<h1>Meeting follow-ups</h1>}
                runAction={
                  <BriefButton variant="primary" disabled>
                    Run workflow
                  </BriefButton>
                }
              />
              <p style={{ padding: 32 }}>
                Context &amp; rules remains with D-20. This preview verifies its
                shared header and return path.
              </p>
            </section>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
