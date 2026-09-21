import React from "react";
import type { RemoteData } from "../hooks/useRemoteData";
import "./RemoteSection.css";

export function RemoteNotice({ label, resource }: { label: string; resource: RemoteData<unknown> }) {
  if (resource.availability === "ready") return null;
  return <div className="v2-remote-state" data-availability={resource.availability} role="status">
    <span><strong>{label}: {resource.availability === "loading" ? "Loading" : resource.availability === "stale" ? "Stale" : "Unavailable"}.</strong>
      {resource.availability === "stale" && <> Last known data from <time dateTime={new Date(resource.updatedAt!).toISOString()}>{new Date(resource.updatedAt!).toLocaleString()}</time>; not current.</>}
      {resource.error && <> {resource.error}</>}
    </span>
    {resource.availability !== "loading" && <button type="button" onClick={() => void resource.refresh()} aria-label={`Retry ${label}`}>Retry</button>}
  </div>;
}

/** Empty claims are only rendered after a successful load. Nonempty snapshots
 * remain useful during an outage, with their age and stale label attached.
 */
export function RemoteSection({ label, resource, empty = false, children }: {
  label: string; resource: RemoteData<unknown>; empty?: boolean; children: React.ReactNode;
}) {
  return <>
    <RemoteNotice label={label} resource={resource} />
    {(resource.availability === "ready" || (resource.availability === "stale" && !empty)) && children}
  </>;
}
