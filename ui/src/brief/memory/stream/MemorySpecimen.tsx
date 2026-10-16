import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { MemoryStreamRoom } from "./MemoryStreamRoom";
import {
  makeMemoryFixture,
  MEMORY_EXAMPLES,
  MEMORY_SCOPE,
  type MemoryExample,
} from "./fixtures";
import "../../today/preview/specimen.css";

export function MemorySpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState(""),
    [selected, setSelected] = useState("");
  const [example, setExample] = useState<MemoryExample>("ready");
  const fixture = useMemo(() => makeMemoryFixture(example, 180), [example]);
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  const shell = useMemo<BriefShellPort>(
    () => ({
      mode: "preview",
      theme,
      setTheme,
      sidebar,
      setSidebar,
      chatOpen,
      setChatOpen,
      route: { room: "memory", selection: {} },
      navigate: () => {},
    }),
    [theme, setTheme, sidebar, chatOpen],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-25 · Memory</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Memory example"
            value={example}
            onChange={(event) => {
              setSelected("");
              setExample(event.target.value as MemoryExample);
            }}
          >
            {MEMORY_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <small>
          Illustrative memory only. No live data or effects.{" "}
          {selected && `Selected ${selected}; detail belongs to D-26.`}
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{ memory: { id: "memory", title: "Memory" } }}
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
                    scopeId: "d25-preview-chat",
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
          <MemoryStreamRoom
            shell={shell}
            binding={{
              source: "fixture",
              scopeId: MEMORY_SCOPE,
              controller: fixture.controller,
              sourceOptions: ["Conversation", "Meeting notes"],
              useOptions: [
                { value: "run:fixture-follow-up", label: "Meeting follow-ups" },
              ],
              onOpen: setSelected,
            }}
          />
        </NavigationShell>
      </div>
    </div>
  );
}
