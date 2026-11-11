import { createContext, type ReactNode } from "react";

/**
 * Unread notifications the daemon saved for a workflow (a reminder, an alert).
 * The Needs you room puts `list` directly under its heading and counts them in
 * its empty state, so a founder who opens it sees them first.
 */
export type StoredNotices = { count: number; list: ReactNode };
export const StoredNoticesContext = createContext<StoredNotices>({ count: 0, list: null });
