import React from "react";
import { DESTINATIONS, targetHref, type DestinationId } from "./destinations";

/** Retained Settings support entry. No Arrange/cluster controls are added to the Brief shell. */
export function MaintenanceLinks({ href, onNavigate }: { href: string; onNavigate?: (id: DestinationId) => void }) {
  return <section className="v2-set__section" aria-label="Advanced settings and support">
    <h3 className="v2-set__section-title">Advanced settings and support</h3>
    <p className="v2-set__hint">These controls remain in the current dashboard. Opening a link does not change settings or run an action.</p>
    <nav aria-label="Retained controls">
      {Object.entries(DESTINATIONS).filter(([id]) => !["advanced-settings", "authority", "connections"].includes(id)).map(([id, item]) =>
        <p key={id}>{onNavigate ? <button type="button" onClick={() => onNavigate(id as DestinationId)}>{item.label}</button> : <a href={targetHref(href, item.legacy)}>{item.label}</a>}</p>,
      )}
    </nav>
    <p className="v2-set__hint">For device privacy, open Sidecar → Configure. Disable awareness or screenshot capture in Capabilities; edit filesystem exclusions in Blocked Paths. Operating system privacy permissions remain on the device. Hosted provider restrictions still apply.</p>
  </section>;
}
