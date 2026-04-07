import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { browserNavigateTool, browserScreenshotTool } from './builtin.ts';
import { setSidecarManagerRef } from './sidecar-route.ts';

describe('browser tools via sidecar', () => {
  const dispatchRPC = mock(async (..._args: any[]) => undefined as any);
  const fakeManager = {
    listSidecars() {
      return [
        {
          id: 'sc-browser-1',
          name: 'workstation',
          enrolled_at: '',
          last_seen_at: '',
          status: 'enrolled' as const,
          connected: true,
          capabilities: ['browser'],
          unavailable_capabilities: [],
        },
      ];
    },
    dispatchRPC,
  };

  beforeEach(() => {
    dispatchRPC.mockReset();
    setSidecarManagerRef(fakeManager as any);
  });

  afterEach(() => {
    setSidecarManagerRef(null);
  });

  test('browser_navigate formats remote snapshots like local browser output', async () => {
    dispatchRPC.mockImplementationOnce(async () => ({
      success: true,
      snapshot: {
        title: 'Example Domain',
        url: 'https://example.com',
        text: 'Example Domain\nThis domain is for use in documentation examples.',
        elements: [
          { id: 1, tag: 'a', text: 'More information...', href: 'https://www.iana.org/help/example-domains' },
        ],
      },
    }));

    const result = await browserNavigateTool.execute({
      url: 'https://example.com',
      target: 'workstation',
    });

    expect(dispatchRPC).toHaveBeenCalledWith('sc-browser-1', 'browser_navigate', { url: 'https://example.com' });
    expect(String(result)).toContain('Page: Example Domain');
    expect(String(result)).toContain('URL: https://example.com');
    expect(String(result)).toContain('[1] a "More information..."');
  });

  test('browser_screenshot returns image content blocks for remote sidecar screenshots', async () => {
    dispatchRPC.mockImplementationOnce(async () => ({
      captured: true,
      _binary: {
        type: 'inline',
        mime_type: 'image/png',
        data: 'ZmFrZS1wbmc=',
      },
    }));

    const result = await browserScreenshotTool.execute({ target: 'workstation' });

    expect(typeof result).toBe('object');
    expect((result as any).content).toHaveLength(2);
    expect((result as any).content[1].type).toBe('image');
    expect((result as any).content[1].source.media_type).toBe('image/png');
    expect((result as any).content[1].source.data).toBe('ZmFrZS1wbmc=');
  });
});
