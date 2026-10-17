import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSession } from './session.ts';
import { createTransport } from './transport.ts';
import { fixture } from './test-fixture.ts';

// Optional test-only discovery keeps the UI assembly testable without B11.
// Production never discovers or imports a server module from the browser.
const runtimePath = resolve(import.meta.dir, '../../../../src/onboarding-next/runtime');
test.skipIf(!existsSync(resolve(runtimePath, 'runtime.ts')))('U10 consumes the real B11 HTTP envelope; disabled or incomplete runtime never initializes a journey', async () => {
  const { createOnboardingRuntime } = await import(resolve(runtimePath, 'runtime.ts'));
  const { createOnboardingRoutes } = await import(resolve(runtimePath, 'routes.ts'));
  const { fixtureOptions } = await import(resolve(runtimePath, 'test-fixture.ts'));
  for (const mode of ['disabled', 'empty', 'ready']) {
    const f = fixture(), options = fixtureOptions();
    options.installMode = () => 'hosted';
    if (mode === 'disabled') options.enabled = false;
    if (mode === 'empty') options.modules = [];
    for (const [capability, operations] of [['journey.v1', ['journey.read', 'journey.transition']], ['setup.v1', ['setup.read', 'setup.complete']]] as const) {
      options.bindings[capability] = () => ({ probe: () => ({ ready: true, reason: 'ready' }), operations: Object.fromEntries(operations.map(op => [op,
        (input: Record<string, unknown>) => f.config.transport.call(op, input, new AbortController().signal),
      ])) });
    }
    const routes = createOnboardingRoutes(createOnboardingRuntime(options));
    const transport = createTransport(async (path, init) => {
      const request = new Request('http://fixture.invalid' + path, init);
      return routes[path][request.method](request);
    });
    const session = createSession({ ...f.config, transport }); await session.start();
    if (mode === 'ready') {
      expect(session.state().view).toBe('welcome');
      await session.act(session.key(), 'continue'); expect(session.state().view).toBe('explainer');
      await session.act(session.key(), 'continue'); expect(session.state().view).toBe('google');
    } else {
      expect(session.state().mode).toBe('legacy'); expect(f.calls).not.toContain('journey.read');
    }
    session.dispose();
  }
});
