/**
 * Test fixtures: pre-built PieceCatalog instances mimicking the legacy
 * Jarvis-native pieces' shape. Used by composer / manage-workflow / API
 * route tests so they don't have to spawn the engine to extract real
 * metadata.
 *
 * Kept here (not in __fixtures__/) so tests can `import { sampleCatalog }`
 * from the runtime module they're already touching.
 */

import { PieceCatalog, type PieceCatalogEntry } from "./piece-catalog";

export function sampleCatalog(): PieceCatalog {
  const entries: PieceCatalogEntry[] = [
    {
      name: "jarvis-ask",
      displayName: "Jarvis: Ask",
      description: "Send a prompt to the LLM and receive the reply.",
      actions: {
        ask: {
          name: "ask",
          displayName: "Ask",
          description: "Send a prompt to Jarvis's LLM and receive the reply.",
          inputSchema: {
            fields: [
              {
                name: "prompt",
                label: "Prompt",
                type: "long_text",
                required: true,
                description: "The user prompt to send to the LLM.",
              },
              {
                name: "system",
                label: "System",
                type: "long_text",
                required: false,
              },
              {
                name: "parseJson",
                label: "Parse JSON",
                type: "boolean",
                required: false,
                default: false,
              },
            ],
          },
        },
      },
    },
    {
      name: "jarvis-notify",
      displayName: "Jarvis: Notify",
      description: "Deliver a message through the configured channels.",
      actions: {
        notify: {
          name: "notify",
          displayName: "Send a Jarvis notification",
          description: "Deliver a message through Jarvis's configured channels.",
          inputSchema: {
            fields: [
              { name: "message", label: "Message", type: "long_text", required: true },
              {
                name: "channels",
                label: "Channels",
                type: "multi_enum",
                required: false,
                default: ["auto"],
                options: [
                  { value: "auto", label: "Auto" },
                  { value: "dashboard", label: "Dashboard" },
                  { value: "telegram", label: "Telegram" },
                  { value: "discord", label: "Discord" },
                  { value: "voice", label: "Voice" },
                  { value: "desktop", label: "Desktop" },
                ],
              },
              {
                name: "priority",
                label: "Priority",
                type: "enum",
                required: false,
                default: "normal",
                options: [
                  { value: "low", label: "Low" },
                  { value: "normal", label: "Normal" },
                  { value: "high", label: "High" },
                ],
              },
            ],
          },
        },
      },
    },
    {
      name: "jarvis-trigger",
      displayName: "Jarvis: Trigger",
      description: "Bridge Jarvis events into workflows.",
      actions: {
        run_workflow: {
          name: "run_workflow",
          displayName: "Run another workflow",
          description: "Trigger a saved workflow.",
          inputSchema: {
            fields: [
              { name: "flow", label: "Flow", type: "flow_ref", required: true },
              { name: "payload", label: "Payload", type: "json", required: false },
            ],
          },
        },
      },
      triggers: {
        on_event: {
          name: "on_event",
          displayName: "On Jarvis event",
          description: "Fire the workflow when a Jarvis event of the given type is published.",
          inputSchema: {
            fields: [
              { name: "eventType", label: "Event type", type: "string", required: true },
              { name: "filter", label: "Filter", type: "json", required: false },
            ],
          },
        },
      },
    },
  ];
  return new PieceCatalog(entries);
}
