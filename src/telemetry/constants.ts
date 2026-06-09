const TELEMETRY_URL = 'https://wmrxnfhghycxyabdhczn.supabase.co/rest/v1/telemetry_pings';
const TELEMETRY_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcnhuZmhnaHljeHlhYmRoY3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5OTQ4OTgsImV4cCI6MjA5NjU3MDg5OH0.phREIq3UEKPUyTNT077q-LWBqCw16wajIoTC50Z0J0E';

/** 4 hours. Server processes that never restart still emit a heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function telemetryEndpoint(): { url: string; key: string } | null {
  if (!TELEMETRY_URL || TELEMETRY_URL.includes('YOUR_PROJECT_REF') || !TELEMETRY_ANON_KEY) {
    return null;
  }
  return { url: TELEMETRY_URL, key: TELEMETRY_ANON_KEY };
}
