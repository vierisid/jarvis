import React from "react";
import { RoomShell } from "./RoomShell";
import type { RoomKey } from "../router";

/**
 * Error boundary for lazy-loaded Room components (Phase 6.8).
 *
 * Without this, if a Room's lazy chunk fails to load — flaky network,
 * stale CDN, browser cache miss after a deploy — the parent Suspense
 * shows its placeholder forever and the user has no escape except
 * refreshing the whole tab. This boundary catches the load error,
 * shows a real Room overlay with a Retry button, and (most
 * importantly) preserves Esc-to-close so the user can still get back
 * to the thread without a refresh.
 *
 * Has to be a class component — there's no hook for componentDidCatch.
 */
export interface RoomLoadErrorBoundaryProps {
  roomKey: RoomKey;
  title: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped on Retry to force the lazy chunk to re-attempt. */
  attempt: number;
}

export class RoomLoadErrorBoundary extends React.Component<
  RoomLoadErrorBoundaryProps,
  State
> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[RoomLoadErrorBoundary] ${this.props.roomKey} failed to load:`,
      error,
      info,
    );
  }

  private handleRetry = () => {
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }));
  };

  override render() {
    if (this.state.error) {
      return (
        <RoomShell
          title={this.props.title}
          breadcrumb={[this.props.title]}
          actions={[
            { label: "Retry", onClick: this.handleRetry, variant: "primary" },
          ]}
        >
          <div
            style={{
              padding: "var(--s-8) var(--s-6)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--s-3)",
              textAlign: "center",
              maxWidth: 480,
              margin: "0 auto",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              Room failed to load
            </div>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-md)",
                color: "var(--ink)",
                lineHeight: "var(--lh-body)",
              }}
            >
              The {this.props.title} module couldn't be downloaded. Check your connection,
              then click Retry. Esc returns to the thread.
            </div>
            {this.state.error.message && (
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  background: "var(--paper-2)",
                  border: "1px solid var(--rule-soft)",
                  borderRadius: "var(--r-1)",
                  padding: "var(--s-2) var(--s-3)",
                  maxWidth: "100%",
                  overflow: "auto",
                  wordBreak: "break-word",
                }}
              >
                {this.state.error.message}
              </code>
            )}
          </div>
        </RoomShell>
      );
    }

    // The `attempt` key forces React to discard the failed lazy import
    // tree on retry so the dynamic import runs again instead of replaying
    // the cached rejected promise.
    return (
      <React.Fragment key={this.state.attempt}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
