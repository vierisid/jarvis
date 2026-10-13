import React, { useState } from "react";
import { attentionKey, attentionView, openNotification, type AttentionIdentity, type AttentionSnapshot } from "./notifications";
import type { NavigationCompatibility } from "./controller";
import type { RoomAvailability } from "./destinations";

/** Body for the host's existing Needs you / attention outlet, mounted outside conversation.
 * Props are canonical snapshots, never an independent fetch or websocket subscription.
 */
export function AttentionRoutes({ snapshot, navigation, roomAvailable, markRead }: {
  snapshot: AttentionSnapshot;
  navigation: NavigationCompatibility;
  roomAvailable: RoomAvailability;
  /** Dispatch to the matching notification owner; IDs are only unique within a source. */
  markRead(identity: AttentionIdentity): void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const view = attentionView(snapshot);
  // A pending guard must recheck the latest snapshot even if this component rerenders.
  const latest = React.useRef({ snapshot, roomAvailable, markRead });
  latest.current = { snapshot, roomAvailable, markRead };
  return <section aria-label="Notifications">
    <h2>Needs your attention</h2>
    {view.status !== "ready" ? <p role="status">Notifications are {view.status}. Open Authority, task recovery or device settings to inspect their current state.</p>
      : view.items.length === 0 ? <p>No pending notifications.</p>
      : <ul>{view.items.map(item => <li key={attentionKey(item)}>
        <button type="button" disabled={!navigation.available()} onClick={async () => {
          const result = await openNotification(attentionKey(item), {
            snapshot: () => latest.current.snapshot,
            roomAvailable: room => latest.current.roomAvailable(room),
            markRead: identity => latest.current.markRead(identity),
          }, navigation);
          setMessage(result.state === "opened" ? null : result.state === "cancelled" ? "Navigation cancelled. The notification is still available." : "This notification could not be opened. Refresh or use the retained controls.");
        }}>{item.title}</button>
        {item.text && <p>{item.text}</p>}
      </li>)}</ul>}
    {message && <p role="status">{message}</p>}
  </section>;
}
