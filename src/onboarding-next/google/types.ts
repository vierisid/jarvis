import type { GoogleAuth } from '../../integrations/google-auth.ts';
import type { GoogleOAuthFlowStore } from '../../integrations/google-oauth-flow.ts';

export interface GoogleScope { actorId: string; projectId: string }
export type GoogleConnection =
  | { state: 'idle' }
  | { state: 'pending'; attemptId: string }
  | { state: 'connected'; attemptId: string | null; accountLabel: string; grantedAccessSummary: string; scopes: string[] }
  | { state: 'cancelled' | 'expired'; attemptId: string }
  | { state: 'error'; attemptId: string | null; message: string }
  | { state: 'unavailable'; message: string };
export interface GoogleSnapshot {
  schemaVersion: 1;
  provider: 'google';
  installMode: 'unknown' | 'hosted' | 'self';
  supported: boolean;
  ready: boolean;
  /** Changes after restart or idle eviction; revisions are comparable only within it. */
  streamId: string;
  revision: number;
  reason: string;
  connection: GoogleConnection;
}
export type GoogleGrant =
  | { state: 'absent' | 'revoked' | 'unverified' }
  | { state: 'verified'; accountLabel: string; scopes: string[] };

/** Server-selected canonical account store. Never construct from request IDs/paths. */
export interface GoogleBinding {
  id: string;
  owner: GoogleScope;
  installMode: 'hosted' | 'self';
  readGrant(): Promise<GoogleGrant>;
  /** Hosted sign-in stays on the existing control plane. No local credential form. */
  hostedConnectUrl?: string;
  self?: {
    redirectUri: string;
    flows: Pick<GoogleOAuthFlowStore, 'start' | 'consume'>;
    auth: Pick<GoogleAuth, 'getAuthUrl' | 'exchangeCode'>;
    /** Existing settings reload, after the canonical token write. */
    onTokensSaved(): void;
  };
}
export interface GooglePorts<Context> {
  authorize(context: Context): GoogleScope | null | Promise<GoogleScope | null>;
  resolve(scope: GoogleScope): GoogleBinding | null | Promise<GoogleBinding | null>;
  now?: () => number;
}
export interface GoogleStart { snapshot: GoogleSnapshot; launch?: { attemptId: string; url: string } }

/** Same requested scopes as the existing self-hosted init route. No expansion. */
export const GOOGLE_ONBOARDING_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;
