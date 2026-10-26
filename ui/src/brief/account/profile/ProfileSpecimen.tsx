import React, { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../../v2/shell/useTheme";
import type { BriefRoute, BriefShellPort } from "../../contracts";
import { NavigationShell } from "../../shell/navigation/NavigationShell";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { ConversationComposer } from "../../chat/composer/ConversationComposer";
import { ProfileWorkspace } from "./ProfileWorkspace";
import { guardProfileNavigation } from "./navigation";
import {
  PROFILE_EXAMPLES,
  PROFILE_SCOPE,
  makeProfileFixture,
  type ProfileExample,
} from "./fixtures";
import "../../today/preview/specimen.css";

export function ProfileSpecimen() {
  const [theme, setTheme] = useTheme(),
    [sidebar, setSidebar] = useState<"expanded" | "rail">("expanded"),
    [chatOpen, setChatOpen] = useState(false),
    [draft, setDraft] = useState("");
  const [example, setExample] = useState<ProfileExample>("ready"),
    [mount, setMount] = useState(0),
    [route, setRoute] = useState<BriefRoute>({
      room: "profile",
      selection: {},
    });
  const fixture = useMemo(() => makeProfileFixture(example, 180), [example]);
  useEffect(() => () => fixture.controller.retire(), [fixture]);
  const shell = useMemo<BriefShellPort>(
    () =>
      guardProfileNavigation(
        {
          mode: "preview",
          theme,
          setTheme,
          sidebar,
          setSidebar,
          chatOpen,
          setChatOpen,
          route,
          navigate: setRoute,
        },
        fixture.controller,
      ),
    [theme, sidebar, chatOpen, route, fixture],
  );
  return (
    <div className="brief-root brief-today-specimen" data-brief-theme={theme}>
      <div
        className="brief-today-review-toolbar"
        aria-label="Isolated review controls"
      >
        <span>D-29 · Profile</span>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch to {theme === "light" ? "dark" : "light"}
        </button>
        <label>
          Example{" "}
          <select
            aria-label="Profile example"
            value={example}
            onChange={(e) => {
              setExample(e.target.value as ProfileExample);
              setRoute({ room: "profile", selection: {} });
            }}
          >
            {PROFILE_EXAMPLES.map((value) => (
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
            fixture.change({ company: "External correction" });
            void fixture.controller.refresh();
          }}
        >
          Simulate external edit
        </button>
        <button onClick={() => setMount((value) => value + 1)}>
          Remount room
        </button>
        <small>
          Isolated profile only. No account identity or real settings are
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
                    scopeId: "d29-preview-chat",
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
          {route.room === "profile" ? (
            <ProfileWorkspace
              key={mount}
              shell={shell}
              binding={{
                controller: fixture.controller,
                source: "fixture",
                scopeId: PROFILE_SCOPE,
              }}
            />
          ) : (
            <section>
              <h1 className="brief-type-room-title">Preview destination</h1>
              <p>Use the account menu to return to Profile.</p>
            </section>
          )}
        </NavigationShell>
      </div>
    </div>
  );
}
