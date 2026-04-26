import { useSyncExternalStore } from "react";

/**
 * Module-level store for the Workspaces Room UI selection.
 *
 * Why a singleton instead of `useState`:
 * The Workspaces Room can be mounted twice at the same time — once as an
 * inline `RoomWindow` body (mode="inline", in the thread flow), and once
 * as the fullscreen `RoomShell` body (mode="expanded", overlaid on top).
 * The voice handler that fires `select_project` from the inline window
 * wants to escalate to fullscreen via `openRoom("workspaces")`, but that
 * mounts a brand-new body with its own React state, so any
 * `setActiveProjectId` call in the inline body is invisible to the new
 * fullscreen body — the user sees the room land on the list view and
 * nothing happens.
 *
 * Lifting the selection to a module-level store with a subscription
 * pubsub fixes that: both body instances read from the same source, and
 * any state change in one is immediately visible in the other.
 *
 * Persisted to localStorage so a refresh doesn't dump the user back to
 * the list view if they were in the middle of editing a project.
 */

const STORAGE_KEY = "jarvis:v2:workspaces-ui";

export interface WorkspacesUIState {
  /** Project IDs currently open as tabs in the IDE. */
  openTabIds: string[];
  /** Currently focused project tab. */
  activeProjectId: string | null;
  leftTab: "chat" | "files";
  rightTab: "preview" | "editor";
  openFilePath: string | null;
}

const DEFAULT: WorkspacesUIState = {
  openTabIds: [],
  activeProjectId: null,
  leftTab: "files",
  rightTab: "preview",
  openFilePath: null,
};

function loadInitial(): WorkspacesUIState {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<WorkspacesUIState>;
    return {
      openTabIds: Array.isArray(parsed.openTabIds) ? parsed.openTabIds : [],
      activeProjectId:
        typeof parsed.activeProjectId === "string" ? parsed.activeProjectId : null,
      leftTab: parsed.leftTab === "chat" ? "chat" : "files",
      rightTab: parsed.rightTab === "editor" ? "editor" : "preview",
      openFilePath:
        typeof parsed.openFilePath === "string" ? parsed.openFilePath : null,
    };
  } catch {
    return DEFAULT;
  }
}

let state: WorkspacesUIState = loadInitial();
const listeners = new Set<() => void>();

function persist() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota — ignore */
  }
}

function emit() {
  for (const fn of listeners) fn();
}

export function getWorkspacesUIState(): WorkspacesUIState {
  return state;
}

export function setWorkspacesUIState(
  updater: (prev: WorkspacesUIState) => WorkspacesUIState,
): void {
  const next = updater(state);
  // Identity check — skip emits and writes if nothing changed.
  if (next === state) return;
  state = next;
  persist();
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Hook to read + subscribe to the shared workspaces UI state.
 * Use the exported `setWorkspacesUIState` to mutate.
 */
export function useWorkspacesUIState(): WorkspacesUIState {
  return useSyncExternalStore(subscribe, getWorkspacesUIState, getWorkspacesUIState);
}
