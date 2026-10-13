import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { AppearanceSelector } from "./AppearanceSelector";
import {
  SETTINGS_EXAMPLES,
  SETTINGS_SCOPE,
  makeSettingsFixture,
  type SettingsExample,
} from "./fixtures";
import "../../today/preview/specimen.css";

export function SettingsSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<SettingsExample>("local"),
    [mount, setMount] = useState(0),
    [route, setRoute] = useState<BriefRoute>({
      room: "settings",
      selection: {},
    });
  const fixture = useMemo(
    () =>
      makeSettingsFixture(example, 180, (destination) => {
        setRoute({
          room:
            destination === "authority"
              ? "authority"
              : destination === "connections"
                ? "connected-workspace"
                : "today",
          selection: {},
        });
      }),
    [example],
  );
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
      route,
      navigate: setRoute,
    }),
    [theme, sidebar, chatOpen, route, fixture],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-30 · Settings</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <AppearanceSelector />
        <label>
          Example{" "}
          <select
            aria-label="Settings example"
            value={example}
            onChange={(e) => {
              setExample(e.target.value as SettingsExample);
              setRoute({ room: "settings", selection: {} });
            }}
          >
            {SETTINGS_EXAMPLES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            fixture.failReads(true);
            void fixture.controller.refresh();
          }}
        >
          Simulate stale read
        </button>
        <button
          onClick={() => {
            fixture.failReads(false);
            void fixture.controller.refresh();
          }}
        >
          Restore reads
        </button>
        <button onClick={() => fixture.recoverWrites()}>Restore saves</button>
        <button
          onClick={() => {
            const voice = fixture.current().voice.choices.at(-1)?.id;
            if (!voice) return;
            fixture.change(voice);
            void fixture.controller.refresh();
          }}
        >
          Simulate external edit
        </button>
        <button onClick={() => setMount((value) => value + 1)}>
          Remount room
        </button>
        <small>
          Isolated settings only. No account identity or real settings are
          changed.
        </small>
      </div>
      <div className="brief-today-review-viewport" style={{ width: "100%" }}>
        <NavigationShell
          shell={shell}
          rooms={{
            profile: { id: "profile", title: "Profile" },
            today: { id: "today", title: "Today" },
            settings: { id: "settings", title: "Settings" },
            billing: { id: "billing", title: "Billing" },
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
                    scopeId: "d30-preview-chat",
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
                      cancel() {},
                    },
                  }}
                />
              </>
            ),
          }}
        >
          {route.room === "settings" ? (
            <SettingsWorkspace
              key={mount}
              shell={shell}
              binding={{
                controller: fixture.controller,
                source: "fixture",
                scopeId: SETTINGS_SCOPE,
              }}
            />
          ) : (
            <section>
              <h1 className="brief-type-room-title">Preview destination</h1>
              <p>
                This is the existing destination boundary. Hosted provider setup
                stays managed. Use the account menu to return to Settings.
              </p>
            </section>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
