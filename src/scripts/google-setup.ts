/**
 * Google OAuth2 Setup Script
 *
 * Interactive CLI to authenticate JARVIS with Google APIs.
 * Opens browser to Google consent screen, handles callback,
 * and saves tokens to ~/.jarvis/google-tokens.json.
 *
 * Usage: bun run src/scripts/google-setup.ts
 */

import { GoogleAuth } from '../integrations/google-auth.ts';
import { loadConfig } from '../config/loader.ts';
import { externalUrl, resolveExternalOrigin } from '../util/external-origin.ts';
import { GoogleOAuthFlowStore } from '../integrations/google-oauth-flow.ts';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

async function main() {
  console.log('');
  console.log('=== Google OAuth2 Setup for JARVIS ===');
  console.log('');

  // Load config to get client_id / client_secret. Dashboard-entered creds
  // live in the vault DB (user-settings google fallback), so open it and
  // merge before concluding nothing is configured.
  const config = await loadConfig();
  try {
    const { initDatabase } = await import('../vault/schema.ts');
    const { mergeUserSettingsIntoConfig } = await import('../daemon/user-settings.ts');
    initDatabase(config.daemon.db_path, { quiet: true });
    mergeUserSettingsIntoConfig(config);
  } catch {
    // No DB yet (fresh install) - the interactive prompt below handles it.
  }

  let clientId = config.google?.client_id ?? '';
  let clientSecret = config.google?.client_secret ?? '';
  const externalOrigin = resolveExternalOrigin(config);
  for (const warning of externalOrigin.warnings) console.warn(`Warning: ${warning}`);
  const redirectUri = externalUrl(externalOrigin, '/api/auth/google/callback');

  if (!clientId || !clientSecret) {
    console.log('No Google OAuth credentials found in config.yaml.');
    console.log('');
    console.log('Add the following to your ~/.jarvis/config.yaml:');
    console.log('');
    console.log('google:');
    console.log('  client_id: "your-client-id.apps.googleusercontent.com"');
    console.log('  client_secret: "your-client-secret"');
    console.log('');
    console.log('To get credentials:');
    console.log('  1. Go to https://console.cloud.google.com/apis/credentials');
    console.log('  2. Create an OAuth2 client ID (Web application)');
    console.log(`  3. Add ${redirectUri} as a redirect URI`);
    console.log('  4. Copy client_id and client_secret into config.yaml');
    console.log('');

    // Try reading from stdin
    const rl = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));

    clientId = (await ask('Client ID (or press Enter to abort): ')).trim();
    if (!clientId) {
      console.log('Aborted.');
      rl.close();
      process.exit(1);
    }

    clientSecret = (await ask('Client Secret: ')).trim();
    if (!clientSecret) {
      console.log('Aborted.');
      rl.close();
      process.exit(1);
    }

    rl.close();
  }

  const auth = new GoogleAuth(clientId, clientSecret, { redirectUri });

  // Check if already authenticated
  if (auth.isAuthenticated()) {
    console.log('Already authenticated! Tokens exist at ~/.jarvis/google-tokens.json');
    console.log('To re-authenticate, delete that file and run this again.');
    process.exit(0);
  }

  const oauthFlows = new GoogleOAuthFlowStore();
  const startedFlow = oauthFlows.start(redirectUri);
  const authUrl = auth.getAuthUrl(SCOPES, {
    state: startedFlow.state,
    codeChallenge: startedFlow.codeChallenge,
  });

  console.log('');
  console.log('Opening browser for Google authorization...');
  console.log('');
  console.log('If the browser does not open, visit this URL:');
  console.log(authUrl);
  console.log('');

  // Try to open browser
  try {
    const opener = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
    Bun.spawn([opener, authUrl], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Ignore — user can open manually
  }

  // Start temporary HTTP server to receive the callback
  console.log(`Waiting for authorization callback at ${redirectUri}...`);
  console.log('');

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: config.daemon.port,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/api/auth/google/callback') {
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');
          const state = url.searchParams.get('state');

          if (error) {
            console.error('Authorization denied:', error);
            setTimeout(() => {
              server.stop();
              process.exit(1);
            }, 500);
            return new Response(
              '<html><body><h1>Authorization Denied</h1><p>You can close this tab.</p></body></html>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          }

          if (!code) {
            return new Response('Missing code', { status: 400 });
          }

          const pendingFlow = state ? oauthFlows.consume(state) : null;
          if (!pendingFlow) {
            return new Response('Invalid or expired OAuth state', { status: 400 });
          }

          try {
            const tokens = await auth.exchangeCode(code, { codeVerifier: pendingFlow.codeVerifier });
            console.log('Authorization successful!');
            console.log(`Access token: ${tokens.access_token.slice(0, 20)}...`);
            console.log(`Refresh token: ${tokens.refresh_token.slice(0, 20)}...`);
            console.log(`Tokens saved to ~/.jarvis/google-tokens.json`);

            setTimeout(() => {
              server.stop();
              process.exit(0);
            }, 500);

            return new Response(
              '<html><body><h1>JARVIS Google Authorization Complete!</h1><p>Tokens saved. You can close this tab.</p></body></html>',
              { headers: { 'Content-Type': 'text/html' } }
            );
          } catch (err) {
            console.error('Token exchange failed:', err);
            setTimeout(() => {
              server.stop();
              process.exit(1);
            }, 500);
            return new Response(
              `<html><body><h1>Token Exchange Failed</h1><pre>${err}</pre></body></html>`,
              { headers: { 'Content-Type': 'text/html' }, status: 500 }
            );
          }
        }

        return new Response('Not found', { status: 404 });
      },
    });
  } catch (err) {
    console.error(`Could not listen on port ${config.daemon.port}: ${err instanceof Error ? err.message : err}`);
    console.error('The Jarvis daemon is probably running and already owns that port.');
    console.error('Connect Google from the dashboard instead: Settings → Integrations.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
