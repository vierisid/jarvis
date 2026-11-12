/**
 * Google OAuth2 Setup Script
 *
 * Interactive CLI to authenticate JARVIS with Google APIs.
 * Opens browser to Google consent screen, handles callback,
 * and saves tokens to ~/.jarvis/google-tokens.json.
 *
 * Usage: bun run src/scripts/google-setup.ts
 */

import { GoogleAuth, googleTokensPath } from '../integrations/google-auth.ts';
import { loadConfig } from '../config/loader.ts';
import { externalUrl, resolveExternalOrigin } from '../util/external-origin.ts';
import { GoogleOAuthFlowStore } from '../integrations/google-oauth-flow.ts';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

/**
 * What the terminal is told once the tokens are on disk: that they were saved,
 * and where. No part of either token: a prefix is still part of a bearer
 * credential, and setup output is the kind of thing people paste into a bug
 * report or a screen share.
 */
export function savedTokensReport(tokensPath: string): string[] {
  return [
    'Authorization successful!',
    `Google access and refresh tokens saved to ${tokensPath} (readable only by you).`,
  ];
}

/**
 * The callback server binds loopback only. Google redirects the user's own
 * browser here, so nothing off this machine has a reason to reach it, and a
 * listener on every interface would let anyone on the network race the real
 * redirect. A reverse proxy in front of an external origin reaches it the same
 * way it reaches a daemon bound to loopback.
 */
export const CALLBACK_HOSTNAME = '127.0.0.1';

/** Drop C0/C1 control characters (terminal escapes, newlines that forge log lines). */
export function withoutControlChars(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Text from outside (a query parameter, a provider's error body), safe to echo into a page. */
export function echoForHtml(text: string, max = 2000): string {
  return escapeHtml(withoutControlChars(text).slice(0, max));
}

/** The same text, safe to print to the terminal. */
export function echoForTerminal(text: string, max = 2000): string {
  return withoutControlChars(text).slice(0, max);
}

export interface CallbackDeps {
  /** Where exchange() saves the tokens, for the success report. */
  tokensPath: string;
  /** The pending flow `state` names, consumed; null when it names none. */
  consume(state: string): { codeVerifier: string } | null;
  /** Exchange the code and save the tokens. */
  exchange(code: string, codeVerifier: string): Promise<void>;
  /** Stop the server and exit with this code, once the response is out. */
  finish(exitCode: number): void;
  log(line: string): void;
  error(line: string): void;
}

function htmlPage(body: string, status = 200): Response {
  return new Response(`<html><body>${body}</body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * One request to the callback server. `state` is checked before anything else
 * the request carries is acted on: without it, any page the browser visits (or
 * anything that can reach the port) could end the setup with `?error=`, or put
 * its own text in the terminal and the page.
 */
export async function handleOAuthCallback(url: URL, deps: CallbackDeps): Promise<Response> {
  if (url.pathname !== '/api/auth/google/callback') {
    return new Response('Not found', { status: 404 });
  }
  const state = url.searchParams.get('state');
  const pendingFlow = state ? deps.consume(state) : null;
  if (!pendingFlow) {
    return new Response('Invalid or expired OAuth state', { status: 400 });
  }

  const error = url.searchParams.get('error');
  if (error) {
    deps.error(`Authorization denied: ${echoForTerminal(error, 200)}`);
    deps.finish(1);
    return htmlPage(`<h1>Authorization Denied</h1><p>${echoForHtml(error, 200)}</p><p>You can close this tab.</p>`);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    deps.error('Google redirected back without an authorization code.');
    deps.finish(1);
    return new Response('Missing code', { status: 400 });
  }

  try {
    await deps.exchange(code, pendingFlow.codeVerifier);
    for (const line of savedTokensReport(deps.tokensPath)) deps.log(line);
    deps.finish(0);
    return htmlPage('<h1>JARVIS Google Authorization Complete!</h1><p>Tokens saved. You can close this tab.</p>');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.error(`Token exchange failed: ${echoForTerminal(message)}`);
    deps.finish(1);
    return htmlPage(`<h1>Token Exchange Failed</h1><pre>${echoForHtml(message)}</pre>`, 500);
  }
}

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

    // Try reading from stdin. One interface for both answers; its echo is
    // muted while the client secret is typed: the secret is a credential, and
    // a terminal that shows it puts it in scrollback, a recording or a screen
    // share. Off a TTY (piped input) nothing is echoed anyway.
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) process.stdout.write(chunk);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });

    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));
    const askHidden = async (q: string): Promise<string> => {
      process.stdout.write(q);
      muted = true;
      try {
        return await ask('');
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    };

    clientId = (await ask('Client ID (or press Enter to abort): ')).trim();
    if (!clientId) {
      console.log('Aborted.');
      rl.close();
      process.exit(1);
    }

    clientSecret = (await askHidden('Client Secret (not shown as you type): ')).trim();
    rl.close();
    if (!clientSecret) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  const tokensPath = googleTokensPath();
  const auth = new GoogleAuth(clientId, clientSecret, { redirectUri, tokensPath });

  // Check if already authenticated
  if (auth.isAuthenticated()) {
    console.log(`Already authenticated! Tokens exist at ${tokensPath}`);
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
  const deps: CallbackDeps = {
    tokensPath,
    consume: (state) => oauthFlows.consume(state),
    exchange: async (code, codeVerifier) => { await auth.exchangeCode(code, { codeVerifier }); },
    finish: (exitCode) => {
      setTimeout(() => {
        server.stop();
        process.exit(exitCode);
      }, 500);
    },
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
  try {
    server = Bun.serve({
      hostname: CALLBACK_HOSTNAME,
      port: config.daemon.port,
      fetch: (req) => handleOAuthCallback(new URL(req.url), deps),
    });
  } catch (err) {
    console.error(`Could not listen on port ${config.daemon.port}: ${err instanceof Error ? err.message : err}`);
    console.error('The Jarvis daemon is probably running and already owns that port.');
    console.error('Connect Google from the dashboard instead: Settings → Integrations.');
    process.exit(1);
  }
}

// Imported by its test; only `bun run` starts the flow.
if (import.meta.main) {
  main().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}
