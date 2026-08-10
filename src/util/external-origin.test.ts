import { describe, expect, it } from 'bun:test';
import type { JarvisConfig } from '../config/types.ts';
import {
  externalUrl,
  normalizePublicOrigin,
  resolveExternalOrigin,
} from './external-origin.ts';

function config(daemon: Partial<JarvisConfig['daemon']> = {}): JarvisConfig {
  return {
    daemon: {
      port: 3142,
      data_dir: '/tmp/jarvis',
      db_path: '/tmp/jarvis/jarvis.db',
      ...daemon,
    },
  } as JarvisConfig;
}

describe('resolveExternalOrigin', () => {
  it('uses public_url as the authoritative origin', () => {
    const result = resolveExternalOrigin(config({
      public_url: 'https://jarvis.example.com/',
      brain_domain: 'https://old.example.com',
    }));
    expect(result).toMatchObject({
      httpOrigin: 'https://jarvis.example.com',
      wsOrigin: 'wss://jarvis.example.com',
      source: 'public_url',
      warnings: [],
    });
  });

  it('keeps brain_domain as a backwards-compatible public origin', () => {
    const result = resolveExternalOrigin(config({ brain_domain: 'wss://brain.example.com:8443' }));
    expect(result.httpOrigin).toBe('https://brain.example.com:8443');
    expect(result.wsOrigin).toBe('wss://brain.example.com:8443');
    expect(result.source).toBe('brain_domain');
  });

  it('falls back to localhost when nothing is configured', () => {
    const result = resolveExternalOrigin(config());
    expect(result.httpOrigin).toBe('http://localhost:3142');
    expect(result.source).toBe('fallback');
  });

  it('ignores forwarded headers when choosing the origin', () => {
    const req = new Request('http://localhost:3142/api/system/external-origin', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'attacker.example',
      },
    });
    const result = resolveExternalOrigin(config({ public_url: 'https://jarvis.example.com' }), req);
    expect(result.httpOrigin).toBe('https://jarvis.example.com');
    expect(result.source).toBe('public_url');
  });

  it('warns when the proxy-reported origin differs from the configured one', () => {
    const req = new Request('http://localhost:3142/api/system/external-origin', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'other.example.com',
      },
    });
    const result = resolveExternalOrigin(config({ public_url: 'https://jarvis.example.com' }), req);
    expect(result.proxyDetected).toBe(true);
    expect(result.warnings[0]).toContain('differs');
  });

  it('warns when a proxy is detected but no public URL is configured', () => {
    const req = new Request('http://localhost:3142/api/system/external-origin', {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'jarvis.example.com',
      },
    });
    const result = resolveExternalOrigin(config(), req);
    expect(result.httpOrigin).toBe('http://localhost:3142');
    expect(result.source).toBe('fallback');
    expect(result.warnings[0]).toContain('daemon.public_url is not set');
  });

  it('salvages the origin of a legacy value with a path instead of failing', () => {
    const result = resolveExternalOrigin(config({ brain_domain: 'brain.example.com/jarvis' }));
    expect(result.httpOrigin).toBe('https://brain.example.com');
    expect(result.source).toBe('brain_domain');
    expect(result.warnings[0]).toContain('not a plain origin');
  });

  it('falls back to localhost with a warning on an unusable configured value', () => {
    for (const value of ['ftp://weird.example.com', 'https:/example.com', 'my host.com']) {
      const result = resolveExternalOrigin(config({ public_url: value }));
      expect(result.httpOrigin).toBe('http://localhost:3142');
      expect(result.source).toBe('fallback');
      expect(result.warnings[0]).toContain('unusable');
    }
  });

  it('builds external callback paths without changing the origin', () => {
    const origin = resolveExternalOrigin(config({ public_url: 'https://jarvis.example.com' }));
    expect(externalUrl(origin, '/api/auth/google/callback'))
      .toBe('https://jarvis.example.com/api/auth/google/callback');
  });
});

describe('normalizePublicOrigin', () => {
  it('rejects URLs with a path', () => {
    expect(() => normalizePublicOrigin('https://example.com/jarvis')).toThrow('without a path');
  });

  it('rejects credentials, query, and fragments', () => {
    expect(() => normalizePublicOrigin('https://user:pw@example.com')).toThrow();
    expect(() => normalizePublicOrigin('https://example.com?x=1')).toThrow();
  });

  it('defaults bare public hosts to https and loopback hosts to http', () => {
    expect(normalizePublicOrigin('jarvis.example.com')).toBe('https://jarvis.example.com');
    expect(normalizePublicOrigin('localhost:3142')).toBe('http://localhost:3142');
  });
});
