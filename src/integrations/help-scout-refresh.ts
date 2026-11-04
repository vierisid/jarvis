/** Help Scout's managed refresher. It is created in help-scout-connection.ts, next to
 * the file reader it needs, so neither module imports the other. */
export {
  freshHelpScoutConnection,
  helpScoutNeedsReconnect,
  helpScoutGrantKey,
} from "./help-scout-connection";
