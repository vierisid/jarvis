export { TelemetryService, type TelemetryServiceOptions, type Sender } from './service.ts';
export { resolveTelemetryEnabled, type TelemetryDecision } from './config.ts';
export { buildPayload, sendPing, type TelemetryPayload, type SendOutcome } from './client.ts';
export { computeAnonId } from './anon-id.ts';
export { telemetryEndpoint, HEARTBEAT_INTERVAL_MS } from './constants.ts';
