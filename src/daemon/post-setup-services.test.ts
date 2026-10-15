import { expect, test } from 'bun:test';
import { createPostSetupServices } from './post-setup-services.ts';

for (const { mode, enabled, noLocalTools } of [
  { mode: 'hosted with Awareness disabled', enabled: false, noLocalTools: false },
  { mode: 'headless with Awareness enabled', enabled: true, noLocalTools: true },
  { mode: 'headless with default Awareness', enabled: undefined, noLocalTools: true },
]) test(`startup becomes ready without Awareness: ${mode}`, async () => {
  let backgroundRunning = false, starts = 0;
  const services = createPostSetupServices({
    startCore: async () => {
      if (backgroundRunning) return;
      starts++;
      backgroundRunning = true;
    },
    coreRunning: () => backgroundRunning,
    noLocalTools,
    awareness: {
      enabled: () => enabled,
      start: async () => { throw new Error('Awareness must be skipped'); },
      running: () => false,
    },
  });
  expect(services.readiness()).toBe('stopped');
  await services.start();
  expect(services.readiness()).toBe('running');
  await services.start();
  expect(services.readiness()).toBe('running');
  expect(starts).toBe(1);
});

for (const enabled of [true, undefined]) test(`required Awareness waits for startup and reports later failure (enabled: ${enabled})`, async () => {
  let backgroundRunning = false, awarenessRunning = false;
  const core = Promise.withResolvers<void>(), awareness = Promise.withResolvers<void>();
  const services = createPostSetupServices({
    startCore: async () => { await core.promise; backgroundRunning = true; },
    coreRunning: () => backgroundRunning,
    awareness: {
      enabled: () => enabled,
      start: async () => { await awareness.promise; awarenessRunning = true; },
      running: () => awarenessRunning,
    },
  });
  const first = services.start();
  expect(services.start()).toBe(first);
  expect(services.readiness()).toBe('stopped');
  core.resolve();
  await core.promise;
  expect(backgroundRunning).toBe(true);
  expect(services.readiness()).toBe('stopped');
  awareness.resolve();
  await first;
  expect(services.readiness()).toBe('running');
  awarenessRunning = false;
  expect(services.readiness()).toBe('unavailable');
  backgroundRunning = false;
  expect(services.readiness()).toBe('stopped');
});

for (const failingStage of ['core', 'awareness']) test(`failed ${failingStage} startup stays unready and allows retry`, async () => {
  let fail = true, backgroundRunning = false, awarenessRunning = false;
  const services = createPostSetupServices({
    startCore: async () => {
      if (fail && failingStage === 'core') throw new Error('core startup failed');
      backgroundRunning = true;
    },
    coreRunning: () => backgroundRunning,
    awareness: {
      enabled: () => true,
      start: async () => {
        if (fail && failingStage === 'awareness') throw new Error('awareness startup failed');
        awarenessRunning = true;
      },
      running: () => awarenessRunning,
    },
  });
  await expect(services.start()).rejects.toThrow(`${failingStage} startup failed`);
  expect(services.readiness()).toBe('stopped');
  fail = false;
  await services.start();
  expect(services.readiness()).toBe('running');
});

test('nonfatal Awareness failure remains unavailable until disabled or running', async () => {
  let enabled = true, running = false;
  const services = createPostSetupServices({
    startCore: async () => {},
    coreRunning: () => true,
    awareness: { enabled: () => enabled, start: async () => {}, running: () => running },
  });
  await services.start();
  expect(services.readiness()).toBe('unavailable');
  enabled = false;
  expect(services.readiness()).toBe('running');
  enabled = true;
  expect(services.readiness()).toBe('unavailable');
  running = true;
  expect(services.readiness()).toBe('running');
});
