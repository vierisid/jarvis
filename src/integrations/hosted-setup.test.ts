import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types';
import { HOSTED_CONNECTION_PROVIDERS, type HostedConnectionProvider } from './connection-providers';
import { HOSTED_SETUP_UNAVAILABLE } from './hosted-setup';
import { airtableStatus } from './airtable-connection';
import { asanaStatus } from './asana-connection';
import { calendlyStatus } from './calendly-connection';
import { clickUpStatus } from './clickup-connection';
import { dropboxStatus } from './dropbox-connection';
import { figmaStatus } from './figma-connection';
import { githubStatus } from './github-connection';
import { gitlabStatus } from './gitlab-connection';
import { helpScoutStatus } from './help-scout-connection';
import { intercomStatus } from './intercom-connection';
import { linearStatus } from './linear-connection';
import { mailchimpStatus } from './mailchimp-connection';
import { mondayStatus } from './monday-connection';
import { notionStatus } from './notion-connection';
import { pipedriveStatus } from './pipedrive-connection';
import { slackStatus } from './slack-connection';
import { todoistStatus } from './todoist-connection';
import { trelloStatus } from './trello-connection';
import { typeformStatus } from './typeform-connection';
import { webflowStatus } from './webflow-connection';
import { wrikeStatus } from './wrike-connection';
import { zoomStatus } from './zoom-connection';

/** Every hosted provider's status, keyed as the panel lists them. */
const STATUS: Record<HostedConnectionProvider, (config: JarvisConfig) => { configured: boolean; connect_url: string | null; reason?: string }> = {
  airtable: airtableStatus,
  asana: asanaStatus,
  calendly: calendlyStatus,
  clickup: clickUpStatus,
  dropbox: dropboxStatus,
  figma: figmaStatus,
  github: githubStatus,
  gitlab: gitlabStatus,
  'help-scout': helpScoutStatus,
  intercom: intercomStatus,
  linear: linearStatus,
  mailchimp: mailchimpStatus,
  monday: mondayStatus,
  notion: notionStatus,
  pipedrive: pipedriveStatus,
  slack: slackStatus,
  todoist: todoistStatus,
  trello: trelloStatus,
  typeform: typeformStatus,
  webflow: webflowStatus,
  wrike: wrikeStatus,
  zoom: zoomStatus,
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hosted-setup-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(extra: Partial<JarvisConfig> = {}, listen?: string): JarvisConfig {
  return {
    ...DEFAULT_CONFIG,
    daemon: { ...DEFAULT_CONFIG.daemon, data_dir: dir, ...(listen ? { listen } : {}) },
    ...extra,
  } as JarvisConfig;
}

describe('hosted connection status tells a broken hosted setup from self-hosted (#1259)', () => {
  test('the table covers every hosted provider', () => {
    expect(Object.keys(STATUS).sort()).toEqual(Object.keys(HOSTED_CONNECTION_PROVIDERS).sort());
  });

  const hostedCases: Array<[string, () => JarvisConfig]> = [
    ['hosted (unix socket) with no integrations block', () => config({}, 'unix:/run/jarvis/u_1.sock')],
    ['hosted (unix socket) with no page_url', () => config({ usejarvis_integrations: {} }, 'unix:/run/jarvis/u_1.sock')],
    ['hosted with an http page_url', () => config({ usejarvis_integrations: { page_url: 'http://app.example/account' } }, 'unix:/run/jarvis/u_1.sock')],
    ['hosted with an unparseable page_url', () => config({ usejarvis_integrations: { page_url: 'not a url' } }, 'unix:/run/jarvis/u_1.sock')],
    ['an integrations block with credentials in page_url', () => config({ usejarvis_integrations: { page_url: 'https://u:p@app.example/account' } })],
  ];
  for (const [label, make] of hostedCases) {
    for (const provider of Object.keys(STATUS) as HostedConnectionProvider[]) {
      test(`${label}: ${provider} names the fault`, () => {
        const status = STATUS[provider](make());
        expect(status).toMatchObject({ configured: false, connect_url: null, reason: HOSTED_SETUP_UNAVAILABLE });
      });
    }
  }

  for (const provider of Object.keys(STATUS) as HostedConnectionProvider[]) {
    test(`self-hosted with an empty integrations key: ${provider} has no fault`, () => {
      const status = STATUS[provider](config({ usejarvis_integrations: null } as unknown as Partial<JarvisConfig>));
      expect('reason' in status).toBe(false);
    });

    test(`self-hosted: ${provider} has no setup path and no fault`, () => {
      const status = STATUS[provider](config());
      expect(status.configured).toBe(false);
      expect(status.connect_url).toBeNull();
      expect('reason' in status).toBe(false);
    });

    test(`hosted with a valid page_url: ${provider} links setup and has no fault`, () => {
      const status = STATUS[provider](config({ usejarvis_integrations: { page_url: 'https://app.example/account' } }, 'unix:/run/jarvis/u_1.sock'));
      expect(status.configured).toBe(true);
      expect(status.connect_url).toStartWith('https://app.example/account?integration=');
      expect('reason' in status).toBe(false);
    });
  }
});
