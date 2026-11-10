import React from "react";
import { DESTINATIONS, targetHref } from "../navigation/destinations";

/** The one link from "an AI provider is needed" notices to where it is set (Settings, AI provider). */
export function AiSettingsLink() {
  return <a data-provider-settings href={targetHref(window.location.href, DESTINATIONS.credentials.legacy)}>Open AI settings</a>;
}
