import { describe, expect, test } from 'bun:test';
import { resolveTelemetryEnabled } from './config.ts';

const ON = { telemetry: { enabled: true } };
const OFF = { telemetry: { enabled: false } };
const UNSET = {};

describe('resolveTelemetryEnabled', () => {
  test('enabled by default when nothing is set', () => {
    expect(resolveTelemetryEnabled(UNSET, {}).enabled).toBe(true);
    expect(resolveTelemetryEnabled(ON, {}).enabled).toBe(true);
  });

  test('config flag false disables', () => {
    const d = resolveTelemetryEnabled(OFF, {});
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('config');
  });

  test('JARVIS_TELEMETRY opt-out overrides an enabled config', () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      expect(resolveTelemetryEnabled(ON, { JARVIS_TELEMETRY: v }).enabled).toBe(false);
    }
  });

  test('JARVIS_TELEMETRY opt-in overrides a disabled config', () => {
    expect(resolveTelemetryEnabled(OFF, { JARVIS_TELEMETRY: '1' }).enabled).toBe(true);
  });

  test('DO_NOT_TRACK takes precedence over everything', () => {
    const d = resolveTelemetryEnabled(ON, { DO_NOT_TRACK: '1', JARVIS_TELEMETRY: '1' });
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain('DO_NOT_TRACK');
  });

  test('DO_NOT_TRACK=0 does not disable', () => {
    expect(resolveTelemetryEnabled(ON, { DO_NOT_TRACK: '0' }).enabled).toBe(true);
  });
});
