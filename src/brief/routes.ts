import type { BriefCapabilities } from './capabilities.ts';

/** Mounted only inside the daemon's existing authenticated API route table. */
export function createBriefRoutes(capabilities: BriefCapabilities, json: (body: unknown) => Response) {
  return {
    '/api/brief/capabilities': {
      GET: () => {
        const response = json(capabilities.snapshot());
        response.headers.set('Cache-Control', 'no-store');
        return response;
      },
    },
  };
}
