import React, { useMemo, useState, useEffect } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import {
  UNKNOWN_NAVIGATION,
  type BriefNavigationBinding,
} from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { BriefButton } from "../../components/controls";
import { WorkflowManagementRoom } from "./WorkflowManagementRoom";
import {
  makeManagementFixture,
  MANAGEMENT_SCOPE,
  MANAGEMENT_CAPABILITY,
  MANAGEMENT_EXAMPLES,
  type ManagementExample,
} from "./fixtures";
import { WorkflowCreationRoom } from "../create/WorkflowCreationRoom";
import { WorkflowCreationController } from "../create/controller";
import { WorkflowCanvasRoom } from "../canvas/WorkflowCanvasRoom";
import { makeCanvasFixture } from "../canvas/fixtures";
import { RUN_CAPABILITY } from "../runs/fixtures";
import "../../today/preview/specimen.css";
export function WorkflowManagementSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<ManagementExample>("normal"),
    [revision, setRevision] = useState(0);
  const [route, setRoute] = useState<BriefRoute>({
    room: "all-workflows",
    selection: {},
  });
  const fixture = useMemo(
    () => makeManagementFixture(example, 300),
    [example, revision],
  );
  const canvas = useMemo(() => makeCanvasFixture(), [revision]);
  const creation = useMemo(() => {
    let saved: string | null = null;
    return new WorkflowCreationController(
      {
        submit: async () => {
          throw Error("Isolated list preview");
        },
        recover: async () => null,
        read: async () => {
          throw Error("Isolated list preview");
        },
      },
      {
        read: () => saved,
        write: (v) => {
          saved = v;
        },
      },
      { source: "fixture", scopeId: "management-create-preview" },
    );
  }, []);
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  useEffect(() => () => creation.dispose(), [creation]);
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
        <span>D-21 · Workflow management</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Workflow management example"
            value={example}
            onChange={(e) => {
              setExample(e.target.value as ManagementExample);
              setRoute({ room: "all-workflows", selection: {} });
            }}
          >
            {MANAGEMENT_EXAMPLES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            setRevision((n) => n + 1);
            setRoute({ room: "all-workflows", selection: {} });
          }}
        >
          Reset example
        </button>
        <small>
          Illustrative workflows only. Nothing is enabled, deleted or executed
          on your account.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          binding={nav}
          rooms={{
            "all-workflows": { id: "all-workflows", title: "All workflows" },
            workflows: { id: "workflows", title: "Workflows" },
            workflow: { id: "workflow", title: "Workflows" },
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
                    scopeId: "management-preview-chat",
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
          {route.room === "all-workflows" ? (
            <WorkflowManagementRoom
              shell={shell}
              binding={{
                source: "fixture",
                scopeId: MANAGEMENT_SCOPE,
                capabilities: MANAGEMENT_CAPABILITY,
                controller: fixture.controller,
              }}
            />
          ) : route.room === "workflows" ? (
            <WorkflowCreationRoom
              shell={shell}
              binding={{
                controller: creation,
                capabilities: null,
                recent: { source: "fixture", state: { status: "empty" } },
              }}
            />
          ) : (
            <div className="brief-management-destination">
              <BriefButton
                onClick={() =>
                  setRoute({ room: "all-workflows", selection: {} })
                }
              >
                Back to all workflows
              </BriefButton>
              {route.selection.flowId === "meeting" ? (
                <WorkflowCanvasRoom
                  shell={shell}
                  binding={{
                    source: "fixture",
                    scopeId: MANAGEMENT_SCOPE,
                    flowId: "meeting",
                    versionId: "meeting-v3",
                    capabilities: RUN_CAPABILITY,
                    request: canvas.request,
                  }}
                />
              ) : (
                <section>
                  <h1 className="brief-type-room-title">
                    {fixture.records.get(route.selection.flowId ?? "")?.name ??
                      "Selected workflow"}
                  </h1>
                  <p>
                    Selected workflow handoff. The host loads this workflow’s
                    own graph.
                  </p>
                  <dl aria-label="Exact workflow identity">
                    {Object.entries(route.selection).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
            </div>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
