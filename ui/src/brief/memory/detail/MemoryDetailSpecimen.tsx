import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { MemoryExperience } from "./MemoryExperience";
import {
  makeMemoryDetailFixture,
  DETAIL_EXAMPLES,
  DETAIL_SCOPE,
  type DetailExample,
} from "./fixtures";
import "../../today/preview/specimen.css";

export function MemoryDetailSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [route, setRoute] = useState<BriefShellPort["route"]>({
      room: "memory",
      selection: {},
    });
  const [example, setExample] = useState<DetailExample>("ready");
  const fixture = useMemo(
    () => makeMemoryDetailFixture(example, 180),
    [example],
  );
  useEffect(
    () => () => {
      fixture.controller.retire();
      fixture.stream.retire();
    },
    [fixture],
  );
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
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-26 · Memory detail</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Memory example"
            value={example}
            onChange={(event) => {
              setRoute({ room: "memory", selection: {} });
              setExample(event.target.value as DetailExample);
            }}
          >
            {DETAIL_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <small>Illustrative memory only. No live data or effects. </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            memory: { id: "memory", title: "Memory" },
            "memory-detail": { id: "memory-detail", title: "Memory detail" },
          }}
          binding={{
            capabilities: null,
            view: {
              source: "fixture",
              state: {
                status: "ready",
                data: {
                  ...UNKNOWN_NAVIGATION,
                  workspaceName: "Preview workspace",
                  connection: "connected",
                  account: {
                    name: "Preview owner",
                    plan: { status: "ready", data: "Preview" },
                  },
                },
              },
            },
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
                    scopeId: "d26-preview-chat",
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
          <MemoryExperience
            shell={shell}
            binding={{
              detail: fixture.controller,
              stream: {
                source: "fixture",
                scopeId: DETAIL_SCOPE,
                controller: fixture.stream,
                sourceOptions: ["Conversation", "Meeting notes"],
                useOptions: [
                  {
                    value: "run:fixture-follow-up",
                    label: "Meeting follow-ups",
                  },
                ],
              },
            }}
          />
        </NavigationShell>
      </div>
    </div>
  );
}
