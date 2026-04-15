import { describe, expect, test } from 'bun:test';
import { SidecarManager } from './manager.ts';

describe('SidecarManager enrollment URLs', () => {
  test('uses explicit request origin when provided', () => {
    const manager = new SidecarManager('/tmp/jarvis-sidecar-manager-test') as any;
    const urls = manager.buildEnrollmentUrls('https://brain.example.com');

    expect(urls.brainWs).toBe('wss://brain.example.com/sidecar/connect');
    expect(urls.jwksUrl).toBe('https://brain.example.com/api/sidecars/.well-known/jwks.json');
  });

  test('preserves ws/http style URLs for local hosts', () => {
    const manager = new SidecarManager('/tmp/jarvis-sidecar-manager-test') as any;
    const urls = manager.buildEnrollmentUrls('10.0.0.25:3142');

    expect(urls.brainWs).toBe('ws://10.0.0.25:3142/sidecar/connect');
    expect(urls.jwksUrl).toBe('http://10.0.0.25:3142/api/sidecars/.well-known/jwks.json');
  });
});
