/**
 * Google OAuth2 Authentication
 *
 * Manages OAuth2 tokens for Google APIs (Gmail, Calendar).
 * Uses raw fetch() — no googleapis package needed.
 * Tokens stored at ~/.jarvis/google-tokens.json
 */

import path from 'node:path';
import os from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { secureParentDirectory, secureWriteFile } from '../util/fs-secure.ts';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export type GoogleTokens = {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
};

export class GoogleAuth {
  private clientId: string;
  private clientSecret: string;
  private tokens: GoogleTokens | null = null;
  private tokensPath: string;
  private redirectUri: string;

  constructor(
    clientId: string,
    clientSecret: string,
    opts?: { tokensPath?: string; redirectUri?: string }
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokensPath = opts?.tokensPath ?? path.join(os.homedir(), '.jarvis', 'google-tokens.json');
    this.redirectUri = opts?.redirectUri ?? 'http://localhost:3142/api/auth/google/callback';
    this.loadTokens();
  }

  /**
   * Load saved tokens from disk.
   */
  loadTokens(): GoogleTokens | null {
    try {
      if (!existsSync(this.tokensPath)) return null;
      const text = readFileSync(this.tokensPath, 'utf-8');
      const data = JSON.parse(text);
      if (data.access_token && data.refresh_token) {
        this.tokens = data as GoogleTokens;
        return this.tokens;
      }
    } catch {
      // No tokens file or invalid
    }
    return null;
  }

  /**
   * Save tokens to disk.
   */
  async saveTokens(tokens: GoogleTokens): Promise<void> {
    this.tokens = tokens;
    await secureParentDirectory(this.tokensPath);
    await secureWriteFile(this.tokensPath, JSON.stringify(tokens, null, 2), 0o600, 'GoogleAuth');
  }

  /**
   * Check if we have valid tokens.
   */
  isAuthenticated(): boolean {
    return this.tokens !== null && !!this.tokens.refresh_token;
  }

  /**
   * Get a valid access token. Auto-refreshes if expired.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Run: bun run src/scripts/google-setup.ts');
    }

    // Check if token is expired (with 5 min buffer)
    if (this.tokens.expiry_date && Date.now() > this.tokens.expiry_date - 5 * 60_000) {
      await this.refreshAccessToken();
    }

    return this.tokens.access_token;
  }

  /**
   * Generate OAuth2 consent URL.
   */
  getAuthUrl(scopes: string[]): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(code: string): Promise<GoogleTokens> {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await resp.json() as any;

    const tokens: GoogleTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
      token_type: data.token_type ?? 'Bearer',
    };

    await this.saveTokens(tokens);
    return tokens;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refresh_token) {
      throw new Error('No refresh token available');
    }

    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: this.tokens.refresh_token,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Token refresh failed: ${err}`);
    }

    const data = await resp.json() as any;

    this.tokens = {
      ...this.tokens,
      access_token: data.access_token,
      expiry_date: Date.now() + (data.expires_in ?? 3600) * 1000,
    };

    await this.saveTokens(this.tokens);
    console.log('[GoogleAuth] Token refreshed successfully');
  }
}
